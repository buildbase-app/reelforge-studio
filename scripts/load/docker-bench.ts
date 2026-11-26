/**
 * Docker sizing benchmark (#151): what one studio container does with a fixed CPU and memory allowance.
 *
 * For each size in BENCH_SIZES (vCPUs:GiB), it starts the release image with `--cpus` and `--memory`
 * (no swap), sets `limits.renderConcurrency` to K and renders K × BENCH_RENDERS_PER_SLOT real videos
 * with K in flight, for K = 1, 2, 3 ... It stops raising K when a render fails, the container hits its
 * memory limit (an OOM kill), or throughput rises by less than BENCH_MIN_GAIN. Each point gets a fresh
 * container and volume. Then it measures the API alone on the same size (authenticated reads, no renders).
 *
 * Recorded per point: renders finished and failed, wall time, throughput (renders an hour), seconds of
 * video per vCPU-second, time per render (mean and p95), peak memory and OOM kills (from the container's
 * cgroup), peak disk under /data and /tmp. The recommended setting for a size is the K with the best
 * throughput and no failure.
 *
 *   docker build --build-arg REELFORGE_EDITION=dev -t renderweld:bench-dev .   # licence settings not fixed
 *   pnpm bench:docker                                      # 1:2,2:4,4:8 with 30 s 1080x1920 videos
 *   BENCH_SIZES=2:4 BENCH_WORKLOAD=h1080-60s pnpm bench:docker
 *   BENCH_SIZES=4:8 BENCH_CONCURRENCY=3 pnpm bench:docker  # one setting, no sweep
 *   BENCH_DRY_RUN=1 pnpm bench:docker                      # prints the docker commands, runs nothing
 *   BENCH_NOTE="Shared sandbox." pnpm bench:docker         # a line printed under the table
 *
 * Results: BENCH_OUT/<stamp>-docker/ points.jsonl (one line per point, written as it ends),
 * summary.json and summary.md (the table in docs/BENCHMARKS.md). Numbers depend on the CPU model:
 * the host fingerprint is in the summary, and the same script reproduces them on any machine.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostFingerprint, round, sleep, summary } from './lib';
import { buildManifest, httpTransport, PROFILES, rng, type Transport } from './real-render';

export interface Size { cpus: number; memGiB: number }
export interface Point {
  size: Size;
  workload: string;
  concurrency: number;
  ok: number;
  failed: number;
  errors: string[];
  wallSeconds: number;
  rendersPerHour: number;
  videoSecondsPerCpuSecond: number;
  renderSeconds: { mean: number; p95: number };
  peakMemMiB: number | null;
  oomKills: number | null;
  cpuSeconds: number | null;
  peakDiskMiB: number | null;
}
export interface ApiPoint { size: Size; requests: number; errors: number; seconds: number; perSecond: number; p95Ms: number }

export function config(e: NodeJS.ProcessEnv = process.env) {
  const get = (n: string, d: string) => (e[n] === undefined || e[n] === '' ? d : e[n]!);
  return {
    dryRun: get('BENCH_DRY_RUN', '0') === '1',
    image: get('BENCH_IMAGE', 'renderweld:bench-dev'),
    sizes: parseSizes(get('BENCH_SIZES', '1:2,2:4,4:8')),
    workload: get('BENCH_WORKLOAD', 'v1080-30s'),
    engine: get('BENCH_ENGINE', 'html'),
    rendersPerSlot: Number(get('BENCH_RENDERS_PER_SLOT', '2')),
    maxConcurrency: Number(get('BENCH_MAX_CONCURRENCY', '0')), // 0: twice the vCPUs, at least 2
    // Measure only these renders-at-once values (no sweep), e.g. "2" or "1,3".
    concurrency: get('BENCH_CONCURRENCY', '').split(',').filter(Boolean).map(Number),
    minGain: Number(get('BENCH_MIN_GAIN', '0.05')),
    port: Number(get('BENCH_PORT', '4390')),
    shm: get('BENCH_SHM', '1g'),
    // As docs/public/install/docker.md runs it: Chrome's own sandbox under the seccomp profile that allows it.
    dockerArgs: get('BENCH_DOCKER_ARGS', '--security-opt seccomp=deployment/seccomp/chrome.json').split(' ').filter(Boolean),
    // Extra REELFORGE_* settings, KEY=VALUE,KEY=VALUE (REELFORGE_CHROMIUM_NO_SANDBOX=1 where the host blocks user namespaces).
    env: Object.fromEntries(get('BENCH_ENV', '').split(',').filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])),
    apiSeconds: Number(get('BENCH_API_SECONDS', '20')),
    apiParallel: Number(get('BENCH_API_PARALLEL', '32')),
    jobTimeoutSeconds: Number(get('BENCH_JOB_TIMEOUT_SECONDS', '1800')),
    out: resolve(import.meta.dirname, '../..', get('BENCH_OUT', 'out/bench')),
    // Free text printed under the table, e.g. how the image was built or what else ran on the host.
    note: get('BENCH_NOTE', ''),
  };
}
export type Config = ReturnType<typeof config>;

/** "1:2,2:4" → [{cpus:1,memGiB:2},{cpus:2,memGiB:4}]; throws on anything else. */
export function parseSizes(s: string): Size[] {
  return s.split(',').map((part) => {
    const [c, m] = part.trim().split(':').map(Number);
    if (!(c! > 0) || !(m! > 0)) throw new Error(`BENCH_SIZES: "${part}" is not vCPUs:GiB (for example 2:4)`);
    return { cpus: c!, memGiB: m! };
  });
}

