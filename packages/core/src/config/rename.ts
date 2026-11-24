import { ENV_PREFIX, LEGACY_ENV_PREFIX, SETTINGS, renamedEnvName } from './schema';

/**
 * The rename compatibility layer for environment variables (#412, D-127):
 * ReelForge is now RenderWeld. Every `REELFORGE_*` name is also read as
 * `RENDERWELD_*`:
 *
 * - only the new name is set: it is used;
 * - only the old name is set: it still works, and start-up logs one warning
 *   naming the new variable (values are never printed);
 * - both are set with the same value: fine;
 * - both are set with different values: the configuration is invalid and the
 *   server does not start.
 *
 * Settings get this from `envNames()` in schema.ts (the alias table is derived
 * from the schema); the few names read outside the schema are listed in
 * OTHER_RENAMED_ENV and read with `readRenamedEnv()` / `envValue()`.
 */

export const RENAMED_DOC = 'docs/RENAMED.md';

/** Environment variables read outside the settings schema that have a RENDERWELD_* twin. */
export interface OtherRenamedEnv {
  old: string;
  secret?: boolean;
  /** Who reads it, for docs/RENAMED.md. */
  readBy: string;
}

export const OTHER_RENAMED_ENV: readonly OtherRenamedEnv[] = Object.freeze([
  { old: 'REELFORGE_CONFIG', readBy: 'the server and the CLI: path of the config file' },
  { old: 'REELFORGE_LICENCE_KEY_INPUT', secret: true, readBy: '`licence activate`: the key to activate' },
  { old: 'REELFORGE_REQUIRE_BROWSER', readBy: 'tests: a missing browser fails instead of skipping' },
  { old: 'REELFORGE_REQUIRE_STORAGE', readBy: 'tests: storage targets that must be configured' },
  { old: 'REELFORGE_TEST_DB', readBy: 'tests: the database the server tests run on' },
]);

/** One renamed variable: the new name, the old one, and the setting it feeds (none for OTHER_RENAMED_ENV). */
export interface RenamedEnv {
  name: string;
  old: string;
  key?: string;
  secret: boolean;
}

/** Every renamed environment variable: each REELFORGE_* name of each setting, plus OTHER_RENAMED_ENV. Secrets: each also as `_FILE`. */
export const RENAMED_ENV: readonly RenamedEnv[] = Object.freeze([
  ...SETTINGS.flatMap((def) =>
    [def.env, ...(def.aliases ?? [])].flatMap((old) => {
      const name = renamedEnvName(old);
      return name ? [{ name, old, key: def.key, secret: Boolean(def.secret) }] : [];
    })
  ),
  ...OTHER_RENAMED_ENV.map((o) => ({ name: renamedEnvName(o.old)!, old: o.old, secret: Boolean(o.secret) })),
]);

export const isNewEnvName = (name: string): boolean => name.startsWith(ENV_PREFIX);
export const isLegacyEnvName = (name: string): boolean => name.startsWith(LEGACY_ENV_PREFIX);

/** The start-up warning for a value that came from an old name (one per variable; never the value). */
export function renameWarning(old: string): string {
  return `${old} is an old name: rename it to ${renamedEnvName(old)} (ReelForge is now RenderWeld). The old name keeps working until a removal date announced in the release notes (${RENAMED_DOC}).`;
}

/** Why a configuration with both names set to different values is refused (never the values). */
export function renameConflictMessage(name: string, old: string): string {
  return `${name} and its old name ${old} are both set, with different values; remove ${old} or give both the same value (ReelForge is now RenderWeld, ${RENAMED_DOC})`;
}

/** For `config show` / `config check`: a note when a value came from an old name. */
export function legacyNote(origin: string | undefined): string {
  const name = origin && isLegacyEnvName(origin) ? renamedEnvName(origin) : undefined;
  return name ? `old name; rename it to ${name}` : '';
}

export interface RenamedEnvValue {
  /** The value to use (undefined: neither name is set). */
  value?: string;
  /** The variable it came from. */
  origin?: string;
  /** Only the old name is set (warn once). */
  legacy: boolean;
  /** Both names are set with different values: the message (the caller fails). */
  conflict?: string;
}

/**
 * A variable read outside the schema, with the rename rules. Empty values
 * count as unset (Compose passes `${X:-}` as ""). `same` compares two values
 * (default: equal text).
 */
export function readRenamedEnv(env: NodeJS.ProcessEnv, old: string, same: (a: string, b: string) => boolean = (a, b) => a === b): RenamedEnvValue {
  const name = renamedEnvName(old);
  if (!name) throw new Error(`${old} is not a ${LEGACY_ENV_PREFIX}* name`);
  const fresh = env[name]?.trim() || undefined;
  const legacy = env[old]?.trim() || undefined;
  if (fresh && legacy && !same(fresh, legacy)) return { origin: `${name}, ${old}`, legacy: false, conflict: renameConflictMessage(name, old) };
  if (fresh) return { value: fresh, origin: name, legacy: false };
  if (legacy) return { value: legacy, origin: old, legacy: true };
  return { legacy: false };
}

/**
 * A plain read of a `REELFORGE_*` variable that code outside the configuration
 * loader reads directly (engines, tests): the RENDERWELD_* twin when it is set
 * and not empty, else the old name. The server's start-up does the checks and
 * warnings (the schema covers these settings).
 */
export function envValue(old: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const name = renamedEnvName(old);
  const fresh = name ? env[name] : undefined;
  return fresh !== undefined && fresh !== '' ? fresh : env[old];
}
