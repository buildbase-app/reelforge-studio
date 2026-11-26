/**
 * Real-render load driver (issues #307, #151; docs/runbooks/SCALE-TEST.md): drives a deployed studio over
 * its public REST API with real renders, the way many agents would, and writes what it saw.
 *
 *   closed  (default) keep N renders in flight (queued or running) per step of LOAD_STEPS, each one
 *           submitted (idempotency key, Retry-After honoured), long-polled to the end, then replaced;
 *           LOAD_STEPS=50:600,100:600 is 50 in flight for 600 s, then 100 for 600 s, then a drain
 *   enqueue submit LOAD_ENQUEUE_TOTAL renders as fast as LOAD_ENQUEUE_PARALLEL requests allow and stop
 *           (queue depth through the api tier; fake-engine workers drain them, scripts/load/queue-worker.ts)
 *
 * Projects come from a template mix over sizes (LOAD_MIX) and engines (LOAD_ENGINES), checked with the
 * project schema before anything is sent. Every LOAD_VERIFY_EVERY-th successful render is downloaded and
 * checked with ffprobe (size and duration).
 *
 *   LOAD_DRY_RUN=1 pnpm load:real        # no network: validates the manifests and runs the loop against an
 *                                        # in-memory fake server with time scaled by LOAD_DRY_TIME_SCALE
 *   LOAD_URL=https://studio.example LOAD_KEYS_FILE=keys.txt pnpm load:real
 *
 * Results: LOAD_OUT/<stamp>-real/ jobs.jsonl (one line per render, written as it ends), ids.json and
 * since.txt (for scripts/load/check.ts), summary.json and summary.md. Exit 1 when a gate fails.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProject } from '@renderweld/project-schema';
import { env, envNum, round, sleep, summary } from './lib';

export interface Profile { width: number; height: number; seconds: number }
export const PROFILES: Record<string, Profile> = {
  'v1080-30s': { width: 1080, height: 1920, seconds: 30 },
  'h1080-60s': { width: 1920, height: 1080, seconds: 60 },
  'uhd-15s': { width: 3840, height: 2160, seconds: 15 },
};
const TEMPLATE: Record<string, string> = { html: 'html-title', hyperframes: 'hyperframes-title', remotion: 'kinetic-title' };
const SCENE_SECONDS = 5; // every built-in template allows 5 s (kinetic-title 1.5-8, the others 1-12)
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export function config(e: NodeJS.ProcessEnv = process.env) {
  const get = (n: string, d: string) => (e[n] === undefined || e[n] === '' ? d : e[n]!);
  const weights = (s: string) => s.split(',').map((x) => [x.split(':')[0]!, Number(x.split(':')[1] ?? 1)] as [string, number]);
  return {
    dryRun: get('LOAD_DRY_RUN', '0') === '1',
    url: get('LOAD_URL', 'http://127.0.0.1:4321').replace(/\/$/, ''),
    keysFile: get('LOAD_KEYS_FILE', ''),
    mode: get('LOAD_MODE', 'closed') as 'closed' | 'enqueue',
    steps: get('LOAD_STEPS', '50:600,100:600,250:600,500:900,1000:900').split(',').map((s) => ({ inFlight: Number(s.split(':')[0]), seconds: Number(s.split(':')[1]) })),
    mix: weights(get('LOAD_MIX', 'v1080-30s:0.6,h1080-60s:0.3,uhd-15s:0.1')),
    engines: weights(get('LOAD_ENGINES', 'html:0.5,hyperframes:0.25,remotion:0.25')),
    projectsPerProfile: Number(get('LOAD_PROJECTS_PER_PROFILE', '20')),
    priority: get('LOAD_PRIORITY', ''),
    enqueueTotal: Number(get('LOAD_ENQUEUE_TOTAL', '5000')),
    enqueueParallel: Number(get('LOAD_ENQUEUE_PARALLEL', '64')),
    jobTimeoutSeconds: Number(get('LOAD_JOB_TIMEOUT_SECONDS', '1800')),
    drainSeconds: Number(get('LOAD_DRAIN_SECONDS', '1800')),
    verifyEvery: Number(get('LOAD_VERIFY_EVERY', '100')),
    maxErrorRate: Number(get('LOAD_MAX_ERROR_RATE', '0.001')),
    maxQueueWaitP95: Number(get('LOAD_MAX_QUEUE_WAIT_P95_SECONDS', '300')),
    seed: Number(get('LOAD_SEED', '307')),
    out: resolve(import.meta.dirname, '../..', get('LOAD_OUT', 'out/load')),
    label: get('LOAD_LABEL', ''),
    dry: { timeScale: Number(get('LOAD_DRY_TIME_SCALE', '0.005')), slots: Number(get('LOAD_DRY_SLOTS', '400')), renderMs: Number(get('LOAD_DRY_RENDER_MS', '40')), refuseRate: Number(get('LOAD_DRY_503_RATE', '0.05')) },
  };
}
export type Config = ReturnType<typeof config>;

/** Deterministic random numbers (mulberry32), so a mix is the same from run to run. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pickWeighted = (w: [string, number][], r: number) => {
  const total = w.reduce((s, [, x]) => s + x, 0);
  let acc = 0;
  for (const [k, x] of w) if (r * total < (acc += x)) return k;
  return w[w.length - 1]![0];
};

/** A v0.2 manifest of `profile` whose scenes take their engines from the engine mix. */
export function buildManifest(projectId: string, profileId: string, engines: [string, number][], next: () => number) {
  const p = PROFILES[profileId];
  if (!p) throw new Error(`unknown profile ${profileId} (known: ${Object.keys(PROFILES).join(', ')})`);
  const scenes = Array.from({ length: Math.round(p.seconds / SCENE_SECONDS) }, (_, i) => {
    const engine = pickWeighted(engines, next());
    const headline = `Load scene ${i + 1} of ${projectId}`.slice(0, 60);
    const props: Record<string, string> = { headline, subline: `${p.width}x${p.height}, ${engine}` };
    if (engine === 'html') props.kicker = `STEP ${i + 1}`;
    return { id: `s${i + 1}`, engine, template: TEMPLATE[engine], durationSeconds: SCENE_SECONDS, props };
  });
  return { schemaVersion: '0.2', projectId, title: `Load ${profileId} ${projectId}`, output: { width: p.width, height: p.height, fps: 30, format: 'mp4' }, scenes };
}

