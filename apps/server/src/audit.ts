import type { AuditResult } from '@reelforge/core';
import { REST_ROUTES, type RouteEntry } from './routes';

/**
 * The transport side of the audit log (#65, D-055): REST and MCP both write
 * one entry per admin or write call, named after the MCP tool, unless the
 * service already wrote a more detailed one for that call (config.update,
 * key.rotate, ...). Request fields (key name, IP, user agent, request id) are
 * added by AuditLog from the request context.
 */

/** Tool names whose dotted action is not simply "<noun>.<verb>". */
const ACTION_NAMES: Record<string, string> = {
  add_asset_from_url: 'asset.import',
  list_audit_events: 'audit.list',
  generate_voice: 'provider.run',
  get_render_output: 'render.get',
};

/** create_project -> project.create, reorder_scenes -> scenes.reorder. */
export function auditAction(tool: string): string {
  if (ACTION_NAMES[tool]) return ACTION_NAMES[tool]!;
  const i = tool.indexOf('_');
  return i < 0 ? tool : `${tool.slice(i + 1)}.${tool.slice(0, i)}`;
}

/** REST route params (":id") under the MCP argument name, by the route's first path segment. */
const ID_ARG: Record<string, string> = { projects: 'projectId', themes: 'themeId', jobs: 'jobId', keys: 'keyId', providers: 'providerId', renders: 'renderId', assets: 'assetId' };

export function restArgs(path: string, params: Record<string, string>): Record<string, unknown> {
  const segment = path.split('/')[2] ?? '';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === 'method') continue;
    out[k === 'id' ? (ID_ARG[segment] ?? 'id') : k] = v;
  }
  return out;
}

const TARGETS: Array<[string, string]> = [
  ['keyId', 'key'],
  ['projectId', 'project'],
  ['jobId', 'job'],
  ['themeId', 'theme'],
  ['providerId', 'provider'],
  ['renderId', 'render'],
  ['assetId', 'asset'],
];

/** What a call acted on, from its arguments, else from its result (a created project, key or job). */
export function auditTarget(tool: string, args: Record<string, unknown>, result?: unknown): { targetType?: string; targetId?: string; data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  if (typeof args.sceneId === 'string') data.sceneId = args.sceneId;
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, any>;
  if (typeof r.job?.id === 'string') data.jobId = r.job.id;
  for (const [arg, type] of TARGETS) {
    if (typeof args[arg] === 'string' && args[arg]) return { targetType: type, targetId: args[arg] as string, data };
  }
  if (tool.endsWith('_theme') && typeof args.id === 'string') return { targetType: 'theme', targetId: args.id, data };
  if (typeof r.meta?.id === 'string') return { targetType: 'project', targetId: r.meta.id, data };
  if (typeof r.record?.id === 'string') return { targetType: 'key', targetId: r.record.id, data };
  if (typeof r.asset?.id === 'string') return { targetType: 'asset', targetId: r.asset.id, data };
  if (tool.endsWith('_theme') && typeof r.id === 'string') return { targetType: 'theme', targetId: r.id, data };
  if (typeof r.job?.id === 'string') return { targetType: 'job', targetId: r.job.id, data };
  if (tool.endsWith('_config')) return { targetType: 'config', data };
  if (tool.endsWith('_licence')) return { targetType: 'licence', data };
  return { data };
}

export function resultOf(status: number): AuditResult {
  if (status < 400) return 'success';
  return status === 401 || status === 403 ? 'denied' : 'failure';
}

// ---- REST route matching ------------------------------------------------------

interface CompiledRoute {
  entry: RouteEntry;
  re: RegExp;
  names: string[];
}
let compiled: CompiledRoute[] | null = null;

function compile(): CompiledRoute[] {
  return REST_ROUTES.map((entry) => {
    const names: string[] = [];
    const src = entry.path.replace(/:(\w+)(\{[^}]+\})?|[.*+?^$()|[\]\\]/g, (m, name: string | undefined, custom: string | undefined) => {
      if (!name) return `\\${m}`;
      names.push(name);
      return custom ? `(${custom.slice(1, -1)})` : '([^/]+)';
    });
    return { entry, re: new RegExp(`^${src}$`), names };
  });
}

/** The route-table entry of a REST request, with its params. */
export function matchRoute(method: string, path: string): { entry: RouteEntry; params: Record<string, string> } | null {
  compiled ??= compile();
  for (const r of compiled) {
    if (r.entry.method !== method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.names.forEach((n, i) => {
      try {
        params[n] = decodeURIComponent(m[i + 1]!);
      } catch {
        params[n] = m[i + 1]!;
      }
    });
    return { entry: r.entry, params };
  }
  return null;
}
