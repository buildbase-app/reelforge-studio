import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, RemotionLambdaBackend, ElevenLabsTts } from '@reelforge/core';
import { TOOLS, WORKFLOW_GUIDE, startServer, type StartedServer } from '../src/index';
import { parseProject } from '@reelforge/project-schema';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/** MCP over real HTTP with the official SDK client; fake engines so it runs without a browser. */
const { dir, cleanup } = tempDir('reelforge-mcp-');
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
let server: StartedServer;
let adminKey: string;
let readKey: string;
let dropDb: () => Promise<void> = async () => undefined;

async function connect(key: string) {
  const client = new Client({ name: 'reelforge-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  return client;
}

function json(result: any) {
  const text = result.content.find((c: any) => c.type === 'text')?.text;
  return JSON.parse(text);
}

beforeAll(async () => {
  const registry = new PluginRegistry()
    .registerEngine(fakeEngine('remotion'))
    .registerEngine(fakeEngine('motion-canvas'))
    .registerProvider(new ElevenLabsTts({}))
    .registerBackend(new RemotionLambdaBackend({}));
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer({ dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' }, { registry, env: { ...database.env, REELFORGE_LICENCE_MODE: 'off' }, quiet: true });
  adminKey = (await server.service.keys.create('admin', ['admin'])).key;
  readKey = (await server.service.keys.create('reader', ['read'])).key;
});
afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

describe('MCP server (Streamable HTTP, stateless)', () => {
  it('lists every tool in the spec with descriptions and input schemas', async () => {
    const client = await connect(adminKey);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [
      'get_capabilities', 'get_project_schema', 'list_templates', 'list_themes', 'create_theme', 'create_project', 'get_project',
      'update_project', 'validate_project', 'add_scene', 'update_scene', 'remove_scene', 'reorder_scenes', 'set_theme', 'set_audio',
      'generate_voice', 'add_asset_from_url', 'list_assets', 'preview_scene', 'render_project', 'get_job', 'cancel_job', 'get_job_logs',
      'get_render_output',
    ]) {
      expect(names).toContain(n);
    }
    expect(tools.length).toBe(TOOLS.length);
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
    }
    expect(tools.find((t) => t.name === 'remove_scene')?.annotations?.destructiveHint).toBe(true);
    await client.close();
  });

  it('runs tools through the same handlers as REST, with structured errors', async () => {
    const client = await connect(adminKey);
    const caps = json(await client.callTool({ name: 'get_capabilities', arguments: {} }));
    expect(caps.schemaVersion).toBe('0.2');
    const created = json(await client.callTool({ name: 'create_project', arguments: { manifest: sample } }));
    expect(created.migratedFrom).toBe('0.1');
    expect(created.timing.map((t: any) => t.durationFrames)).toEqual([90, 120]);
    const bad = await client.callTool({ name: 'update_scene', arguments: { projectId: 'sample-reel', sceneId: 'hook', patch: { props: { headline: '' } } } });
    expect(bad.isError).toBe(true);
    const err = json(bad).error;
    expect(err.code).toBe('invalid_manifest');
    expect(err.details.issues[0].path).toBe('scenes.0.props.headline');
    const lambda = await client.callTool({ name: 'render_project', arguments: { projectId: 'sample-reel', backend: 'remotion-lambda' } });
    expect(json(lambda).error.code).toBe('backend_not_configured');
    await client.close();
  });

  it('enforces key scopes on tools', async () => {
    const client = await connect(readKey);
    const r = await client.callTool({ name: 'create_project', arguments: { manifest: { ...sample, projectId: 'other' } } });
    expect(r.isError).toBe(true);
    expect(json(r).error.code).toBe('forbidden');
    expect(json(await client.callTool({ name: 'list_projects', arguments: {} })).projects.length).toBe(1);
    await client.close();
  });

  it('exposes resources and prompts', async () => {
    const client = await connect(adminKey);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining(['reelforge://schema/project', 'reelforge://templates', 'reelforge://projects/sample-reel']));
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((r) => r.uriTemplate)).toContain('reelforge://projects/{id}');
    const schema = await client.readResource({ uri: 'reelforge://schema/project' });
    expect(JSON.parse((schema.contents[0] as any).text).type).toBe('object');
    const project = await client.readResource({ uri: 'reelforge://projects/sample-reel' });
    expect(JSON.parse((project.contents[0] as any).text).manifest.projectId).toBe('sample-reel');
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['make_reel', 'plan_reel', 'review_reel']);
    const guide = await client.readResource({ uri: 'reelforge://guide/workflow' });
    expect((guide.contents[0] as any).text).toContain('render_project');
    const make = await client.getPrompt({ name: 'make_reel', arguments: { topic: 'a bakery opening' } });
    expect((make.messages[0]!.content as any).text).toContain('a bakery opening');
    const plan = await client.getPrompt({ name: 'plan_reel', arguments: { brief: 'Launch of a coffee app', targetSeconds: '12' } });
    expect((plan.messages[0]!.content as any).text).toContain('kinetic-title');
    const review = await client.getPrompt({ name: 'review_reel', arguments: { projectId: 'sample-reel' } });
    expect((review.messages[0]!.content as any).text).toContain('first frame is not empty');
    await client.close();
  });

  it('rejects requests without a key', async () => {
    const r = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.status).toBe(401);
  });
});

describe('workflow guide', () => {
  it('contains a minimal manifest that is valid as written', () => {
    const json = WORKFLOW_GUIDE.split('## Minimal manifest\n')[1]!.split('\n\n## ')[0]!;
    const r = parseProject(JSON.parse(json));
    expect(r.ok, JSON.stringify(!r.ok && r.issues)).toBe(true);
  });
});
