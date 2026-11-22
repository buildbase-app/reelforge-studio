import { SETTINGS, envNames } from './config/schema';

/**
 * Environment hygiene for render child processes (D-086).
 *
 * Browsers, the HyperFrames CLI and FFmpeg never need the server's secrets
 * (database URL, REELFORGE_SECRET_KEY, provider and licence keys, storage
 * credentials, cloud SDK credentials). Engines that start a process
 * themselves pass `renderChildEnv()`: an allowlist, so a secret under a name
 * we do not know about is not passed either. Libraries that spawn with
 * `process.env` (Remotion) are covered by `scrubSecretEnv()`, which the
 * server entry point runs on its own process environment after the
 * configuration has been read from a copy.
 */

/** Exact names and `PREFIX*` patterns a render child process may see. */
export const RENDER_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'LC_*',
  'TZ',
  'TZDIR',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_*',
  'FONTCONFIG_FILE',
  'FONTCONFIG_PATH',
  'LD_LIBRARY_PATH',
  'DISPLAY',
  'CHROME_DEVEL_SANDBOX',
  'FFMPEG_PATH',
  'FFPROBE_PATH',
];

function allowed(name: string, list: readonly string[]): boolean {
  const upper = name.toUpperCase();
  return list.some((p) => (p.endsWith('*') ? upper.startsWith(p.slice(0, -1)) : upper === p));
}

/**
 * The environment for a render child process: only allowlisted names from
 * `base`, plus `extra` (engine-specific settings such as the browser path).
 */
export function renderChildEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string | undefined> = {}, allow: readonly string[] = RENDER_ENV_ALLOWLIST): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && allowed(k, allow)) env[k] = v;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

/**
 * Names of every secret ReelForge setting (with aliases and `_FILE`
 * variants), plus provider key names read by plugins. The values stay in the
 * server's configuration snapshot; only the process environment loses them.
 */
export function secretEnvNames(): string[] {
  const names = new Set<string>();
  for (const def of SETTINGS) {
    if (!def.secret) continue;
    for (const n of envNames(def)) {
      names.add(n);
      names.add(`${n}_FILE`);
    }
    if (def.providerEnv) names.add(def.providerEnv);
  }
  return [...names];
}

/** Remove every ReelForge secret from `target` (default: this process). Returns the names removed. */
export function scrubSecretEnv(target: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const n of secretEnvNames()) {
    if (target[n] !== undefined) {
      delete target[n];
      removed.push(n);
    }
  }
  return removed;
}
