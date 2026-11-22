#!/usr/bin/env node
/**
 * The REST tutorial with fetch (Node 22, no dependencies): the same calls as
 * rest.sh, for scripts, serverless functions and automation tools.
 *
 *   REELFORGE_URL=http://127.0.0.1:4321 REELFORGE_API_KEY=rf_... \
 *     node examples/tutorials/rest-fetch.mjs examples/tutorials/html.json [projectId] [out.mp4]
 *
 * The last line it prints is `RESULT {json}`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const RF = (process.env.REELFORGE_URL ?? 'http://127.0.0.1:4321').replace(/\/$/, '');
const KEY = process.env.REELFORGE_API_KEY;
const [manifestPath, projectIdArg, out = 'final.mp4'] = process.argv.slice(2);
if (!KEY || !manifestPath) {
  console.error('usage: REELFORGE_API_KEY=rf_... node rest-fetch.mjs <manifest.json> [projectId] [out.mp4]');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (projectIdArg) manifest.projectId = projectIdArg;
const projectId = manifest.projectId;
const toolCalls = [];

/** One REST call; throws with the server's error body on a non-2xx answer. */
async function api(method, path, body) {
  toolCalls.push({ name: `${method} ${path}`, input: {} });
  const res = await fetch(RF + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res;
}
const json = async (...a) => (await api(...a)).json();

const caps = await json('GET', '/v1/capabilities');
console.log('engines:', caps.engines.map((e) => `${e.id}${e.available ? '' : ' (unavailable)'}`).join(', '));

const list = await json('GET', '/v1/projects');
if (list.projects.some((p) => p.id === projectId)) await api('DELETE', `/v1/projects/${projectId}`);
await json('POST', '/v1/projects', manifest);

const report = await json('POST', `/v1/projects/${projectId}/validate`, {});
if (!report.ok) throw new Error(`invalid: ${JSON.stringify(report.errors)}`);

const { job } = await json('POST', `/v1/projects/${projectId}/renders`, {});
console.log(`job ${job.id}`);
let status = job;
while (!['succeeded', 'failed', 'cancelled'].includes(status.status)) {
  status = await json('GET', `/v1/jobs/${job.id}?wait=50`);
  console.log(`  ${status.status} ${status.progress?.stage ?? ''}`);
}
if (status.status !== 'succeeded') throw new Error(`render ${status.status}: ${JSON.stringify(status.error)}`);

const renderId = status.result.renderId;
const res = await api('GET', `/v1/renders/${renderId}/output`);
writeFileSync(out, Buffer.from(await res.arrayBuffer()));
console.log(`saved ${out}: ${status.result.width}x${status.result.height}, ${status.result.frames} frames, ${status.result.durationSeconds}s`);
console.log('RESULT ' + JSON.stringify({ projectId, jobId: job.id, renderId, output: out, toolCalls }));
