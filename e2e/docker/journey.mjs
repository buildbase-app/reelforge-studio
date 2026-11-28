import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const URL_ = process.env.URL, KEY = process.env.KEY;
const t = new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } });
const c = new Client({ name: 'e2e-journey', version: '1' }); await c.connect(t);
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const txt = r.content.map((x) => x.text ?? '').join('');
  if (r.isError) throw new Error(`${name} failed: ${txt.slice(0, 800)}`);
  try { return JSON.parse(txt); } catch { return txt; }
};
const step = (s) => console.log(`✔ ${s}`);
const caps = await call('get_capabilities'); step(`capabilities: engines=${JSON.stringify(caps.engines?.map?.((e) => e.id ?? e) ?? caps.engines)}`);
const themes = await call('list_themes'); step(`themes: ${themes.themes.map((x) => x.id).join(',')}`);
if (process.env.EDITION === 'release') {
  // #783: no Remotion renders until the customer has turned it on, accepted Remotion's licence, set a key and installed it.
  const r = JSON.parse(readFileSync('sample-reel-remotion.json', 'utf8')); r.projectId = 'e2e-remotion-' + Date.now().toString(36);
  await call('create_project', { manifest: r });
  const rv = await call('validate_project', { projectId: r.projectId });
  const msg = JSON.stringify(rv.errors ?? rv);
  if ((rv.ok ?? rv.valid) !== false || !/engine \\"remotion\\" cannot render on this server: Remotion is off: it needs your own Remotion licence/.test(msg)) throw new Error(`release edition: expected the Remotion scene to be refused, got ${msg.slice(0, 400)}`);
  step('release edition: a Remotion scene is refused until the customer brings their own Remotion licence');
}
const m = JSON.parse(readFileSync(process.env.SAMPLE ?? 'sample.json', 'utf8')); m.projectId = 'e2e-docker-' + Date.now().toString(36); m.title = 'Docker E2E';
const p = await call('create_project', { manifest: m }); step(`create_project ${m.projectId} (v0.1 migrated → ${p.manifest?.schemaVersion ?? p.schemaVersion})`);
await call('add_scene', { projectId: m.projectId, scene: { id: 'html', engine: 'html', template: 'html-title', durationFrames: 75, props: { headline: 'HTML engine', subline: 'From Docker' } } }); step('add_scene html-title (2.5 s)');
await call('add_scene', { projectId: m.projectId, scene: { id: 'hf', engine: 'hyperframes', template: 'hyperframes-title', durationFrames: 60, props: { headline: 'HyperFrames engine' } } }); step('add_scene hyperframes-title (2 s)');
await call('update_scene', { projectId: m.projectId, sceneId: 'hook', patch: { durationFrames: 75 } }); step('update_scene hook timing → 75 frames');
await call('set_theme', { projectId: m.projectId, theme: 'midnight' }); step('set_theme midnight');
const v = await call('validate_project', { projectId: m.projectId }); step(`validate: ok=${v.ok ?? v.valid} warnings=${(v.warnings ?? []).length}`);
const job = await call('render_project', { projectId: m.projectId }); const jobId = job.jobId ?? job.job?.id ?? job.id; step(`render_project job=${jobId}`);
let j; const t0 = Date.now();
for (;;) { j = await call('get_job', { jobId, waitSeconds: 45 }); const s = j.state ?? j.job?.state ?? j.status; if (['succeeded', 'failed', 'cancelled'].includes(s)) break; }
const state = j.state ?? j.job?.state ?? j.status; step(`job ${state} in ${Math.round((Date.now() - t0) / 1000)} s`);
if (state !== 'succeeded') { console.log(JSON.stringify(j).slice(0, 2000)); console.log(await call('get_job_logs', { jobId })); process.exit(1); }
const out = await call('get_render_output', { jobId }); const url = out.downloadUrl ?? out.output?.downloadUrl; step(`get_render_output: ${JSON.stringify({ frames: out.frames ?? out.probe?.frames, url: url && url.replace(/sig=[^&]+/, 'sig=…') })}`);
const res = await fetch(url.startsWith('http') ? url : new URL(url, URL_).href); const buf = Buffer.from(await res.arrayBuffer());
writeFileSync('/out/docker-e2e.mp4', buf); step(`downloaded ${buf.length} bytes via signed URL (HTTP ${res.status})`);
await c.close();