// ---- transport ----------------------------------------------------------------

export interface Reply { status: number; json: Record<string, any>; retryAfter: number | null }
export interface Transport {
  call(key: string, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>;
  /** Downloads a render and returns its width, height and duration (ffprobe). */
  probe(url: string): Promise<{ width: number; height: number; seconds: number } | null>;
}

export function httpTransport(base: string): Transport {
  return {
    async call(key, method, path, body, headers = {}) {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      const text = await r.text();
      let json: Record<string, any> = {};
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON
      }
      const ra = r.headers.get('retry-after');
      return { status: r.status, json, retryAfter: ra === null ? null : Number(ra) };
    },
    async probe(url) {
      const file = join(tmpdir(), `rf-real-${randomUUID()}.mp4`);
      try {
        const r = await fetch(url.startsWith('http') ? url : `${base}${url}`, { signal: AbortSignal.timeout(300_000) });
        if (!r.ok) return null;
        writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        const p = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' });
        const j = JSON.parse(p.stdout || '{}');
        return { width: j.streams?.[0]?.width ?? 0, height: j.streams?.[0]?.height ?? 0, seconds: Number(j.format?.duration ?? 0) };
      } finally {
        rmSync(file, { force: true });
      }
    },
  };
}

/** An in-memory stand-in for the server (dry run): a queue with `slots` render slots, some 503s with Retry-After. */
export function fakeTransport(d: Config['dry'], next: () => number): Transport {
  const projects = new Map<string, Profile>();
  const jobs = new Map<string, Record<string, any>>();
  const idem = new Map<string, string>();
  const waiting: string[] = [];
  let running = 0;
  const startNext = () => {
    while (running < d.slots && waiting.length) {
      const j = jobs.get(waiting.shift()!)!;
      running++;
      j.status = 'running';
      j.startedAt = new Date().toISOString();
      j.attempts = 1;
      setTimeout(() => {
        j.status = 'succeeded';
        j.finishedAt = new Date().toISOString();
        j.result = { renderId: `r-${j.id}` };
        running--;
        startNext();
      }, d.renderMs * (projects.get(j.projectId)!.seconds / 30));
    }
  };
  return {
    async call(_key, method, path, body, headers = {}) {
      const ok = (status: number, json: Record<string, any>): Reply => ({ status, json, retryAfter: null });
      if (method === 'POST' && path === '/v1/projects') {
        const m = (body as { manifest: { projectId: string; output: { width: number; height: number } ; scenes: unknown[] } }).manifest;
        projects.set(m.projectId, { width: m.output.width, height: m.output.height, seconds: m.scenes.length * SCENE_SECONDS });
        return ok(201, { projectId: m.projectId });
      }
      const render = path.match(/^\/v1\/projects\/([^/]+)\/renders$/);
      if (method === 'POST' && render) {
        if (next() < d.refuseRate) return { status: 503, json: { error: { code: 'overloaded' } }, retryAfter: 0 };
        const k = headers['idempotency-key']!;
        let id = idem.get(k);
        if (!id) {
          id = `job_${randomUUID()}`;
          idem.set(k, id);
          jobs.set(id, { id, type: 'render', status: 'queued', projectId: render[1], createdAt: new Date().toISOString() });
          waiting.push(id);
          startNext();
        }
        return ok(202, { job: { ...jobs.get(id) } });
      }
      const job = path.match(/^\/v1\/jobs\/([^/?]+)/);
      if (method === 'GET' && job) {
        const j = jobs.get(job[1]!);
        if (!j) return ok(404, { error: { code: 'not_found' } });
        for (let i = 0; i < 50 && !TERMINAL.has(j.status); i++) await sleep(5);
        return ok(200, { ...j });
      }
      const out = path.match(/^\/v1\/renders\/r-(.+)$/);
      if (method === 'GET' && out) return ok(200, { downloadUrl: `fake://${out[1]}` });
      return ok(404, { error: { code: 'not_found' } });
    },
    async probe(url) {
      const j = jobs.get(url.replace('fake://', ''));
      const p = j && projects.get(j.projectId);
      return p ? { width: p.width, height: p.height, seconds: p.seconds } : null;
    },
  };
}

