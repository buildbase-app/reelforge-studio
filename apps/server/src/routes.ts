/**
 * The REST route table and the MCP tool that offers the same capability.
 * test/parity.test.ts checks this table against the routes the app really
 * registers and the tools the MCP server really lists, so REST and MCP cannot
 * drift apart: every REST capability has an MCP tool.
 *
 * `path` is the Hono pattern; `display` is how docs write it.
 */
export interface RouteEntry {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  display?: string;
  scope: 'read' | 'write' | 'render' | 'admin';
  tool: string;
  /** How the MCP tool differs, when it does. */
  note?: string;
}

export const REST_ROUTES: RouteEntry[] = [
  { method: 'GET', path: '/v1/capabilities', scope: 'read', tool: 'get_capabilities' },
  { method: 'GET', path: '/v1/schema/project', scope: 'read', tool: 'get_project_schema' },
  { method: 'GET', path: '/v1/templates', scope: 'read', tool: 'list_templates' },
  { method: 'GET', path: '/v1/themes', scope: 'read', tool: 'list_themes' },
  { method: 'POST', path: '/v1/themes', scope: 'write', tool: 'create_theme' },
  { method: 'GET', path: '/v1/themes/:id', scope: 'read', tool: 'get_theme' },
  { method: 'PUT', path: '/v1/themes/:id', scope: 'write', tool: 'update_theme' },
  { method: 'DELETE', path: '/v1/themes/:id', scope: 'write', tool: 'delete_theme' },
  { method: 'GET', path: '/v1/projects', scope: 'read', tool: 'list_projects' },
  { method: 'POST', path: '/v1/projects', scope: 'write', tool: 'create_project' },
  { method: 'GET', path: '/v1/projects/:id', scope: 'read', tool: 'get_project' },
  { method: 'PATCH', path: '/v1/projects/:id', scope: 'write', tool: 'update_project' },
  { method: 'DELETE', path: '/v1/projects/:id', scope: 'write', tool: 'delete_project' },
  { method: 'GET', path: '/v1/projects/:id/versions', scope: 'read', tool: 'list_project_versions' },
  { method: 'POST', path: '/v1/projects/:id/validate', scope: 'read', tool: 'validate_project' },
  { method: 'POST', path: '/v1/projects/:id/scenes', scope: 'write', tool: 'add_scene' },
  { method: 'POST', path: '/v1/projects/:id/:method{scenes:reorder}', display: '/v1/projects/:id/scenes:reorder', scope: 'write', tool: 'reorder_scenes' },
  { method: 'PATCH', path: '/v1/projects/:id/scenes/:sceneId', scope: 'write', tool: 'update_scene' },
  { method: 'DELETE', path: '/v1/projects/:id/scenes/:sceneId', scope: 'write', tool: 'remove_scene' },
  { method: 'PUT', path: '/v1/projects/:id/theme', scope: 'write', tool: 'set_theme' },
  { method: 'PATCH', path: '/v1/projects/:id/audio', scope: 'write', tool: 'set_audio' },
  { method: 'POST', path: '/v1/projects/:id/preview', scope: 'render', tool: 'preview_scene' },
  { method: 'POST', path: '/v1/projects/:id/renders', scope: 'render', tool: 'render_project' },
  { method: 'GET', path: '/v1/projects/:id/renders', scope: 'read', tool: 'list_renders' },
  { method: 'GET', path: '/v1/jobs', scope: 'read', tool: 'list_jobs' },
  { method: 'GET', path: '/v1/jobs/:id', scope: 'read', tool: 'get_job' },
  { method: 'POST', path: '/v1/jobs/:id/cancel', scope: 'render', tool: 'cancel_job' },
  { method: 'POST', path: '/v1/jobs/:id/retry', scope: 'render', tool: 'retry_job' },
  { method: 'GET', path: '/v1/jobs/:id/logs', scope: 'read', tool: 'get_job_logs' },
  { method: 'GET', path: '/v1/jobs/:id/events', scope: 'read', tool: 'get_job', note: 'SSE stream in REST; MCP clients poll get_job.' },
  { method: 'GET', path: '/v1/renders/:id', scope: 'read', tool: 'get_render_output' },
  {
    method: 'GET',
    path: '/v1/renders/:id/output',
    scope: 'read',
    tool: 'get_render_output',
    note: 'REST streams the file; the MCP tool returns its download URL (same Bearer key) plus a poster image, because MCP results are not meant for large binaries.',
  },
  { method: 'GET', path: '/v1/assets', scope: 'read', tool: 'list_assets' },
  { method: 'GET', path: '/v1/assets/:id', scope: 'read', tool: 'get_asset' },
  {
    method: 'POST',
    path: '/v1/assets',
    scope: 'write',
    tool: 'upload_asset',
    note: 'Multipart upload in REST; base64 (a few MB) in MCP. JSON {url} maps to add_asset_from_url.',
  },
  { method: 'GET', path: '/v1/providers', scope: 'read', tool: 'list_providers' },
  { method: 'PUT', path: '/v1/providers/:id/config', scope: 'admin', tool: 'configure_provider' },
  { method: 'POST', path: '/v1/providers/:id/run', scope: 'render', tool: 'run_provider', note: 'generate_voice is a TTS shortcut.' },
  { method: 'GET', path: '/v1/keys', scope: 'admin', tool: 'list_keys' },
  { method: 'POST', path: '/v1/keys', scope: 'admin', tool: 'create_key' },
  { method: 'DELETE', path: '/v1/keys/:id', scope: 'admin', tool: 'delete_key' },
];

/** Routes outside /v1 that are infrastructure, not product capabilities. */
export const INFRA_ROUTES = ['GET /healthz', 'GET /readyz', 'GET /.well-known/mcp.json', 'ALL /mcp'];

/** MCP tools whose REST counterpart is a variant of a route above. */
export const TOOL_ALIASES: Record<string, string> = {
  add_asset_from_url: 'POST /v1/assets',
  generate_voice: 'POST /v1/providers/:id/run',
};
