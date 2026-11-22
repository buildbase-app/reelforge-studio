// REST client of the KEDA e2e (e2e/k8s/keda.sh): talks to the api only (the
// NodePort on the kind node), like any agent would. Node 22, no dependencies.
//   PHASE=setup    activates the licence (mock), creates "keda-short" (1 s html, 540x960) and "keda-long" (6 s html, 1080x1920)
//   PHASE=burst    JOBS renders of keda-short, all enqueued at once; waits for all; writes $OUT/burst.json
//   PHASE=start    one render of keda-long; waits until it renders (progress > 0); writes $OUT/slow.json
//   PHASE=finish   waits for the job in $OUT/slow.json; writes $OUT/finish.json
import { readFileSync, writeFileSync } from 'node:fs';

const URL_ = process.env.URL ?? 'http://127.0.0.1:4340';
const OUT = process.env.OUT;
const KEY = process.env.KEY;
const TERMINAL = ['succeeded', 'failed', 'cancelled'];
const fail = (s) => {
  console.log(`✘ ${s}`);
  process.exit(1);
};
const step = (s) => console.log(`✔ ${s}`);
async function rest(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${URL_}${path}`, {
        method,
        headers: { authorization: `Bearer ${KEY}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, json, text };
    } catch (e) {
      // The NodePort can drop a connection while the node is busy: retry reads and idempotent calls.
      if (attempt >= 5 || method === 'POST') throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
const finish = async (id, maxSeconds = 900) => {
  const end = Date.now() + maxSeconds * 1000;
  for (;;) {
    const r = await rest('GET', `/v1/jobs/${id}?wait=20`);
    if (r.status === 200 && TERMINAL.includes(r.json.status)) return r.json;
    if (Date.now() > end) fail(`job ${id} still ${r.json?.status} after ${maxSeconds} s`);
  }
};
const render = async (projectId) => {
  const r = await rest('POST', `/v1/projects/${projectId}/renders`, {});
  if (r.status !== 202) fail(`render ${projectId}: HTTP ${r.status} ${r.text.slice(0, 400)}`);
  return r.json.job.id;
};

const phase = process.env.PHASE;
if (phase === 'setup') {
  const lic = await rest('POST', '/v1/licence', { key: process.env.LICENCE_KEY });
  if (lic.status !== 200 || lic.json.status !== 'valid') fail(`licence: HTTP ${lic.status} ${lic.text.slice(0, 300)}`);
  step(`licence activated on the api (mock licence server, test only): ${lic.json.status}`);
  const sample = JSON.parse(readFileSync(process.env.SAMPLE, 'utf8'));
  for (const [id, frames, w, h] of [['keda-short', 30, 540, 960], ['keda-long', 180, 1080, 1920]]) {
    // The v0.1 sample is upgraded on import; the html scene is added to the upgraded project (as e2e/docker/scale.mjs).
    const r = await rest('POST', '/v1/projects', { manifest: { ...sample, projectId: id, title: `KEDA ${id}`, output: { ...sample.output, width: w, height: h } } });
    if (r.status !== 201) fail(`create ${id}: HTTP ${r.status} ${r.text.slice(0, 400)}`);
    const scene = { id: 'title', engine: 'html', template: 'html-title', durationFrames: frames, props: { headline: 'Scaled from zero', subline: id } };
    const a = await rest('POST', `/v1/projects/${id}/scenes`, { scene });
    if (a.status >= 300) fail(`add_scene ${id}: HTTP ${a.status} ${a.text.slice(0, 400)}`);
    for (const s of sample.scenes) {
      const d = await rest('DELETE', `/v1/projects/${id}/scenes/${s.id}`);
      if (d.status >= 300) fail(`remove_scene ${id}/${s.id}: HTTP ${d.status} ${d.text.slice(0, 300)}`);
    }
    const v = await rest('POST', `/v1/projects/${id}/validate`, {});
    if (!v.json?.ok) fail(`project ${id} is invalid: ${v.text.slice(0, 400)}`);
  }
  step('projects keda-short (1 s html, 540x960) and keda-long (6 s html, 1080x1920) created on the api');
} else if (phase === 'burst') {
  const n = Number(process.env.JOBS ?? 20);
  const enqueuedAt = Date.now();
  const ids = await Promise.all(Array.from({ length: n }, () => render('keda-short')));
  step(`${n} renders accepted by the api in ${Date.now() - enqueuedAt} ms`);
  const jobs = await Promise.all(ids.map((id) => finish(id)));
  const bad = jobs.filter((j) => j.status !== 'succeeded');
  writeFileSync(
    `${OUT}/burst.json`,
    JSON.stringify({
      enqueuedAt,
      jobs: jobs.map((j) => ({ id: j.id, status: j.status, attempts: j.attempts, workerId: j.workerId, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, error: j.error })),
    }),
  );
  if (bad.length) fail(`not succeeded: ${JSON.stringify(bad.map((j) => [j.id, j.status, j.error]))}`);
  step(`all ${n} succeeded on ${new Set(jobs.map((j) => j.workerId)).size} workers`);
} else if (phase === 'start') {
  const id = await render('keda-long');
  for (let i = 0; i < 1200; i++) {
    const j = (await rest('GET', `/v1/jobs/${id}`)).json;
    if (j?.status === 'running' && j.progress?.fraction > 0) {
      writeFileSync(`${OUT}/slow.json`, JSON.stringify({ id, workerId: j.workerId }));
      step(`long render ${id} is running on ${j.workerId} (${Math.round(j.progress.fraction * 100)}%)`);
      process.exit(0);
    }
    if (TERMINAL.includes(j?.status)) fail(`job ${id} ended (${j.status}) before it was seen rendering`);
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`job ${id} never ran`);
} else if (phase === 'finish') {
  const { id, workerId } = JSON.parse(readFileSync(`${OUT}/slow.json`, 'utf8'));
  const j = await finish(id);
  writeFileSync(`${OUT}/finish.json`, JSON.stringify({ id, status: j.status, workerId: j.workerId, attempts: j.attempts }));
  if (j.status !== 'succeeded') fail(`job ${id}: ${j.status} ${JSON.stringify(j.error)}`);
  const logs = (await rest('GET', `/v1/jobs/${id}/logs`)).json;
  const line = (logs?.lines ?? []).find((l) => /lease expired|released by worker|handed back/.test(l));
  step(`job ${id} succeeded on ${j.workerId}, attempt ${j.attempts} (it started on ${workerId})${line ? `; log: ${line.replace(/^\S+ /, '')}` : ''}`);
} else {
  fail(`unknown PHASE ${phase}`);
}