/**
 * Whether to try K + 1 after measuring K: not after a failure or an OOM kill, not past the cap, and not
 * when K gained less than `minGain` over K - 1 (more renders only slow each one down).
 */
export function shouldContinue(points: Pick<Point, 'concurrency' | 'failed' | 'oomKills' | 'rendersPerHour'>[], cap: number, minGain: number): boolean {
  const last = points.at(-1);
  if (!last) return true;
  if (last.failed > 0 || (last.oomKills ?? 0) > 0) return false;
  if (last.concurrency >= cap) return false;
  const prev = points.at(-2);
  if (prev && last.rendersPerHour < prev.rendersPerHour * (1 + minGain)) return false;
  return true;
}

/** The recommended point for a size: the best throughput among points with no failure and no OOM kill. */
export function best<P extends Pick<Point, 'failed' | 'oomKills' | 'rendersPerHour'>>(points: P[]): P | null {
  const clean = points.filter((p) => p.failed === 0 && (p.oomKills ?? 0) === 0);
  return clean.reduce<P | null>((a, p) => (!a || p.rendersPerHour > a.rendersPerHour ? p : a), null);
}

// ---- the container ----------------------------------------------------------------------------------

function docker(args: string[], allowFail = false): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) throw new Error(`docker ${args.slice(0, 2).join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return (r.stdout ?? '').trim();
}

/** The cgroup files of a container: v1 (memory/, cpuacct/) or v2 (one unified folder). */
export function cgroupFiles(id: string, root = '/sys/fs/cgroup') {
  const v1 = { peak: `${root}/memory/docker/${id}/memory.max_usage_in_bytes`, oom: `${root}/memory/docker/${id}/memory.oom_control`, cpu: `${root}/cpuacct/docker/${id}/cpuacct.usage` };
  if (existsSync(v1.peak)) return { version: 1 as const, ...v1 };
  for (const dir of [`${root}/system.slice/docker-${id}.scope`, `${root}/docker/${id}`]) {
    if (existsSync(`${dir}/memory.max`)) return { version: 2 as const, peak: `${dir}/memory.peak`, oom: `${dir}/memory.events`, cpu: `${dir}/cpu.stat` };
  }
  return null;
}

/** Peak memory (MiB), OOM kills and CPU seconds of a running container, or nulls when the cgroup is not readable. */
export function readCgroup(files: ReturnType<typeof cgroupFiles>) {
  const read = (f: string) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  };
  if (!files) return { peakMemMiB: null, oomKills: null, cpuSeconds: null };
  const peak = read(files.peak);
  const oom = read(files.oom);
  const cpu = read(files.cpu);
  const oomKills = oom === null ? null : Number(/oom_kill (\d+)/.exec(oom)?.[1] ?? 0);
  const cpuSeconds = cpu === null ? null : files.version === 1 ? Number(cpu.trim()) / 1e9 : Number(/usage_usec (\d+)/.exec(cpu)?.[1] ?? 0) / 1e6;
  return { peakMemMiB: peak === null ? null : round(Number(peak.trim()) / 1024 ** 2, 0), oomKills, cpuSeconds: cpuSeconds === null ? null : round(cpuSeconds, 1) };
}

interface Started { name: string; id: string; volume: string; url: string; key: string }

function start(cfg: Config, size: Size, concurrency: number, extraEnv: Record<string, string> = {}): Started {
  const tag = randomBytes(4).toString('hex');
  const name = `rwbench-${tag}`;
  const volume = `rwbench-${tag}`;
  const key = `rf_${randomBytes(24).toString('hex')}`;
  const envs: Record<string, string> = {
    REELFORGE_HOST: '127.0.0.1',
    REELFORGE_PORT: String(cfg.port),
    REELFORGE_BOOTSTRAP_KEY: key,
    REELFORGE_SECRET_KEY: randomBytes(24).toString('hex'),
    REELFORGE_LICENCE_MODE: 'off',
    REELFORGE_LOG_LEVEL: 'warn',
    REELFORGE_RENDER_CONCURRENCY: String(concurrency),
    REELFORGE_RATE_LIMIT_PER_MINUTE: '0',
    REELFORGE_PRE_AUTH_RATE_LIMIT_PER_MINUTE: '0',
    ...cfg.env,
    ...extraEnv,
  };
  const mem = `${Math.round(size.memGiB * 1024)}m`;
  const args = ['run', '-d', '--name', name, '--network', 'host', '--cpus', String(size.cpus), '--memory', mem, '--memory-swap', mem, '--shm-size', cfg.shm, ...cfg.dockerArgs, '-v', `${volume}:/data`, ...Object.entries(envs).flatMap(([k, v]) => ['-e', `${k}=${v}`]), cfg.image];
  if (cfg.dryRun) {
    console.log(`docker ${args.join(' ').replace(key, 'rf_…').replace(envs.REELFORGE_SECRET_KEY!, '…')}`);
    return { name, id: 'dry', volume, url: `http://127.0.0.1:${cfg.port}`, key };
  }
  const id = docker(args);
  return { name, id, volume, url: `http://127.0.0.1:${cfg.port}`, key };
}