// ---- the run ------------------------------------------------------------------

export interface JobLine {
  step: number; profile: string; engines: string[]; id: string | null; status: string; error: string | null;
  submitMs: number; submitTries: number; refusals: Record<string, number>; attempts: number | null;
  queueWaitS: number | null; renderS: number | null; totalS: number; verified: string | null;
}

export async function run(cfg: Config, t: Transport, keys: string[], log: (s: string) => void = console.log) {
  const next = rng(cfg.seed);
  const runId = `lr${Date.now().toString(36)}`;
  // Projects: LOAD_PROJECTS_PER_PROFILE per size, each with its own engine mix, validated first.
  const pool: Record<string, Array<{ id: string; engines: string[] }>> = {};
  const usedProfiles = cfg.mix.map(([p]) => p);
  for (const profile of usedProfiles) {
    pool[profile] = [];
    for (let i = 0; i < cfg.projectsPerProfile; i++) {
      const id = `${runId}-${profile}-${i}`.toLowerCase();
      const manifest = buildManifest(id, profile, cfg.engines, next);
      const v = parseProject(manifest);
      if (!v.ok) throw new Error(`manifest ${id} is invalid: ${JSON.stringify(v.issues)}`);
      const r = await t.call(keys[i % keys.length]!, 'POST', '/v1/projects', { manifest });
      if (r.status !== 201) throw new Error(`create project ${id}: ${r.status} ${JSON.stringify(r.json)}`);
      pool[profile]!.push({ id, engines: manifest.scenes.map((s) => s.engine) });
    }
  }
  log(`${usedProfiles.length} sizes x ${cfg.projectsPerProfile} projects created and valid (${runId})`);

  const dir = join(cfg.out, `${new Date().toISOString().replace(/[:.]/g, '-')}-real${cfg.label ? `-${cfg.label}` : ''}`);
  mkdirSync(dir, { recursive: true });
  const since = new Date().toISOString();
  writeFileSync(join(dir, 'since.txt'), `${since}\n`);
  const lines: JobLine[] = [];
  let seq = 0;
  let verifyCount = 0;

  const one = async (step: number, submitOnly: boolean): Promise<void> => {
    const n = seq++;
    const profile = pickWeighted(cfg.mix, next());
    const proj = pool[profile]![n % pool[profile]!.length]!;
    const key = keys[n % keys.length]!;
    const idem = randomUUID();
    const t0 = Date.now();
    const line: JobLine = { step, profile, engines: proj.engines, id: null, status: 'refused', error: null, submitMs: 0, submitTries: 0, refusals: {}, attempts: null, queueWaitS: null, renderS: null, totalS: 0, verified: null };
    for (let tries = 0; tries < 8 && !line.id; tries++) {
      line.submitTries++;
      try {
        const r = await t.call(key, 'POST', `/v1/projects/${proj.id}/renders`, cfg.priority ? { priority: cfg.priority } : {}, { 'idempotency-key': idem });
        if (r.status === 202) line.id = r.json.job.id as string;
        else {
          line.refusals[r.status] = (line.refusals[r.status] ?? 0) + 1;
          line.error = r.json.error?.code ?? `http_${r.status}`;
          if (r.status !== 429 && r.status < 500) break; // a 4xx other than 429 will not change on retry
          await sleep(Math.min(30, r.retryAfter ?? 1) * 1000);
        }
      } catch (e) {
        line.refusals.network = (line.refusals.network ?? 0) + 1;
        line.error = `network: ${(e as Error).message}`;
        await sleep(1000);
      }
    }
    line.submitMs = Date.now() - t0;
    if (line.id) {
      line.status = 'accepted';
      line.error = null;
    }
    if (line.id && !submitOnly) {
      const deadline = t0 + cfg.jobTimeoutSeconds * 1000;
      let job: Record<string, any> = {};
      while (Date.now() < deadline) {
        try {
          const r = await t.call(key, 'GET', `/v1/jobs/${line.id}?wait=50`);
          if (r.status === 200) job = r.json;
          if (TERMINAL.has(job.status)) break;
          if (r.status !== 200) await sleep(1000);
        } catch {
          await sleep(1000);
        }
      }
      line.status = TERMINAL.has(job.status) ? job.status : 'client_timeout';
      line.error = job.error?.code ?? null;
      line.attempts = job.attempts ?? null;
      if (job.startedAt) line.queueWaitS = round((Date.parse(job.startedAt) - Date.parse(job.createdAt)) / 1000, 2);
      if (job.startedAt && job.finishedAt) line.renderS = round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000, 2);
      if (job.status === 'succeeded' && cfg.verifyEvery > 0 && verifyCount++ % cfg.verifyEvery === 0) {
        const p = PROFILES[profile]!;
        const o = await t.call(key, 'GET', `/v1/renders/${job.result?.renderId}`).catch(() => null);
        const got = o?.json.downloadUrl ? await t.probe(o.json.downloadUrl as string).catch(() => null) : null;
        line.verified = !got ? 'download_failed' : got.width === p.width && got.height === p.height && Math.abs(got.seconds - p.seconds) <= 0.1 ? 'ok' : `mismatch ${got.width}x${got.height} ${got.seconds}s`;
      }
    }
    line.totalS = round((Date.now() - t0) / 1000, 2);
    lines.push(line);
    appendFileSync(join(dir, 'jobs.jsonl'), `${JSON.stringify(line)}\n`);
  };

  const scale = cfg.dryRun ? cfg.dry.timeScale : 1;
  if (cfg.mode === 'enqueue') {
    let left = cfg.enqueueTotal;
    await Promise.all(Array.from({ length: cfg.enqueueParallel }, async () => {
      while (left-- > 0) await one(0, true);
    }));
  } else {
    let target = 0;
    let current = 0;
    let stop = false;
    const slots: Promise<void>[] = [];
    const slot = async (i: number) => {
      while (!stop && i < target) await one(current, false);
    };
    for (const [i, s] of cfg.steps.entries()) {
      current = i;
      const from = target;
      target = s.inFlight;
      log(`step ${i}: ${s.inFlight} renders in flight for ${s.seconds} s`);
      for (let k = from; k < target; k++) slots.push(slot(k));
      await sleep(s.seconds * 1000 * scale);
    }
    stop = true;
    log(`draining up to ${cfg.drainSeconds} s`);
    await Promise.race([Promise.all(slots), sleep(cfg.drainSeconds * 1000 * scale)]);
  }

  const ids = lines.filter((l) => l.id).map((l) => l.id!);
  writeFileSync(join(dir, 'ids.json'), JSON.stringify(ids));
  const report = summarise(cfg, lines);
  if (new Set(ids).size !== ids.length) report.gates.push({ gate: 'one job id per render request', ok: false, value: ids.length - new Set(ids).size });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ config: { ...cfg, keysFile: cfg.keysFile ? '(set)' : '' }, since, ...report }, null, 2));
  writeFileSync(join(dir, 'summary.md'), markdown(cfg, report));
  log(`results in ${dir}`);
  return { dir, lines, ids, report };
}

