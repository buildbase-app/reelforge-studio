// Scale e2e client (issue #36): an agent in its own container talks MCP to the
// api container only; the renders run on the worker containers.
//   PHASE=setup    two projects: "scale-short" (one 1 s html scene) and "scale-long" (one 5 s html scene)
//   PHASE=render   N renders of scale-short, long-polled to the end; writes /out/scale-render.json, downloads one MP4
//   PHASE=start    one render of scale-long; waits until a worker runs it; writes /out/scale-slow.json
//   PHASE=finish   long-polls the job in /out/scale-slow.json; writes /out/scale-finish.json
//   PHASE=cancel   a render of scale-long, cancelled while a worker runs it
//   PHASE=submit   one render of scale-short, not waited for; writes /out/scale-queued.json
//   PHASE=wait     long-polls the job in /out/scale-queued.json
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const t = new StreamableHTTPClientTransport(new URL(process.env.URL), { requestInit: { headers: { Authorization: `Bearer ${process.env.KEY}` } } });
const c = new Client({ name: 'e2e-scale', version: '1' });
await c.connect(t);
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const txt = r.content.map((x) => x.text ?? '').join('');
  if (r.isError) throw new Error(`${name} failed: ${txt.slice(0, 800)}`);
  return JSON.parse(txt);
};
const step = (s) => console.log(`✔ ${s}`);
const fail = (s) => {
  console.log(`✘ ${s}`);
  process.exit(1);
};
const TERMINAL = ['succeeded', 'failed', 'cancelled'];
const finish = async (jobId, maxSeconds = 600) => {
  const end = Date.now() + maxSeconds * 1000;
  for (;;) {
    const j = await call('get_job', { jobId, waitSeconds: 45 });
    if (TERMINAL.includes(j.status)) return j;
    if (Date.now() > end) fail(`job ${jobId} still ${j.status} after ${maxSeconds} s`);
  }
};
const running = async (jobId) => {
  for (let i = 0; i < 600; i++) {
    const j = await call('get_job', { jobId });
    if (j.status === 'running' && j.progress?.fraction > 0) return j;
    if (TERMINAL.includes(j.status)) fail(`job ${jobId} ended (${j.status}) before it was seen running`);
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`job ${jobId} never ran`);
};
const render = async (projectId) => {
  const r = await call('render_project', { projectId });
  return r.job?.id ?? r.jobId ?? r.id;
};

const phase = process.env.PHASE;
if (phase === 'setup') {
  const sample = JSON.parse(readFileSync(process.env.SAMPLE, 'utf8'));
  for (const [id, frames] of [['scale-short', 30], ['scale-long', 150]]) {
    await call('create_project', { manifest: { ...sample, projectId: id, title: `Scale ${id}` } });
    await call('add_scene', { projectId: id, scene: { id: 'title', engine: 'html', template: 'html-title', durationFrames: frames, props: { headline: 'Scaled out', subline: id } } });
    for (const s of sample.scenes) await call('remove_scene', { projectId: id, sceneId: s.id });
    const v = await call('validate_project', { projectId: id });
    if (!v.ok) fail(`project ${id} is invalid: ${JSON.stringify(v.errors)}`);
  }
  step('projects scale-short (1 s, html) and scale-long (5 s, html) created on the api');
} else if (phase === 'render') {
  const n = Number(process.env.JOBS ?? 6);
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(await render('scale-short'));
  step(`${n} render_project calls accepted by the api: ${ids.join(', ')}`);
  const jobs = await Promise.all(ids.map((id) => finish(id)));
  const bad = jobs.filter((j) => j.status !== 'succeeded');
  if (bad.length) fail(`not succeeded: ${JSON.stringify(bad.map((j) => [j.id, j.status, j.error]))}`);
  const workers = [...new Set(jobs.map((j) => j.workerId))];
  step(`all ${n} succeeded (long-polled over MCP), on workers: ${workers.join(', ')}; attempts: ${jobs.map((j) => j.attempts).join(',')}`);
  writeFileSync('/out/scale-render.json', JSON.stringify(jobs.map((j) => ({ id: j.id, workerId: j.workerId, attempts: j.attempts, renderId: j.result?.renderId }))));
  const out = await call('get_render_output', { jobId: ids[0] });
  const res = await fetch(out.downloadUrl);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync('/out/scale-e2e.mp4', buf);
  step(`render made on ${jobs[0].workerId} downloaded through the api's link (${out.downloadVia}, HTTP ${res.status}, ${buf.length} bytes)`);
} else if (phase === 'start') {
  const id = await render('scale-long');
  const j = await running(id);
  writeFileSync('/out/scale-slow.json', JSON.stringify({ id, workerId: j.workerId }));
  step(`long render ${id} is running on ${j.workerId} (${Math.round(j.progress.fraction * 100)}%)`);
} else if (phase === 'finish') {
  const { id, workerId } = JSON.parse(readFileSync('/out/scale-slow.json', 'utf8'));
  const j = await finish(id);
  writeFileSync('/out/scale-finish.json', JSON.stringify({ id, status: j.status, workerId: j.workerId, attempts: j.attempts, renderId: j.result?.renderId }));
  if (j.status !== 'succeeded') fail(`job ${id}: ${j.status} ${JSON.stringify(j.error)}`);
  step(`job ${id} succeeded on ${j.workerId} (attempt ${j.attempts}; it started on ${workerId})`);
  const logs = await call('get_job_logs', { jobId: id });
  const text = (logs.lines ?? logs).join('\n');
  const lease = text.split('\n').find((l) => /lease expired|released by worker/.test(l));
  if (lease) step(`job log: ${lease.replace(/^\S+ /, '')}`);
} else if (phase === 'cancel') {
  const id = await render('scale-long');
  const j = await running(id);
  const c1 = await call('cancel_job', { jobId: id });
  const end = await finish(id, 60);
  if (end.status !== 'cancelled') fail(`job ${id} is ${end.status} after cancel_job`);
  step(`cancel_job on the api stopped job ${id} running on ${j.workerId} (cancel requested at ${c1.cancelRequestedAt ?? 'once'}; final: ${end.status})`);
} else if (phase === 'submit') {
  const id = await render('scale-short');
  writeFileSync('/out/scale-queued.json', JSON.stringify({ id }));
  const j = await call('get_job', { jobId: id });
  step(`render ${id} accepted: ${j.status}${j.queuePosition !== undefined ? ` (queue position ${j.queuePosition})` : ''}`);
} else if (phase === 'wait') {
  const { id } = JSON.parse(readFileSync('/out/scale-queued.json', 'utf8'));
  const j = await finish(id);
  if (j.status !== 'succeeded') fail(`job ${id}: ${j.status} ${JSON.stringify(j.error)}`);
  step(`queued job ${id} succeeded on ${j.workerId} once the dependency was back`);
} else {
  fail(`unknown PHASE ${phase}`);
}
await c.close();
