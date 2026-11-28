import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RenderWeldService } from '@renderweld/core';
import type { Context, Hono } from 'hono';
import { errorBody, hostName, type Env } from './app';
import type { ServerConfig } from './config';

/**
 * The web dashboard (#292, D-115): static files built by apps/dashboard, served
 * same-origin under /dashboard when `dashboard.enabled` is on. The page is a
 * client of the public REST API: it holds no server-side session, sets no
 * cookie, and every data call carries the API key the person signed in with,
 * so the usual scopes, rate limits and audit log apply.
 */

/** Built assets: apps/dashboard/dist next to this app (the image copies it there). */
export const DEFAULT_DASHBOARD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard', 'dist');

/** No inline script or style, no other origin, no framing, no plugins, no forms posted anywhere. */
export const DASHBOARD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'", // the web app manifest from assets/ (#413)
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': DASHBOARD_CSP,
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

const TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  webmanifest: 'application/manifest+json',
};
/** Only the hashed files the build writes: no path separators, no dot segments. */
const ASSET = /^assets\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(js|css|svg|png|webmanifest))$/;

function enabled(service: RenderWeldService, config: ServerConfig): boolean {
  // The live settings (PATCH /v1/config applies dashboard.enabled without a restart), else file + env.
  return service.settings?.current.config.dashboard.enabled ?? config.resolved.config.dashboard.enabled;
}

export function mountDashboard(app: Hono<Env>, service: RenderWeldService, config: ServerConfig): void {
  const dir = () => config.dashboardAssetsDir ?? DEFAULT_DASHBOARD_DIR;

  const gate = (c: Context<Env>): Response | null => {
    if (!enabled(service, config)) {
      return c.json(errorBody('not_found', 'the dashboard is off: set dashboard.enabled (RENDERWELD_DASHBOARD_ENABLED=true, or PATCH /v1/config)'), 404);
    }
    // Same DNS-rebinding protection as /mcp: only our own host names.
    const host = hostName(c.req.header('host'));
    if (!config.allowedHosts.includes(host)) {
      return c.json(errorBody('forbidden_host', `host "${host}" is not allowed; set RENDERWELD_PUBLIC_URL or RENDERWELD_ALLOWED_HOSTS`), 403);
    }
    return null;
  };

  const file = async (c: Context<Env>, name: string, type: string, cache: string) => {
    let body: Buffer;
    try {
      body = await readFile(join(dir(), name));
    } catch {
      if (name !== 'index.html') return c.json(errorBody('not_found', `no dashboard file ${name}`), 404);
      return c.json(errorBody('dashboard_not_built', 'the dashboard assets are missing: run `pnpm --filter @renderweld/dashboard build` (the Docker image builds them)'), 503);
    }
    return c.body(new Uint8Array(body), 200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': cache });
  };

  app.get('/dashboard', (c) => gate(c) ?? c.redirect('/dashboard/', 308));
  app.get('/dashboard/*', async (c) => {
    const blocked = gate(c);
    if (blocked) return blocked;
    const rest = c.req.path.slice('/dashboard/'.length);
    if (rest === '' || rest === 'index.html') return file(c, 'index.html', 'text/html; charset=utf-8', 'no-cache');
    const m = ASSET.exec(rest);
    if (!m) return c.json(errorBody('not_found', `no dashboard file ${rest}`), 404);
    // File names carry a content hash, so a cached copy is never stale.
    return file(c, `assets/${m[1]}`, TYPES[m[2]!]!, 'public, max-age=31536000, immutable');
  });
}