export function summarise(cfg: Config, lines: JobLine[]) {
  const group = (ls: JobLine[]) => {
    const done = ls.filter((l) => l.status !== 'accepted');
    const bad = ls.filter((l) => ['refused', 'failed', 'client_timeout', 'cancelled'].includes(l.status));
    const errors: Record<string, number> = {};
    for (const l of bad) errors[`${l.status}:${l.error ?? ''}`] = (errors[`${l.status}:${l.error ?? ''}`] ?? 0) + 1;
    const refusals: Record<string, number> = {};
    for (const l of ls) for (const [k, v] of Object.entries(l.refusals)) refusals[k] = (refusals[k] ?? 0) + v;
    const s = (v: Array<number | null>) => summary(v.filter((x): x is number => x !== null));
    return {
      submitted: ls.length, accepted: ls.filter((l) => l.id).length, finished: done.length,
      succeeded: ls.filter((l) => l.status === 'succeeded').length, errorRate: ls.length ? round(bad.length / ls.length, 5) : 0, errors, refusals,
      reclaimed: ls.filter((l) => (l.attempts ?? 1) > 1).length,
      queueWaitS: s(ls.map((l) => l.queueWaitS)), renderS: s(ls.map((l) => l.renderS)), submitMs: s(ls.map((l) => l.submitMs)),
      verified: { ok: ls.filter((l) => l.verified === 'ok').length, bad: ls.filter((l) => l.verified && l.verified !== 'ok').length },
    };
  };
  const steps = cfg.mode === 'enqueue' ? [{ step: 0, inFlight: cfg.enqueueParallel, ...group(lines) }] : cfg.steps.map((s, i) => ({ step: i, inFlight: s.inFlight, ...group(lines.filter((l) => l.step === i)) }));
  const byProfile = Object.fromEntries(cfg.mix.map(([p]) => [p, group(lines.filter((l) => l.profile === p))]));
  const all = group(lines);
  const gates = [
    { gate: `error rate < ${cfg.maxErrorRate}`, ok: all.errorRate < cfg.maxErrorRate, value: all.errorRate },
    ...(cfg.mode === 'closed' ? [{ gate: `queue wait p95 <= ${cfg.maxQueueWaitP95} s`, ok: all.queueWaitS.p95 <= cfg.maxQueueWaitP95, value: all.queueWaitS.p95 }] : []),
    { gate: 'every verified output has the right size and duration', ok: all.verified.bad === 0, value: all.verified.bad },
  ];
  return { all, steps, byProfile, gates };
}

