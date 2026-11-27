import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, RemotionLambdaBackend, ElevenLabsTts } from '@renderweld/core';
import { BRIEF_ESSENTIALS, TOOLS, WORKFLOW_GUIDE, startServer, type StartedServer } from '../src/index';
import { parseProject } from '@renderweld/project-schema';
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
  server = await startServer({ dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' }, { registry, env: { ...database.env, RENDERWELD_LICENCE_MODE: 'off' }, quiet: true });
  adminKey = (await server.service.keys.create('admin', ['admin', 'owner'])).key;
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
    expect(caps.server).toMatchObject({ name: 'renderweld', title: 'RenderWeld' });
    const created = json(await client.callTool({ name: 'create_project', arguments: { manifest: sample } }));
    expect(created.migratedFrom).toBe('0.1');
    expect(created.timing.map((t: any) => t.durationFrames)).toEqual([90, 120]);
    const bad = await client.callTool({ name: 'update_scene', arguments: { projectId: 'sample-reel', sceneId: 'hook', patch: { props: { headline: '' } } } });
    expect(bad.isError).toBe(true);
    const err = json(bad).error;
    expect(err.code).toBe('invalid_manifest');
    expect(err.details.issues[0].path).toBe('scenes.0.props.headline');
    // An unsupported frame rate names the supported ones (#322).
    const fps = json(await client.callTool({ name: 'create_project', arguments: { manifest: { ...sample, projectId: 'bad-fps', output: { ...sample.output, fps: 120 } } } })).error;
    expect(fps.code).toBe('invalid_manifest');
    expect(fps.details.issues.find((i: any) => i.path === 'output.fps')?.message).toBe(`fps must be one of 23.976 ("24000/1001"), 24, 25, 29.97 ("30000/1001"), 30, 48, 50, 59.94 ("60000/1001"), 60; give NTSC rates as "30000/1001", { "num": 30000, "den": 1001 } or 29.97 (got 120)`);
    // NTSC rates are stored exactly (#302).
    const ntsc = json(await client.callTool({ name: 'create_project', arguments: { manifest: { ...sample, projectId: 'ntsc-fps', output: { ...sample.output, fps: 29.97 } } } }));
    expect(ntsc.manifest.output.fps).toBe('30000/1001');
    await client.callTool({ name: 'delete_project', arguments: { projectId: 'ntsc-fps' } });
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

  it('enforces the read scope on prompts and resources that read data (#426)', async () => {
    const writer = await connect((await server.service.keys.create('writer-only', ['write'])).key);
    // plan_reel lists templates and themes, like list_templates and list_themes: a key without read is refused.
    await expect(writer.getPrompt({ name: 'plan_reel', arguments: { brief: 'x' } })).rejects.toThrow(/read/);
    await expect(writer.getPrompt({ name: 'review_reel', arguments: { projectId: 'sample-reel' } })).rejects.toThrow(/read/);
    for (const uri of ['renderweld://templates', 'renderweld://schema/project', 'renderweld://projects/sample-reel']) {
      await expect(writer.readResource({ uri })).rejects.toThrow(/read/);
    }
    expect(json(await writer.callTool({ name: 'list_themes', arguments: {} })).error.code).toBe('forbidden');
    // Static guidance needs no scope: it reads nothing of the workspace.
    const make = await writer.getPrompt({ name: 'make_reel', arguments: { topic: 'a bakery opening' } });
    expect((make.messages[0]!.content as any).text).toContain('a bakery opening');
    expect((await writer.readResource({ uri: 'renderweld://guide/workflow' })).contents[0]).toMatchObject({ text: WORKFLOW_GUIDE });
    await writer.close();
  });

  it('exposes resources and prompts', async () => {
    const client = await connect(adminKey);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining(['renderweld://schema/project', 'renderweld://templates', 'renderweld://guide/workflow', 'renderweld://projects/sample-reel']));
    // Projects are listed once, under the new scheme.
    expect(resources.filter((r) => r.uri.endsWith('projects/sample-reel')).map((r) => r.uri)).toEqual(['renderweld://projects/sample-reel']);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((r) => r.uriTemplate)).toEqual(expect.arrayContaining(['renderweld://projects/{id}']));
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['brief_intake', 'make_reel', 'plan_reel', 'review_reel']);
    // Every resource answers under renderweld://; the old reelforge:// scheme is gone (#413).
    const schema = await client.readResource({ uri: 'renderweld://schema/project' });
    expect(schema.contents[0]!.uri).toBe('renderweld://schema/project');
    expect(JSON.parse((schema.contents[0] as any).text).type).toBe('object');
    const templates = await client.readResource({ uri: 'renderweld://templates' });
    expect(JSON.parse((templates.contents[0] as any).text).length).toBeGreaterThan(0);
    const project = await client.readResource({ uri: 'renderweld://projects/sample-reel' });
    expect(JSON.parse((project.contents[0] as any).text).manifest.projectId).toBe('sample-reel');
    const guide = await client.readResource({ uri: 'renderweld://guide/workflow' });
    expect((guide.contents[0] as any).text).toContain('render_project');
    expect(resources.filter((r) => !r.uri.startsWith('renderweld://')).map((r) => r.uri)).toEqual([]);
    await expect(client.readResource({ uri: 'reelforge://guide/workflow' })).rejects.toThrow();
    expect((await client.readResource({ uri: 'renderweld://guide/workflow' })).contents[0]).toMatchObject({ text: WORKFLOW_GUIDE });
    expect(client.getInstructions()).toContain('renderweld://guide/workflow');
    const make = await client.getPrompt({ name: 'make_reel', arguments: { topic: 'a bakery opening' } });
    expect((make.messages[0]!.content as any).text).toContain('a bakery opening');
    expect((make.messages[0]!.content as any).text).toContain('brief_intake');
    // brief_intake (#313): every essential, where its answer goes, and the rule to ask instead of assuming.
    const intake = await client.getPrompt({ name: 'brief_intake', arguments: { request: 'a 20 s reel for our bakery opening' } });
    const intakeText = (intake.messages[0]!.content as any).text as string;
    expect(intakeText).toContain('a 20 s reel for our bakery opening');
    expect(intakeText).toContain('Do not invent answers');
    for (const e of BRIEF_ESSENTIALS) expect(intakeText).toContain(e.question);
    expect(BRIEF_ESSENTIALS.map((e) => e.id)).toEqual(['goal', 'audience', 'platform', 'length', 'language', 'style', 'brand', 'captions', 'voice', 'music', 'content']);
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

describe('output variants over MCP (#287)', () => {
  it('VAR-11 render_project on a manifest with variants answers { job, jobs, batchId }; variant renders one', async () => {
    const client = await connect(adminKey);
    const manifest = {
      schemaVersion: '0.2',
      projectId: 'mcp-variants',
      title: 'variants',
      output: { width: 216, height: 384, fps: 30, format: 'mp4' },
      variants: [
        { id: 'vertical', width: 216, height: 384, platform: 'tiktok' },
        { id: 'square', width: 216, height: 216 },
      ],
      scenes: [{ id: 'hook', engine: 'remotion', template: 'kinetic-title', durationFrames: 45, props: { headline: 'Two formats' } }],
    };
    expect(json(await client.callTool({ name: 'create_project', arguments: { manifest } })).manifest.variants).toHaveLength(2);
    const r = json(await client.callTool({ name: 'render_project', arguments: { projectId: 'mcp-variants' } }));
    expect(r.jobs.map((j: any) => j.params.variant)).toEqual(['vertical', 'square']);
    expect(new Set(r.jobs.map((j: any) => j.params.runId)).size).toBe(2);
    for (const j of r.jobs) {
      const done = json(await client.callTool({ name: 'get_job', arguments: { jobId: j.id, waitSeconds: 30 } }));
      expect(done.status).toBe('succeeded');
      expect(done.result.height).toBe(j.params.variant === 'square' ? 216 : 384);
    }
    const one = json(await client.callTool({ name: 'render_project', arguments: { projectId: 'mcp-variants', variant: 'square' } }));
    expect(one.jobs).toBeUndefined();
    expect(one.job.params).toMatchObject({ variant: 'square' });
    await client.callTool({ name: 'delete_project', arguments: { projectId: 'mcp-variants' } });
    await client.close();
  }, 120_000);
});

// After the tests above, so sample-reel exists for review_reel.
describe('MCP server names (#413)', () => {
  it('introduces itself as RenderWeld in initialize, its instructions and its prompts (#413)', async () => {
    const client = await connect(adminKey);
    expect(client.getServerVersion()).toMatchObject({ name: 'renderweld', title: 'RenderWeld' });
    expect(client.getInstructions()).toMatch(/^RenderWeld renders short videos/);
    for (const [name, args] of [['make_reel', { topic: 'hooks' }], ['plan_reel', { brief: 'hooks' }], ['review_reel', { projectId: 'sample-reel' }]] as const) {
      const text = JSON.stringify((await client.getPrompt({ name, arguments: args })).messages);
      expect(text, name).toContain('RenderWeld');
      // review_reel quotes the project, whose sample title may name the old product.
      if (name !== 'review_reel') expect(text, name).not.toContain('ReelForge');
    }
    expect(WORKFLOW_GUIDE).toMatch(/^# RenderWeld: /);
  });
});
