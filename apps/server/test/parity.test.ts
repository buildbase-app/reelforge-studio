import { describe, expect, it } from 'vitest';
import { createApp, INFRA_ROUTES, loadConfig, REST_ROUTES, TOOL_ALIASES, TOOLS } from '../src/index';

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

  it('create and render calls take an idempotency key in MCP (the REST routes read the Idempotency-Key header)', () => {
    for (const t of ['create_project', 'create_theme', 'add_scene', 'render_project', 'preview_scene', 'retry_job', 'run_provider', 'generate_voice', 'add_asset_from_url']) {
      expect(Object.keys(tools.get(t)!.input), t).toContain('idempotencyKey');
    }
    // Calls that return a secret never store their result.
    for (const t of ['create_key', 'rotate_key']) expect(Object.keys(tools.get(t)!.input)).not.toContain('idempotencyKey');
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
