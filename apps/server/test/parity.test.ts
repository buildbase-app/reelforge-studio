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

  it('every MCP tool maps back to a REST route', () => {
    const covered = new Set(REST_ROUTES.map((r) => r.tool));
    for (const name of tools.keys()) {
      if (covered.has(name)) continue;
      expect(TOOL_ALIASES[name], `tool ${name} has no REST route`).toBeDefined();
      expect(table).toContain(TOOL_ALIASES[name]);
    }
  });
});
