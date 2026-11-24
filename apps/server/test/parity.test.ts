import { describe, expect, it } from 'vitest';
import { createApp, INFRA_ROUTES, loadConfig, REST_ROUTES, RESOURCE_SCHEMES, RESOURCES, serverCard, TOOL_ALIASES, TOOLS } from '../src/index';

/** Every REST capability has an MCP tool, and every MCP tool maps back to REST. */
describe('REST / MCP parity', () => {
  const app = createApp({ service: {} as never, config: loadConfig({}) });
  const registered = [...new Set(app.routes.filter((r) => r.method !== 'ALL' || r.path === '/mcp').map((r) => `${r.method} ${r.path}`))].filter(
    (r) => !r.endsWith('/*')
  );
  const table = REST_ROUTES.map((r) => `${r.method} ${r.path}`);
  const tools = new Map(TOOLS.map((t) => [t.name, t]));

  it('the route table lists exactly the routes the app registers', () => {
    const product = registered.filter((r) => !INFRA_ROUTES.includes(r));
    expect([...product].sort()).toEqual([...table].sort());
  });

  it('every REST route maps to an MCP tool with the same scope', () => {
    for (const r of REST_ROUTES) {
      const tool = tools.get(r.tool);
      expect(tool, `${r.method} ${r.path} -> ${r.tool}`).toBeDefined();
      expect(tool!.scope, `${r.tool} scope`).toBe(r.scope);
    }
  });

  it('every API key lifecycle action and the audit log are offered over both REST and MCP (#65)', () => {
    const expected: Record<string, string> = {
      list_keys: 'GET /v1/keys',
      create_key: 'POST /v1/keys',
      get_key: 'GET /v1/keys/:id',
      update_key: 'PATCH /v1/keys/:id',
      rotate_key: 'POST /v1/keys/:id/rotate',
      revoke_key: 'POST /v1/keys/:id/revoke',
      delete_key: 'DELETE /v1/keys/:id',
      list_audit_events: 'GET /v1/audit',
    };
    for (const [tool, route] of Object.entries(expected)) {
      expect(tools.get(tool)?.scope, tool).toBe('admin');
      expect(REST_ROUTES.find((r) => `${r.method} ${r.path}` === route)?.tool, route).toBe(tool);
      expect(registered).toContain(route);
    }
  });

  it('every webhook action is offered over both REST and MCP with the admin scope (#66)', () => {
    const expected: Record<string, string> = {
      list_webhooks: 'GET /v1/webhooks',
      create_webhook: 'POST /v1/webhooks',
      get_webhook: 'GET /v1/webhooks/:id',
      update_webhook: 'PATCH /v1/webhooks/:id',
      delete_webhook: 'DELETE /v1/webhooks/:id',
      test_webhook: 'POST /v1/webhooks/:id/test',
      list_webhook_deliveries: 'GET /v1/webhooks/:id/deliveries',
      replay_webhook_delivery: 'POST /v1/webhooks/:id/deliveries/:deliveryId/replay',
      resend_webhook: 'POST /v1/webhooks/:id/resend',
      rotate_webhook_secret: 'POST /v1/webhooks/:id/rotate-secret',
    };
    for (const [tool, route] of Object.entries(expected)) {
      expect(tools.get(tool)?.scope, tool).toBe('admin');
      expect(REST_ROUTES.find((r) => `${r.method} ${r.path}` === route)?.tool, route).toBe(tool);
      expect(registered).toContain(route);
    }
    // Their results contain a signing secret: never stored as an idempotent result.
    for (const t of ['create_webhook', 'update_webhook', 'rotate_webhook_secret']) expect(Object.keys(tools.get(t)!.input)).not.toContain('idempotencyKey');
    // The delivery log without payloads or targets is readable with the read scope (#306).
    expect(tools.get('get_webhook_log')?.scope).toBe('read');
    expect(REST_ROUTES.find((r) => `${r.method} ${r.path}` === 'GET /v1/webhooks/:id/log')).toMatchObject({ tool: 'get_webhook_log', scope: 'read' });
    expect(registered).toContain('GET /v1/webhooks/:id/log');
  });

  it('create and render calls take an idempotency key in MCP (the REST routes read the Idempotency-Key header)', () => {
    for (const t of ['create_project', 'create_theme', 'add_scene', 'render_project', 'preview_scene', 'retry_job', 'run_provider', 'generate_voice', 'add_asset_from_url']) {
      expect(Object.keys(tools.get(t)!.input), t).toContain('idempotencyKey');
    }
    // Calls that return a secret never store their result.
    for (const t of ['create_key', 'rotate_key']) expect(Object.keys(tools.get(t)!.input)).not.toContain('idempotencyKey');
  });

  it('every MCP resource has a renderweld:// URI and its old reelforge:// alias, and the server card names both (#412)', () => {
    expect([...RESOURCE_SCHEMES]).toEqual(['renderweld', 'reelforge']);
    const card = serverCard({ serverVersion: '0.0.0' } as never, loadConfig({}));
    expect(card.resources).toEqual(RESOURCES.map((r) => `renderweld://${r.path}`));
    expect(card.resources).toEqual(['renderweld://guide/workflow', 'renderweld://schema/project', 'renderweld://templates', 'renderweld://projects/{id}']);
    for (const r of RESOURCES) expect(card.resourceAliases[`reelforge://${r.path}`]).toBe(`renderweld://${r.path}`);
    // The data resources have the same REST reads.
    for (const route of ['GET /v1/schema/project', 'GET /v1/templates', 'GET /v1/projects/:id']) expect(table).toContain(route);
    // Tool names do not change with the rename.
    for (const t of TOOLS) expect(t.name).not.toMatch(/renderweld|reelforge/i);
  });

  it('every MCP tool maps back to a REST route', () => {
    const covered = new Set(REST_ROUTES.map((r) => r.tool));
    for (const name of tools.keys()) {
      if (covered.has(name)) continue;
      expect(TOOL_ALIASES[name], `tool ${name} has no REST route`).toBeDefined();
      expect(table).toContain(TOOL_ALIASES[name]);
    }
  });
});
