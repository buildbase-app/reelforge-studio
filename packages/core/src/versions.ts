import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Installed version of a package, resolved the way Node would load it from
 * `fromUrl` (pass `import.meta.url`). Works with pnpm's nested layout and
 * hoisted installs alike; returns "unknown" if the package is missing.
 */
export function packageVersion(name: string, fromUrl: string): string {
  const require = createRequire(fromUrl);
  try {
    return (JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version;
  } catch {
    // Packages whose "exports" hide package.json: walk up from the entry point.
    try {
      let dir = dirname(require.resolve(name));
      for (let i = 0; i < 6; i++) {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version: string };
          if (pkg.name === name) return pkg.version;
        } catch {
          // keep walking
        }
        dir = dirname(dir);
      }
    } catch {
      // not installed
    }
    return 'unknown';
  }
}

const browserVersions = new Map<string, string>();

/** "Google Chrome for Testing 157.0.8103.78" etc., from `<binary> --version`. Cached. */
export function browserVersion(binary: string | undefined): string | undefined {
  if (!binary) return undefined;
  const cached = browserVersions.get(binary);
  if (cached) return cached;
  const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  const v = (r.stdout ?? '').trim().split('\n')[0] || undefined;
  if (v) browserVersions.set(binary, v);
  return v;
}

/**
 * Whether engines start Chromium with its own sandbox: on, unless the operator
 * sets RENDERWELD_CHROMIUM_NO_SANDBOX=1 or we run as root (Chromium refuses).
 * In Docker the sandbox needs user namespaces, which Docker's default seccomp
 * profile blocks: run with deployment/seccomp/chrome.json (docs/DEPLOY.md).
 * Remotion always passes --no-sandbox itself, so it is unsandboxed either way.
 */
export function chromiumSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.RENDERWELD_CHROMIUM_NO_SANDBOX === '1') return false;
  return typeof process.getuid !== 'function' || process.getuid() !== 0;
}

/** Default and upper bound of render.sceneTimeoutSeconds (D-087). */
export const SCENE_TIMEOUT_DEFAULT_SECONDS = 900;
export const SCENE_TIMEOUT_MAX_SECONDS = 3600;

/**
 * The hard limit for rendering one scene, whatever its length: engines use
 * min(their per-frame estimate, this). From RENDERWELD_RENDER_SCENE_TIMEOUT_SECONDS
 * (render.sceneTimeoutSeconds, exported to process.env by the server), clamped
 * to 30 s .. 1 h.
 */
export function sceneTimeoutCapMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RENDERWELD_RENDER_SCENE_TIMEOUT_SECONDS);
  const s = Number.isFinite(raw) && raw > 0 ? raw : SCENE_TIMEOUT_DEFAULT_SECONDS;
  return Math.round(Math.min(SCENE_TIMEOUT_MAX_SECONDS, Math.max(30, s)) * 1000);
}