function stop(s: Started, cfg: Config) {
  if (cfg.dryRun) return;
  docker(['rm', '-f', s.name], true);
  docker(['volume', 'rm', '-f', s.volume], true);
}

async function healthy(s: Started, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${s.url}/healthz`, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      // not up yet
    }
    const state = docker(['inspect', '-f', '{{.State.Status}}', s.name], true);
    if (state === 'exited' || state === 'dead') throw new Error(`container exited before it was healthy:\n${docker(['logs', '--tail', '30', s.name], true)}`);
    await sleep(500);
  }
  throw new Error('container not healthy in time');
}

/** Largest /data + /tmp seen while `running()` is true, sampled every 5 s inside the container. */
async function sampleDisk(s: Started, running: () => boolean): Promise<number | null> {
  let peak: number | null = null;
  while (running()) {
    const out = docker(['exec', s.name, 'sh', '-c', 'du -sxk /data /tmp 2>/dev/null | awk \'{s+=$1} END {print s}\''], true);
    const kib = Number(out);
    if (Number.isFinite(kib) && kib > 0) peak = Math.max(peak ?? 0, round(kib / 1024, 0));
    await sleep(5000);
  }
  return peak;
}

// ---- one point ----------------------------------------------------------------------------------------

async function renderPoint(cfg: Config, t: Transport, s: Started, size: Size, concurrency: number): Promise<Point> {
  const total = concurrency * cfg.rendersPerSlot;
  const next = rng(151 + concurrency);
  const ids: string[] = [];
  for (let i = 0; i < total; i++) {
    const projectId = `bench-${concurrency}-${i}`;
    const r = await t.call(s.key, 'POST', '/v1/projects', { manifest: buildManifest(projectId, cfg.workload, [[cfg.engine, 1]], next) });
    if (r.status !== 201) throw new Error(`create project: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
    ids.push(projectId);
  }
  const errors: string[] = [];
  const times: number[] = [];
  let ok = 0;
  let failed = 0;
  let running = true;
  const files = cgroupFiles(s.id);
  const cpuBefore = readCgroup(files).cpuSeconds;
  const disk = sampleDisk(s, () => running);
  const t0 = Date.now();
  const queue = [...ids];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const started = Date.now();
      const sub = await t.call(s.key, 'POST', `/v1/projects/${p}/renders`, {}, { 'idempotency-key': `bench-${p}` });
      const jobId = sub.json.job?.id as string | undefined;
      if (!jobId) {
        failed++;
        errors.push(`submit ${sub.status}`);
        continue;
      }
      let status = '';
      let job: Record<string, any> = {};
      while (Date.now() - started < cfg.jobTimeoutSeconds * 1000) {
        const r = await t.call(s.key, 'GET', `/v1/jobs/${jobId}?wait=30`);
        job = r.json;
        status = String(job.status ?? '');
        if (['succeeded', 'failed', 'cancelled'].includes(status)) break;
      }
      if (status === 'succeeded') {
        ok++;
        times.push((Date.now() - started) / 1000);
      } else {
        failed++;
        errors.push(`${status || 'timeout'}: ${String(job.error?.message ?? job.error ?? '').slice(0, 160)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallSeconds = (Date.now() - t0) / 1000;
  const cg = readCgroup(files);
  running = false;
  const peakDiskMiB = await disk;
  const cpuSeconds = cg.cpuSeconds !== null && cpuBefore !== null ? round(cg.cpuSeconds - cpuBefore, 1) : null;
  const videoSeconds = ok * PROFILES[cfg.workload]!.seconds;
  const st = summary(times);
  return {
    size,
    workload: cfg.workload,
    concurrency,
    ok,
    failed,
    errors: [...new Set(errors)].slice(0, 5),
    wallSeconds: round(wallSeconds, 1),
    rendersPerHour: round((ok * 3600) / wallSeconds, 1),
    videoSecondsPerCpuSecond: round(videoSeconds / (wallSeconds * size.cpus), 3),
    renderSeconds: { mean: round(times.reduce((a, b) => a + b, 0) / (times.length || 1), 1), p95: st.p95 },
    peakMemMiB: cg.peakMemMiB,
    oomKills: cg.oomKills,
    cpuSeconds,
    peakDiskMiB,
  };
}

/** Authenticated reads (list projects) from `parallel` clients for `seconds`, on an idle container. */
async function apiPoint(cfg: Config, s: Started, size: Size): Promise<ApiPoint> {
  for (let i = 0; i < 20; i++) {
    await fetch(`${s.url}/v1/projects`, { method: 'POST', headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ manifest: buildManifest(`api-${i}`, cfg.workload, [[cfg.engine, 1]], rng(i)) }) });
  }
  const lat: number[] = [];
  let errors = 0;
  const end = Date.now() + cfg.apiSeconds * 1000;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: cfg.apiParallel }, async () => {
      while (Date.now() < end) {
        const a = performance.now();
        try {
          const r = await fetch(`${s.url}/v1/projects?limit=20`, { headers: { authorization: `Bearer ${s.key}` } });
          await r.arrayBuffer();
          if (r.ok) lat.push(performance.now() - a);
          else errors++;
        } catch {
          errors++;
        }
      }
    })
  );
  const seconds = (Date.now() - t0) / 1000;
  return { size, requests: lat.length, errors, seconds: round(seconds, 1), perSecond: round(lat.length / seconds, 0), p95Ms: summary(lat).p95 };
}

/**
 * A point whose run broke off (the container exited or was OOM-killed, the API stopped answering): every
 * planned render counts as failed, so the sweep stops raising K for this size and the report shows why.
 */
export function brokenPoint(size: Size, workload: string, concurrency: number, total: number, error: unknown, oomKilled: boolean): Point {
  const message = (error instanceof Error ? error.message : String(error)).split('\n').map((l) => l.trim()).filter(Boolean).join(' ').slice(0, 160);
  return {
    size,
    workload,
    concurrency,
    ok: 0,
    failed: total,
    errors: [oomKilled ? `container OOM-killed: ${message}` : message],
    wallSeconds: 0,
    rendersPerHour: 0,
    videoSecondsPerCpuSecond: 0,
    renderSeconds: { mean: 0, p95: 0 },
    peakMemMiB: null,
    oomKills: oomKilled ? 1 : null,
    cpuSeconds: null,
    peakDiskMiB: null,
  };
}

// ---- report -------------------------------------------------------------------------------------------

export function renderMarkdown(points: Point[], api: ApiPoint[], host: Record<string, unknown>, workload: string): string {
  const p = PROFILES[workload]!;
  const sizes = [...new Map(points.map((x) => [`${x.size.cpus}:${x.size.memGiB}`, x.size])).values()];
  const lines = [
    `Workload: ${p.seconds} s videos at ${p.width}x${p.height}, 30 fps, H.264, html engine. Host: ${String(host.cpuModel)}, ${String(host.vcpu)} vCPU, ${String(host.ramGiB)} GiB, measured ${String(host.date).slice(0, 10)}.`,
    ...(host.note ? ['', String(host.note)] : []),
    '',
    '| Container | Renders at once | Renders an hour | Time per render (mean / p95) | Peak memory | Peak disk | API reads a second (p95) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const size of sizes) {
    const mine = points.filter((x) => x.size.cpus === size.cpus && x.size.memGiB === size.memGiB);
    const b = best(mine);
    const a = api.find((x) => x.size.cpus === size.cpus && x.size.memGiB === size.memGiB);
    const apiText = a ? `${a.perSecond} (${round(a.p95Ms, 0)} ms)` : '-';
    if (!b) {
      lines.push(`| ${size.cpus} vCPU, ${size.memGiB} GiB | none without a failure | - | - | ${mine[0]?.peakMemMiB ?? '-'} MiB | - | ${apiText} |`);
      continue;
    }
    lines.push(`| ${size.cpus} vCPU, ${size.memGiB} GiB | ${b.concurrency} | ${b.rendersPerHour} | ${round(b.renderSeconds.mean, 0)} s / ${round(b.renderSeconds.p95, 0)} s | ${b.peakMemMiB ?? '-'} MiB | ${b.peakDiskMiB ?? '-'} MiB | ${apiText} |`);
  }
  lines.push('', 'Every point measured:', '', '| Container | Renders at once | Done / failed | Renders an hour | Video s per vCPU-s | Peak memory | OOM kills | Errors |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const x of points) {
    lines.push(`| ${x.size.cpus} vCPU, ${x.size.memGiB} GiB | ${x.concurrency} | ${x.ok} / ${x.failed} | ${x.rendersPerHour} | ${x.videoSecondsPerCpuSecond} | ${x.peakMemMiB ?? '-'} MiB | ${x.oomKills ?? '-'} | ${x.errors.join('; ') || '-'} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const cfg = config();
  if (!PROFILES[cfg.workload]) throw new Error(`BENCH_WORKLOAD: unknown ${cfg.workload} (known: ${Object.keys(PROFILES).join(', ')})`);
  const dir = join(cfg.out, `${new Date().toISOString().replace(/[:.]/g, '-')}-docker`);
  if (!cfg.dryRun) mkdirSync(dir, { recursive: true });
  const host = { ...hostFingerprint(), image: cfg.dryRun ? cfg.image : docker(['image', 'inspect', '-f', '{{.Id}}', cfg.image]), note: cfg.note };
  const t = httpTransport(`http://127.0.0.1:${cfg.port}`);
  const points: Point[] = [];
  const api: ApiPoint[] = [];
  for (const size of cfg.sizes) {
    const cap = cfg.maxConcurrency || Math.max(2, Math.ceil(size.cpus * 2));
    const mine: Point[] = [];
    const fixed = cfg.concurrency.length ? [...cfg.concurrency] : null;
    for (let k = fixed ? fixed.shift()! : 1; fixed ? k > 0 : shouldContinue(mine, cap, cfg.minGain); k = fixed ? (fixed.shift() ?? 0) : k + 1) {
      const s = start(cfg, size, k);
      if (cfg.dryRun) {
        mine.push({ concurrency: k, failed: 1 } as Point);
        continue;
      }
      try {
        let point: Point;
        try {
          await healthy(s);
          point = await renderPoint(cfg, t, s, size, k);
        } catch (e) {
          // One broken point (the container died, an OOM kill took the server) ends this size, not the run.
          point = brokenPoint(size, cfg.workload, k, k * cfg.rendersPerSlot, e, docker(['inspect', '-f', '{{.State.OOMKilled}}', s.name], true) === 'true');
        }
        console.log(`${size.cpus} vCPU ${size.memGiB} GiB, ${k} at once: ${point.ok} ok, ${point.failed} failed, ${point.rendersPerHour}/h, peak ${point.peakMemMiB} MiB, OOM ${point.oomKills}${point.ok === 0 ? ` (${point.errors.join('; ')})` : ''}`);
        mine.push(point);
        appendFileSync(join(dir, 'points.jsonl'), `${JSON.stringify(point)}\n`);
      } finally {
        stop(s, cfg);
      }
    }
    if (cfg.dryRun) continue;
    points.push(...mine);
    const s = start(cfg, size, 1);
    try {
      await healthy(s);
      const a = await apiPoint(cfg, s, size);
      console.log(`${size.cpus} vCPU ${size.memGiB} GiB API: ${a.perSecond}/s, p95 ${round(a.p95Ms, 0)} ms, ${a.errors} errors`);
      api.push(a);
    } catch (e) {
      console.log(`${size.cpus} vCPU ${size.memGiB} GiB API: not measured (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
    } finally {
      stop(s, cfg);
    }
  }
  if (cfg.dryRun) return;
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify({ host, config: { ...cfg, out: undefined }, points, api }, null, 2)}\n`);
  writeFileSync(join(dir, 'summary.md'), renderMarkdown(points, api, host, cfg.workload));
  console.log(`\n${renderMarkdown(points, api, host, cfg.workload)}\nResults: ${dir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
