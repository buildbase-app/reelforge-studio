import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, runInWorkspace, type WorkspaceRouter } from '@renderweld/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/** render.approval (#485): render_project needs a single-use token from approve_render_plan when the setting says so. */
const { dir, cleanup } = tempDir('renderweld-approval-');
let server: StartedServer;
let dropDb: () => Promise<void> = async () => undefined;
const keys = { owner: '', renderer: '', approver: '', reader: '' };

const reel = (projectId: string, headline = 'One') => ({
  schemaVersion: '0.2',
  projectId,
  title: projectId,
  output: { width: 320, height: 568, fps: 30, format: 'mp4' },
  scenes: [{ id: 'one', engine: 'remotion', template: 'kinetic-title', durationFrames: 45, props: { headline } }],
});
const rest = async (method: string, path: string, body: unknown, key: string) => {
  const r = await fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : {} };
};
const mcp = async (name: string, args: Record<string, unknown>, key: string) => {
  const r = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = ((await r.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
  return { isError: Boolean(res.isError), json: JSON.parse(res.content[0]!.text) };
};
const setMode = (settings: Record<string, unknown>) => rest('PATCH', '/v1/config', settings, keys.owner);
const plan = async (projectId: string) => (await rest('POST', `/v1/projects/${projectId}/render-plan`, {}, keys.reader)).json;
const approve = (projectId: string, planId: string, key = keys.approver) => rest('POST', `/v1/projects/${projectId}/render-plan/approve`, { planId }, key);
const render = (projectId: string, approvalToken?: string) => rest('POST', `/v1/projects/${projectId}/renders`, approvalToken ? { approvalToken } : {}, keys.renderer);
/**
 * Waits for the job to finish and, when it succeeded, to be stored: get_job answers from the worker's live state,
 * and a plan reads the stored successful renders, which on a slower database trail it by a few milliseconds.
 */
async function finish(jobId: string) {
  for (let i = 0; i < 300; i++) {
    const j = (await rest('GET', `/v1/jobs/${jobId}?wait=10`, undefined, keys.owner)).json;
    if (j.status === 'succeeded') {
      for (let k = 0; k < 100; k++) {
        const { jobs } = (await rest('GET', '/v1/jobs?status=succeeded&type=render', undefined, keys.owner)).json as { jobs: Array<{ id: string }> };
        if (jobs.some((x) => x.id === jobId)) return j;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`job ${jobId} was never stored as succeeded`);
    }
    if (['failed', 'cancelled'].includes(j.status)) return j;
  }
  throw new Error('job did not finish');
}

beforeAll(async () => {
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer(
    { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' },
    {
      registry: new PluginRegistry().registerEngine(fakeEngine('remotion')),
      env: { ...database.env, RENDERWELD_LICENCE_MODE: 'off', RENDERWELD_RATE_LIMIT_PER_MINUTE: '0', RENDERWELD_PRE_AUTH_RATE_LIMIT_PER_MINUTE: '0', RENDERWELD_SECRET_KEY: 'render-approval-secret-key-0123456789abc' },
      quiet: true,
    }
  );
  keys.owner = (await server.service.keys.create('owner', ['admin', 'owner'])).key;
  keys.renderer = (await server.service.keys.create('agent', ['read', 'write', 'render'])).key;
  keys.approver = (await server.service.keys.create('approver', ['read', 'approve'])).key;
  keys.reader = (await server.service.keys.create('reader', ['read'])).key;
  for (const id of ['alpha', 'beta']) expect((await rest('POST', '/v1/projects', { manifest: reel(id) }, keys.owner)).status).toBe(201);
}, 60_000);
afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

describe('render approval', () => {
  it('APR-01 off by default: render_project needs no token', async () => {
    const r = await render('alpha');
    expect(r.status).toBe(202);
    expect((await finish(r.json.job.id)).status).toBe('succeeded');
  }, 120_000);

  it('APR-02 always: 409 approval_required with the plan; an approve key mints a single-use token that starts one render', async () => {
    expect((await setMode({ 'render.approval.mode': 'always' })).status).toBe(200);
    const refused = await render('alpha');
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('approval_required');
    expect(refused.json.error.message).toContain('approve_render_plan');
    const p = await plan('alpha');
    expect(refused.json.error.details.plan.planId).toBe(p.planId);
    // Who may approve: approve, admin and owner; not read or render.
    expect((await approve('alpha', p.planId, keys.reader)).status).toBe(403);
    expect((await approve('alpha', p.planId, keys.renderer)).status).toBe(403);
    const ok = await approve('alpha', p.planId);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ planId: p.planId, projectVersion: 1 });
    expect(ok.json.approvalToken).toMatch(/^rap\./);
    expect(Date.parse(ok.json.expiresAt)).toBeGreaterThan(Date.now());
    const started = await render('alpha', ok.json.approvalToken);
    expect(started.status).toBe(202);
    const again = await render('alpha', ok.json.approvalToken);
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('approval_used');
    expect((await finish(started.json.job.id)).status).toBe('succeeded');
    // The approval is in the audit log, without the token.
    const audit = await rest('GET', '/v1/audit?action=render.approve', undefined, keys.owner);
    expect(JSON.stringify(audit.json)).toContain(p.planId);
    expect(JSON.stringify(audit.json)).not.toContain(ok.json.approvalToken);
  }, 120_000);

  it('APR-03 a token is only for its project and plan: another project, a changed project or a forged token is refused', async () => {
    const p = await plan('alpha');
    const token = (await approve('alpha', p.planId)).json.approvalToken as string;
    expect((await render('beta', token)).json.error.code).toBe('approval_invalid');
    const forged = token.replace(/\.(\d+)\./, (_m, exp) => `.${Number(exp) + 3600}.`);
    expect((await render('alpha', forged)).json.error.code).toBe('approval_invalid');
    expect((await render('alpha', 'rap.not-a-token')).json.error.code).toBe('approval_invalid');
    // The project changes: the token and the old plan id no longer apply.
    expect((await rest('PATCH', '/v1/projects/alpha', { title: 'Alpha, edited' }, keys.owner)).status).toBe(200);
    expect((await render('alpha', token)).json.error.code).toBe('approval_invalid');
    const stale = await approve('alpha', p.planId);
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('plan_changed');
    expect((await approve('alpha', 'not-a-plan')).status).toBe(400);
  });

  it('APR-04 above: under the threshold no token is needed; over it, or with no estimate, it is', async () => {
    expect((await setMode({ 'render.approval.mode': 'above', 'render.approval.aboveSeconds': 1_000_000 })).status).toBe(200);
    const under = await render('alpha');
    expect(under.status).toBe(202);
    await finish(under.json.job.id);
    expect((await setMode({ 'render.approval.aboveSeconds': 1 })).status).toBe(200);
    // A 1080x1920 output of the same project: about eleven times the pixels, so well over 1 s.
    expect((await rest('PATCH', '/v1/projects/alpha', { output: { width: 1080, height: 1920, fps: 30, format: 'mp4' } }, keys.owner)).status).toBe(200);
    const est = (await plan('alpha')).total.renderSeconds;
    expect(est).toBeGreaterThan(1);
    const over = await render('alpha');
    expect(over.status).toBe(409);
    expect(over.json.error.code).toBe('approval_required');
    expect(over.json.error.message).toContain('is over 1 s');
    // A workspace with no render yet has no estimate (null), so above asks for an approval there.
    const repos = server.service.repos as unknown as WorkspaceRouter;
    await repos.workspaces.create({ id: 'fresh', name: 'fresh', status: 'active', createdAt: new Date().toISOString() });
    repos.invalidateWorkspaces();
    const freshKey = (await runInWorkspace('fresh', () => server.service.keys.create('fresh-agent', ['read', 'write', 'render']))).key;
    expect((await rest('POST', '/v1/projects', { manifest: reel('first') }, freshKey)).status).toBe(201);
    const first = await rest('POST', '/v1/projects/first/renders', {}, freshKey);
    expect(first.status).toBe(409);
    expect(first.json.error.message).toContain('cannot be estimated yet');
  });

  it('APR-06 a token works only in its own workspace; MCP create_key offers the approve scope', async () => {
    expect((await setMode({ 'render.approval.mode': 'always' })).status).toBe(200);
    // The same project id in another workspace: the default workspace's token is refused there.
    const repos = server.service.repos as unknown as WorkspaceRouter;
    await repos.workspaces.create({ id: 'other', name: 'other', status: 'active', createdAt: new Date().toISOString() });
    repos.invalidateWorkspaces();
    const otherKey = (await runInWorkspace('other', () => server.service.keys.create('other-agent', ['read', 'write', 'render']))).key;
    expect((await rest('POST', '/v1/projects', { manifest: reel('beta') }, otherKey)).status).toBe(201);
    const p = await plan('beta');
    const token = (await approve('beta', p.planId)).json.approvalToken as string;
    const elsewhere = await rest('POST', '/v1/projects/beta/renders', { approvalToken: token }, otherKey);
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.json.error.code).toBe('approval_invalid');
    // The token was not spent by the refused call: it still starts the render in its own workspace.
    const started = await render('beta', token);
    expect(started.status).toBe(202);
    expect((await finish(started.json.job.id)).status).toBe('succeeded');
    // An admin creates an approve-only key over MCP, as over REST.
    const created = await mcp('create_key', { name: 'approver-2', scopes: ['approve'] }, keys.owner);
    expect(created.isError).toBe(false);
    expect(created.json.record?.scopes ?? created.json.scopes).toEqual(['approve']);
  }, 120_000);

  it('APR-05 MCP: render_project refuses without a token, approve_render_plan mints one, render_project takes it', async () => {
    expect((await setMode({ 'render.approval.mode': 'always' })).status).toBe(200);
    const refused = await mcp('render_project', { projectId: 'beta' }, keys.renderer);
    expect(refused.isError).toBe(true);
    expect(refused.json.error.code).toBe('approval_required');
    const planId = refused.json.error.details.plan.planId as string;
    const approved = await mcp('approve_render_plan', { projectId: 'beta', planId }, keys.approver);
    expect(approved.isError).toBe(false);
    const started = await mcp('render_project', { projectId: 'beta', approvalToken: approved.json.approvalToken }, keys.renderer);
    expect(started.isError).toBe(false);
    expect((await finish(started.json.job.id)).status).toBe('succeeded');
    expect((await setMode({ 'render.approval.mode': null, 'render.approval.aboveSeconds': null })).status).toBe(200);
  }, 120_000);
});
