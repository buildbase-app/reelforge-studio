// Storage on S3 (issue #27, docs/providers/storage.md STO-30..STO-36), from a separate container
// like an agent: the server runs with storage.driver s3 against a MinIO container (alias "minio").
//   get_storage: driver s3, health ok, usage; renders migrated from local storage still download
//   render -> objects in MinIO (checked with the S3 API) -> downloadUrl signed by MinIO -> download
//   run_storage_cleanup: dry run lists, nothing deleted; real run deletes the objects in MinIO
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
const URL_ = process.env.URL, KEY = process.env.KEY;
const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ID, secretAccessKey: process.env.S3_SECRET } });
const BUCKET = process.env.S3_BUCKET;
const t = new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } });
const c = new Client({ name: 'e2e-storage', version: '1' }); await c.connect(t);
let fail = 0;
const check = (name, ok, extra = '') => { if (!ok) fail++; console.log(`${ok ? '✔' : '✘'} ${name}${extra ? `: ${extra}` : ''}`); };
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content.map((x) => x.text ?? '').join('');
  if (r.isError) throw new Error(`${name}: ${text.slice(0, 600)}`);
  if (text.includes(process.env.S3_SECRET)) { fail++; console.log(`✘ ${name} returned the storage secret`); }
  return JSON.parse(text);
};
const keys = async (prefix) => {
  const out = []; let token;
  do { const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token })); out.push(...(r.Contents ?? []).map((o) => o.Key)); token = r.IsTruncated ? r.NextContinuationToken : undefined; } while (token);
  return out;
};
const render = async (projectId) => {
  const job = (await call('render_project', { projectId })).job;
  let j; for (;;) { j = await call('get_job', { jobId: job.id, waitSeconds: 45 }); if (['succeeded', 'failed', 'cancelled'].includes(j.status)) break; }
  if (j.status !== 'succeeded') throw new Error(`render ${j.status}: ${JSON.stringify(j.error)}`);
  return j.result.renderId;
};

// An asset uploaded now goes to MinIO (a 1x1 PNG).
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const up = await call('upload_asset', { dataBase64: png, filename: 'dot.png', license: { name: 'CC0-1.0', redistributable: true } });
check('STO-36 an uploaded asset is stored in MinIO', (await keys(`assets/${up.asset.id}/`)).includes(`assets/${up.asset.id}/file.png`), up.asset.id);
const st = await call('get_storage');
check('STO-30 get_storage: driver s3, MinIO bucket, health ok', st.driver === 's3' && st.location.bucket === BUCKET && st.health.ok === true, JSON.stringify({ driver: st.driver, location: st.location, health: st.health }));
check('STO-30 get_storage: usage counts the asset and the migrated renders', st.usage.assets.objects >= 1 && st.usage.renders.count >= 1, JSON.stringify(st.usage));
check('STO-30 get_storage: credentials are the configured key, never shown', /access key/.test(st.location.credentials));

// A render made on local storage before the migration is listed and downloads from MinIO.
const projects = (await call('list_projects')).projects.map((p) => p.id ?? p.meta?.id);
let migrated = null;
for (const id of projects) { const r = (await call('list_renders', { projectId: id })).renders; if (r.length) { migrated = r[0]; break; } }
check('STO-33 a render from before the migration is listed from MinIO', Boolean(migrated), migrated?.renderId);
if (migrated) {
  const res = await fetch(migrated.downloadUrl);
  check('STO-33 ... and downloads through a MinIO-signed URL', res.status === 200 && migrated.downloadVia === 'bucket' && (await res.arrayBuffer()).byteLength > 1000, `HTTP ${res.status}`);
}

// A new render goes to MinIO.
const sample = JSON.parse((await import('node:fs')).readFileSync(process.env.SAMPLE, 'utf8'));
const projectId = 'storage-e2e';
sample.projectId = projectId; sample.title = 'Storage E2E';
await call('create_project', { manifest: sample });
await call('add_scene', { projectId, scene: { id: 'stored', engine: 'html', template: 'html-title', durationFrames: 45, props: { headline: 'Stored in MinIO' } } });
await call('remove_scene', { projectId, sceneId: 'hook' });
await call('remove_scene', { projectId, sceneId: 'how-it-works' });
const first = await render(projectId);
const objects = await keys(`projects/${projectId}/renders/${first}/`);
check('STO-31 the render is stored in MinIO (final.mp4, poster.png, render-manifest.json, clips)', ['final.mp4', 'poster.png', 'render-manifest.json'].every((f) => objects.includes(`projects/${projectId}/renders/${first}/${f}`)), `${objects.length} objects`);
check('STO-31 no temporary upload keys are left', (await keys(`projects/${projectId}/renders/.tmp-`)).length === 0);
const out = await call('get_render_output', { renderId: first, includePoster: false });
const u = new URL(out.downloadUrl);
check('STO-31 downloadUrl is signed by MinIO (SigV4), not by the server', out.downloadVia === 'bucket' && u.host === 'minio:9000' && u.searchParams.has('X-Amz-Signature'), `${u.host}${u.pathname}`);
const res = await fetch(out.downloadUrl);
const buf = Buffer.from(await res.arrayBuffer());
writeFileSync('/out/storage-e2e.mp4', buf);
check('STO-31 downloaded through the signed URL', res.status === 200 && buf.length > 1000, `${buf.length} bytes`);
const part = await fetch(out.downloadUrl, { headers: { range: 'bytes=0-99' } });
check('STO-32 Range on the signed URL', part.status === 206 && (await part.arrayBuffer()).byteLength === 100, `HTTP ${part.status}`);
writeFileSync('/out/storage-render.txt', first);

// Retention: a second render; keep the newest one per project.
const second = await render(projectId);
const dry = await call('run_storage_cleanup', { dryRun: true, keepLastRendersPerProject: 1 });
const planned = dry.renders.filter((r) => r.projectId === projectId).map((r) => r.renderId);
check('STO-34 run_storage_cleanup dry run lists the older render, deletes nothing', planned.includes(first) && !planned.includes(second) && (await keys(`projects/${projectId}/renders/${first}/`)).length > 0, JSON.stringify(dry.totals));
const real = await call('run_storage_cleanup', { keepLastRendersPerProject: 1 });
check('STO-34 run_storage_cleanup real run deletes it from MinIO', real.renders.some((r) => r.renderId === first) && (await keys(`projects/${projectId}/renders/${first}/`)).length === 0, JSON.stringify(real.totals));
check('STO-34 the newest render of every project is kept', (await keys(`projects/${projectId}/renders/${second}/`)).length > 0 && (await call('list_renders', { projectId })).renders.length === 1);
await c.close();
if (fail) { console.log(`${fail} storage check(s) failed`); process.exit(1); }