function markdown(cfg: Config, r: ReturnType<typeof summarise>) {
  const row = (name: string, g: ReturnType<typeof summarise>['all']) =>
    `| ${name} | ${g.submitted} | ${g.succeeded} | ${g.errorRate} | ${g.queueWaitS.p50} / ${g.queueWaitS.p95} / ${g.queueWaitS.p99} | ${g.renderS.p50} / ${g.renderS.p95} | ${g.submitMs.p95} | ${g.reclaimed} | ${JSON.stringify(g.refusals)} | ${JSON.stringify(g.errors)} |`;
  const head = '| Part | Submitted | Succeeded | Error rate | Queue wait p50 / p95 / p99 s | Render p50 / p95 s | Submit p95 ms | Reclaimed | Refusals (retried) | Errors |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  return [
    `# Real-render load run${cfg.dryRun ? ' (DRY RUN: fake server, not a measurement)' : ''}`, '',
    `Target ${cfg.dryRun ? '(fake)' : cfg.url}, mode ${cfg.mode}, mix ${cfg.mix.map((m) => m.join(':')).join(', ')}, engines ${cfg.engines.map((m) => m.join(':')).join(', ')}.`, '',
    head, ...r.steps.map((s) => row(`step ${s.step} (${s.inFlight} in flight)`, s)), ...Object.entries(r.byProfile).map(([p, g]) => row(p, g)), row('all', r.all), '',
    '| Gate | Result | Value |', '| --- | --- | --- |', ...r.gates.map((g) => `| ${g.gate} | ${g.ok ? 'pass' : '**FAIL**'} | ${g.value} |`), '',
    'Exactly once and lost jobs: run scripts/load/check.ts with ids.json (docs/runbooks/SCALE-TEST.md).', '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = config();
  const next = rng(cfg.seed + 1);
  let keys: string[];
  if (cfg.dryRun) keys = ['rf_dry_run_key'];
  else {
    if (!cfg.keysFile) throw new Error('set LOAD_KEYS_FILE (one API key with the render scope per line), or LOAD_DRY_RUN=1');
    keys = readFileSync(cfg.keysFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  }
  const t = cfg.dryRun ? fakeTransport(cfg.dry, next) : httpTransport(cfg.url);
  const stamp = () => `[real ${new Date().toISOString().slice(11, 19)}]`;
  const { report } = await run(cfg, t, keys, (s) => console.log(`${stamp()} ${s}`));
  for (const g of report.gates) console.log(`${stamp()} gate: ${g.gate}: ${g.ok ? 'pass' : 'FAIL'} (${g.value})`);
  process.exit(report.gates.every((g) => g.ok) ? 0 : 1);
}
