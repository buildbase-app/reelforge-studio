#!/usr/bin/env node
/**
 * Make a reel over MCP with no language model: the official MCP TypeScript SDK
 * connects to the studio over Streamable HTTP and calls the tools one by one.
 * This is what any MCP client (Cursor, Windsurf, VS Code, Zed, your own agent)
 * does on the wire.
 *
 *   npm i @modelcontextprotocol/sdk@1.32.2          # outside this repo
 *   RENDERWELD_URL=http://127.0.0.1:4321 RENDERWELD_API_KEY=rf_... \
 *     node mcp-client.mjs examples/tutorials/html.json [projectId]
 *
 * The last line it prints is `RESULT {json}` (project, job, render, tool calls).
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = (process.env.RENDERWELD_URL ?? 'http://127.0.0.1:4321').replace(/\/$/, '');
const key = process.env.RENDERWELD_API_KEY;
const [manifestPath, projectIdArg] = process.argv.slice(2);
if (!key || !manifestPath) {
  console.error('usage: RENDERWELD_API_KEY=rf_... node mcp-client.mjs <manifest.json> [projectId]');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (projectIdArg) manifest.projectId = projectIdArg;
const projectId = manifest.projectId;

const client = new Client({ name: 'reelforge-tutorial', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));

const toolCalls = [];
/** Call a tool, fail loudly on a tool error, return the parsed JSON result. */
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  toolCalls.push({ name, input: args, isError: r.isError === true, images: r.content.filter((c) => c.type === 'image').length });
  if (r.isError) throw new Error(`${name} failed: ${text.slice(0, 1500)}`);
  console.log(`✔ ${name}`);
  return { json: JSON.parse(text), content: r.content };
}

const { tools } = await client.listTools();
console.log(`connected: ${tools.length} tools`);

const caps = (await call('get_capabilities')).json;
const engines = [...new Set(manifest.scenes.map((s) => s.engine))];
for (const e of engines) {
  const info = caps.engines.find((x) => x.id === e);
  if (!info?.available) throw new Error(`engine ${e} cannot render on this server: ${JSON.stringify(info)}`);
}
for (const e of engines) await call('list_templates', { engine: e });

// Re-running the tutorial replaces the previous project of the same id.
// list_projects returns one page (newest first) and nextCursor: follow it until null.
let existing = false;
for (let cursor; !existing; ) {
  const page = (await call('list_projects', cursor ? { cursor } : {})).json;
  existing = page.projects.some((p) => p.id === projectId);
  if (!page.nextCursor) break;
  cursor = page.nextCursor;
}
if (existing) await call('delete_project', { projectId });
await call('create_project', { manifest });

const report = (await call('validate_project', { projectId })).json;
if (!report.ok) throw new Error(`validation failed: ${JSON.stringify(report.errors)}`);

const job = (await call('render_project', { projectId })).json.job;
console.log(`job ${job.id} started`);
let status = job;
while (!['succeeded', 'failed', 'cancelled'].includes(status.status)) {
  status = (await call('get_job', { jobId: job.id, waitSeconds: 45 })).json;
  console.log(`  ${status.status} ${status.progress?.stage ?? ''} ${Math.round((status.progress?.fraction ?? 0) * 100)}%`);
}
if (status.status !== 'succeeded') {
  const logs = (await call('get_job_logs', { jobId: job.id, tail: 30 })).json.lines;
  throw new Error(`render ${status.status}: ${JSON.stringify(status.error)}\n${logs.join('\n')}`);
}

const out = await call('get_render_output', { jobId: job.id });
const poster = out.content.find((c) => c.type === 'image');
console.log(`render ${out.json.renderId}: ${out.json.width}x${out.json.height}, ${out.json.frames} frames, ${out.json.durationSeconds}s, poster ${poster ? 'attached' : 'missing'}`);
await client.close();

console.log('RESULT ' + JSON.stringify({ projectId, jobId: job.id, renderId: out.json.renderId, toolCount: tools.length, posterAttached: Boolean(poster), toolCalls }));
