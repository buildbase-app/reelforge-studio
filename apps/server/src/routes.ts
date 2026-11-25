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
  /** `owner`: instance-level (#304); `admin`: the key's own workspace. */
  scope: 'read' | 'write' | 'render' | 'admin' | 'owner';
  tool: string;
  /** How the MCP tool differs, when it does. */
  note?: string;
}

export const REST_ROUTES: RouteEntry[] = [
  { method: 'GET', path: '/v1/capabilities', scope: 'read', tool: 'get_capabilities' },
  { method: 'GET', path: '/v1/me', scope: 'read', tool: 'get_me' },
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
  { method: 'POST', path: '/v1/projects/:id/captions/import', scope: 'write', tool: 'import_captions' },
  { method: 'GET', path: '/v1/projects/:id/captions', scope: 'read', tool: 'get_captions' },
  { method: 'PATCH', path: '/v1/projects/:id/captions', scope: 'write', tool: 'update_captions', note: 'REST takes the etag in the body or as If-Match; expectedVersion in the body or query.' },
  { method: 'POST', path: '/v1/projects/:id/captions/transcribe', scope: 'render', tool: 'transcribe_captions' },
  { method: 'POST', path: '/v1/projects/:id/preview', scope: 'render', tool: 'preview_scene' },
  { method: 'POST', path: '/v1/projects/:id/render-plan', scope: 'read', tool: 'plan_render' },
  { method: 'POST', path: '/v1/projects/:id/renders', scope: 'render', tool: 'render_project' },
  { method: 'GET', path: '/v1/projects/:id/renders', scope: 'read', tool: 'list_renders' },
  { method: 'GET', path: '/v1/jobs', scope: 'read', tool: 'list_jobs', note: 'Filters: ?projectId= and ?parentId= (the units and the join of a fanned-out render).' },
  { method: 'GET', path: '/v1/jobs/:id', scope: 'read', tool: 'get_job' },
  { method: 'POST', path: '/v1/jobs/:id/cancel', scope: 'render', tool: 'cancel_job' },
  { method: 'POST', path: '/v1/jobs/:id/retry', scope: 'render', tool: 'retry_job' },
  { method: 'GET', path: '/v1/jobs/:id/logs', scope: 'read', tool: 'get_job_logs' },
  { method: 'GET', path: '/v1/jobs/:id/events', scope: 'read', tool: 'get_job', note: 'SSE stream in REST; MCP clients call get_job with waitSeconds (long-poll).' },
  { method: 'GET', path: '/v1/renders/:id', scope: 'read', tool: 'get_render_output' },
  { method: 'GET', path: '/v1/renders/:id/captions', scope: 'read', tool: 'get_captions', note: 'MCP: get_captions with renderId.' },
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
  { method: 'PUT', path: '/v1/providers/:id/config', scope: 'owner', tool: 'configure_provider' },
  { method: 'POST', path: '/v1/providers/:id/run', scope: 'render', tool: 'run_provider', note: 'generate_voice is a TTS shortcut.' },
  { method: 'GET', path: '/v1/config', scope: 'owner', tool: 'get_config' },
  { method: 'PATCH', path: '/v1/config', scope: 'owner', tool: 'update_config' },
  { method: 'GET', path: '/v1/licence', scope: 'read', tool: 'get_licence' },
  { method: 'POST', path: '/v1/licence', scope: 'owner', tool: 'activate_licence' },
  { method: 'DELETE', path: '/v1/licence', scope: 'owner', tool: 'deactivate_licence' },
  {
    method: 'GET',
    path: '/v1/analytics/summary',
    scope: 'read',
    tool: 'get_analytics_summary',
    note: 'Query ?from=&to= (ISO time or UTC date; at most 90 days) and ?bucket=day|hour (hour: at most 7 days).',
  },
  { method: 'GET', path: '/v1/storage', scope: 'owner', tool: 'get_storage' },
  { method: 'POST', path: '/v1/storage/cleanup', scope: 'owner', tool: 'run_storage_cleanup' },
  { method: 'GET', path: '/v1/keys', scope: 'admin', tool: 'list_keys' },
  { method: 'POST', path: '/v1/keys', scope: 'admin', tool: 'create_key' },
  { method: 'GET', path: '/v1/keys/:id', scope: 'admin', tool: 'get_key' },
  { method: 'PATCH', path: '/v1/keys/:id', scope: 'admin', tool: 'update_key' },
  { method: 'POST', path: '/v1/keys/:id/rotate', scope: 'admin', tool: 'rotate_key' },
  { method: 'POST', path: '/v1/keys/:id/revoke', scope: 'admin', tool: 'revoke_key' },
  { method: 'DELETE', path: '/v1/keys/:id', scope: 'admin', tool: 'delete_key' },
  { method: 'GET', path: '/v1/workspace', scope: 'read', tool: 'get_workspace' },
  { method: 'GET', path: '/v1/workspaces', scope: 'owner', tool: 'list_workspaces' },
  { method: 'POST', path: '/v1/workspaces', scope: 'owner', tool: 'create_workspace' },
  { method: 'PATCH', path: '/v1/workspaces/:id', scope: 'owner', tool: 'update_workspace' },
  { method: 'DELETE', path: '/v1/workspaces/:id', scope: 'owner', tool: 'delete_workspace' },
  { method: 'POST', path: '/v1/workspaces/:id/restore', scope: 'owner', tool: 'restore_workspace' },
  { method: 'GET', path: '/v1/webhooks', scope: 'admin', tool: 'list_webhooks' },
  { method: 'POST', path: '/v1/webhooks', scope: 'admin', tool: 'create_webhook' },
  { method: 'GET', path: '/v1/webhooks/:id', scope: 'admin', tool: 'get_webhook' },
  { method: 'PATCH', path: '/v1/webhooks/:id', scope: 'admin', tool: 'update_webhook' },
  { method: 'DELETE', path: '/v1/webhooks/:id', scope: 'admin', tool: 'delete_webhook' },
  { method: 'POST', path: '/v1/webhooks/:id/test', scope: 'admin', tool: 'test_webhook' },
  { method: 'GET', path: '/v1/webhooks/:id/deliveries', scope: 'admin', tool: 'list_webhook_deliveries' },
  { method: 'POST', path: '/v1/webhooks/:id/deliveries/:deliveryId/replay', scope: 'admin', tool: 'replay_webhook_delivery' },
  { method: 'POST', path: '/v1/webhooks/:id/resend', scope: 'admin', tool: 'resend_webhook' },
  { method: 'POST', path: '/v1/webhooks/:id/rotate-secret', scope: 'admin', tool: 'rotate_webhook_secret' },
  {
    method: 'GET',
    path: '/v1/webhooks/:id/log',
    scope: 'read',
    tool: 'get_webhook_log',
    note: 'The delivery log without payloads or targets (status, attempts, latency); list_webhook_deliveries (admin) has the payloads.',
  },
  {
    method: 'GET',
    path: '/v1/audit',
    scope: 'admin',
    tool: 'list_audit_events',
    note: 'REST ?format=jsonl|csv streams an export (up to 100 000 entries); the MCP tool returns up to 10 000 in one result. Owner keys: ?workspaceId=<id>|* (json pages).',
  },
];

/** Routes outside /v1 that are infrastructure, not product capabilities. */
export const INFRA_ROUTES = ['GET /healthz', 'GET /readyz', 'GET /metrics', 'GET /.well-known/mcp.json', 'ALL /mcp', 'GET /dashboard',
  // OAuth protected-resource metadata for /mcp (RFC 9728, D-112): discovery, not a product capability.
  'GET /.well-known/oauth-protected-resource', 'GET /.well-known/oauth-protected-resource/mcp'];

/** MCP tools whose REST counterpart is a variant of a route above. */
export const TOOL_ALIASES: Record<string, string> = {
  add_asset_from_url: 'POST /v1/assets',
  generate_voice: 'POST /v1/providers/:id/run',
};
