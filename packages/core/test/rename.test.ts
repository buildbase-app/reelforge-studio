import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  IMAGE_DEFAULTS_ENV,
  OTHER_RENAMED_ENV,
  RENAMED_ENV,
  SETTINGS,
  envNames,
  envValue,
  legacyNote,
  loadConfigFile,
  readRenamedEnv,
  resolveConfig,
  scrubSecretEnv,
  secretEnvNames,
  type ConfigIssue,
} from '../src/index';
import { tempDir } from './helpers';

/** The rename compatibility layer (#412): RENDERWELD_* names, the old REELFORGE_* names as aliases. */
const { dir, cleanup } = tempDir('reelforge-rename-');
afterAll(cleanup);

const KEY = 'rename-test-secret-key-0123456789abcdef';
const OTHER_KEY = 'rename-test-other-key-0123456789abcdef';
const f = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};
function issues(fn: () => unknown): ConfigIssue[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  throw new Error('expected a ConfigError');
}
const renameWarnings = (w: string[]) => w.filter((x) => / is an old name: rename it to /.test(x));

describe('every REELFORGE_* setting name has a RENDERWELD_* twin (derived from the schema)', () => {
  it('lists the new names first, then the old ones, then other aliases', () => {
    for (const def of SETTINGS) {
      const names = envNames(def);
      const old = [def.env, ...(def.aliases ?? [])].filter((n) => n.startsWith('REELFORGE_'));
      expect(names.slice(0, old.length), def.key).toEqual(old.map((n) => n.replace(/^REELFORGE_/, 'RENDERWELD_')));
      expect(names.slice(old.length, old.length * 2), def.key).toEqual(old);
    }
    expect(envNames(SETTINGS.find((s) => s.key === 'database.url')!)).toEqual(['RENDERWELD_DATABASE_URL', 'REELFORGE_DATABASE_URL', 'DATABASE_URL']);
  });

  it('the alias table covers every old name of the schema plus the names read outside it', () => {
    const fromSchema = SETTINGS.flatMap((s) => [s.env, ...(s.aliases ?? [])]).filter((n) => n.startsWith('REELFORGE_'));
    expect(RENAMED_ENV.map((r) => r.old)).toEqual([...fromSchema, ...OTHER_RENAMED_ENV.map((o) => o.old)]);
    for (const r of RENAMED_ENV) expect(r.name).toBe(r.old.replace(/^REELFORGE_/, 'RENDERWELD_'));
    expect(RENAMED_ENV.map((r) => r.old)).toEqual(expect.arrayContaining(['REELFORGE_CHROMIUM_PATH', 'REELFORGE_SECRET_KEY', 'REELFORGE_BOOTSTRAP_KEY', 'REELFORGE_CONFIG', 'REELFORGE_REQUIRE_BROWSER']));
  });

  it('both names with different values are refused for every setting, naming both and no value', () => {
    for (const def of SETTINGS) {
      const [name] = envNames(def);
      const old = name!.replace(/^RENDERWELD_/, 'REELFORGE_');
      const list = issues(() => resolveConfig({ env: { [name!]: 'value-NEW-1', [old]: 'value-OLD-2' } }));
      const clash = list.find((i) => i.key === def.key && i.origin === `${name}, ${old}`);
      expect(clash, def.key).toBeDefined();
      expect(clash!.message).toContain(`${name} and its old name ${old} are both set, with different values`);
      expect(JSON.stringify(list) + new ConfigError(list).message).not.toMatch(/value-(NEW|OLD)/);
    }
  });
});

describe('resolving RENDERWELD_* and REELFORGE_* names', () => {
  it('the new name alone is used, without a warning', () => {
    const r = resolveConfig({ env: { RENDERWELD_PORT: '9100', RENDERWELD_SECRET_KEY: KEY } });
    expect(r.config.server.port).toBe(9100);
    expect(r.settings.get('server.port')).toMatchObject({ source: 'env', origin: 'RENDERWELD_PORT' });
    expect(r.config.security.secretKey).toBe(KEY);
    expect(renameWarnings(r.warnings)).toEqual([]);
  });

  it('the old name alone still works and warns once per variable, naming the new one and never the value', () => {
    const r = resolveConfig({ env: { REELFORGE_PORT: '9101', REELFORGE_SECRET_KEY: KEY, REELFORGE_LOG_LEVEL: 'warn' } });
    expect(r.config.server.port).toBe(9101);
    expect(r.config.security.secretKey).toBe(KEY);
    expect(r.settings.get('server.port')!.origin).toBe('REELFORGE_PORT');
    const w = renameWarnings(r.warnings);
    expect(w).toHaveLength(3);
    for (const [old, name] of [['REELFORGE_PORT', 'RENDERWELD_PORT'], ['REELFORGE_SECRET_KEY', 'RENDERWELD_SECRET_KEY'], ['REELFORGE_LOG_LEVEL', 'RENDERWELD_LOG_LEVEL']]) {
      expect(w.filter((x) => x.startsWith(`${old} is an old name: rename it to ${name} `))).toHaveLength(1);
    }
    expect(w.join('\n')).toMatch(/release notes \(docs\/RENAMED\.md\)/);
    expect(r.warnings.join('\n')).not.toContain(KEY);
  });

  it('both names with the same value are fine: the new one is the origin, no warning', () => {
    const r = resolveConfig({ env: { RENDERWELD_PORT: '9102', REELFORGE_PORT: '9102', RENDERWELD_SECRET_KEY: KEY, REELFORGE_SECRET_KEY: KEY } });
    expect(r.config.server.port).toBe(9102);
    expect(r.settings.get('server.port')!.origin).toBe('RENDERWELD_PORT');
    expect(r.warnings).toEqual([]);
  });

  it('both names with different values fail, naming both; a secret value is never echoed', () => {
    const list = issues(() => resolveConfig({ env: { RENDERWELD_PORT: '9103', REELFORGE_PORT: '9104', RENDERWELD_SECRET_KEY: KEY, REELFORGE_SECRET_KEY: OTHER_KEY } }));
    expect(list.map((i) => [i.key, i.origin])).toEqual([
      ['server.port', 'RENDERWELD_PORT, REELFORGE_PORT'],
      ['security.secretKey', 'RENDERWELD_SECRET_KEY, REELFORGE_SECRET_KEY'],
    ]);
    const text = new ConfigError(list).message;
    expect(text).toMatch(/RENDERWELD_SECRET_KEY and its old name REELFORGE_SECRET_KEY are both set, with different values; remove REELFORGE_SECRET_KEY/);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(OTHER_KEY);
  });

  it('_FILE variants: the new one works, the old one warns, different contents fail without showing them', () => {
    const fresh = f('new-key', `${KEY}\n`);
    const old = f('old-key', `${KEY}\n`);
    const other = f('other-key', OTHER_KEY);
    const a = resolveConfig({ env: { RENDERWELD_SECRET_KEY_FILE: fresh } });
    expect(a.config.security.secretKey).toBe(KEY);
    expect(a.settings.get('security.secretKey')!.origin).toBe('RENDERWELD_SECRET_KEY_FILE');
    expect(a.warnings).toEqual([]);
    const b = resolveConfig({ env: { REELFORGE_SECRET_KEY_FILE: old } });
    expect(b.config.security.secretKey).toBe(KEY);
    expect(renameWarnings(b.warnings)).toEqual([expect.stringMatching(/^REELFORGE_SECRET_KEY_FILE is an old name: rename it to RENDERWELD_SECRET_KEY_FILE /)]);
    // The same secret through the new file and the old direct name is the same value.
    expect(resolveConfig({ env: { RENDERWELD_SECRET_KEY_FILE: fresh, REELFORGE_SECRET_KEY: KEY } }).warnings).toEqual([]);
    const list = issues(() => resolveConfig({ env: { RENDERWELD_SECRET_KEY_FILE: fresh, REELFORGE_SECRET_KEY_FILE: other } }));
    expect(list).toHaveLength(1);
    expect(list[0]!.origin).toBe('RENDERWELD_SECRET_KEY_FILE, REELFORGE_SECRET_KEY_FILE');
    expect(new ConfigError(list).message).not.toMatch(new RegExp(`${KEY}|${OTHER_KEY}`));
  });

  it('other aliases rank after both names (DATABASE_URL, the licence spelling)', () => {
    const db = resolveConfig({ env: { RENDERWELD_DATABASE_URL: 'postgresql://u:p@new/rf', DATABASE_URL: 'postgresql://u:p@generic/rf' } });
    expect(db.config.database.url).toBe('postgresql://u:p@new/rf');
    expect(db.settings.get('database.url')!.origin).toBe('RENDERWELD_DATABASE_URL');
    expect(resolveConfig({ env: { RENDERWELD_LICENSE_MODE: 'off' } }).config.licence.mode).toBe('off');
    expect(renameWarnings(resolveConfig({ env: { REELFORGE_LICENSE_MODE: 'off' } }).warnings)).toEqual([expect.stringMatching(/^REELFORGE_LICENSE_MODE is an old name: rename it to RENDERWELD_LICENSE_MODE /)]);
  });

  it('a value the Docker image sets as its default gives way to an operator value under the old name', () => {
    const image = { RENDERWELD_PORT: '4321', RENDERWELD_HOST: '0.0.0.0', [IMAGE_DEFAULTS_ENV]: 'RENDERWELD_PORT=4321 RENDERWELD_HOST=0.0.0.0' };
    const plain = resolveConfig({ env: image });
    expect(plain.config.server).toMatchObject({ port: 4321, host: '0.0.0.0' });
    expect(plain.warnings).toEqual([]);
    const old = resolveConfig({ env: { ...image, REELFORGE_PORT: '8080' } });
    expect(old.config.server.port).toBe(8080);
    expect(renameWarnings(old.warnings)).toHaveLength(1);
    // The operator replaced the image's value: a real clash again.
    expect(issues(() => resolveConfig({ env: { ...image, RENDERWELD_PORT: '9000', REELFORGE_PORT: '8080' } }))[0]!.origin).toBe('RENDERWELD_PORT, REELFORGE_PORT');
  });
});

describe('config file: RENDERWELD_CONFIG and REELFORGE_CONFIG', () => {
  const yaml = (name: string, port: number) => f(name, `server:\n  port: ${port}\n`);

  it('renderweld.yaml through RENDERWELD_CONFIG, reelforge.yaml through the old name (one warning)', () => {
    const fresh = yaml('renderweld.yaml', 9200);
    const env = { RENDERWELD_CONFIG: fresh };
    const r = resolveConfig({ env, file: loadConfigFile(env) });
    expect(r.config.server.port).toBe(9200);
    expect(r.settings.get('server.port')!.origin).toBe(fresh);
    expect(r.warnings).toEqual([]);
    const old = yaml('reelforge.yaml', 9201);
    const oldEnv = { REELFORGE_CONFIG: old };
    const o = resolveConfig({ env: oldEnv, file: loadConfigFile(oldEnv) });
    expect(o.config.server.port).toBe(9201);
    expect(renameWarnings(o.warnings)).toEqual([expect.stringMatching(/^REELFORGE_CONFIG is an old name: rename it to RENDERWELD_CONFIG /)]);
  });

  it('both names for the same file are fine; for two different files start-up fails naming both', () => {
    const fresh = yaml('renderweld.yaml', 9200);
    const old = yaml('reelforge.yaml', 9201);
    expect(loadConfigFile({ RENDERWELD_CONFIG: fresh, REELFORGE_CONFIG: fresh })?.path).toBe(fresh);
    const list = issues(() => loadConfigFile({ RENDERWELD_CONFIG: fresh, REELFORGE_CONFIG: old }));
    expect(list[0]).toMatchObject({ origin: 'RENDERWELD_CONFIG, REELFORGE_CONFIG' });
    expect(list[0]!.message).toMatch(/RENDERWELD_CONFIG and its old name REELFORGE_CONFIG are both set, with different values/);
    expect(issues(() => resolveConfig({ env: { RENDERWELD_CONFIG: fresh, REELFORGE_CONFIG: old } }))[0]!.origin).toBe('RENDERWELD_CONFIG, REELFORGE_CONFIG');
  });
});

describe('names read outside the schema', () => {
  it('readRenamedEnv: new wins, old alone is flagged, different values conflict, empty is unset', () => {
    expect(readRenamedEnv({ RENDERWELD_TEST_DB: 'postgres' }, 'REELFORGE_TEST_DB')).toEqual({ value: 'postgres', origin: 'RENDERWELD_TEST_DB', legacy: false });
    expect(readRenamedEnv({ REELFORGE_TEST_DB: 'mysql' }, 'REELFORGE_TEST_DB')).toEqual({ value: 'mysql', origin: 'REELFORGE_TEST_DB', legacy: true });
    expect(readRenamedEnv({ RENDERWELD_TEST_DB: '', REELFORGE_TEST_DB: 'mysql' }, 'REELFORGE_TEST_DB')).toMatchObject({ value: 'mysql', legacy: true });
    expect(readRenamedEnv({ RENDERWELD_TEST_DB: 'a', REELFORGE_TEST_DB: 'b' }, 'REELFORGE_TEST_DB').conflict).toMatch(/both set/);
  });

  it('envValue (engines, tests): the new name when set, else the old one', () => {
    expect(envValue('REELFORGE_CHROMIUM_PATH', { RENDERWELD_CHROMIUM_PATH: '/new', REELFORGE_CHROMIUM_PATH: '/old' })).toBe('/new');
    expect(envValue('REELFORGE_CHROMIUM_PATH', { REELFORGE_CHROMIUM_PATH: '/old' })).toBe('/old');
    expect(envValue('REELFORGE_REQUIRE_BROWSER', { RENDERWELD_REQUIRE_BROWSER: '1' })).toBe('1');
    expect(envValue('REELFORGE_CHROMIUM_PATH', {})).toBeUndefined();
  });

  it('legacyNote names the new variable for an old origin only', () => {
    expect(legacyNote('REELFORGE_PORT')).toBe('old name; rename it to RENDERWELD_PORT');
    expect(legacyNote('REELFORGE_SECRET_KEY_FILE')).toBe('old name; rename it to RENDERWELD_SECRET_KEY_FILE');
    expect(legacyNote('RENDERWELD_PORT')).toBe('');
    expect(legacyNote('DATABASE_URL')).toBe('');
  });

  it('render child processes lose secrets under both names (D-086)', () => {
    const names = secretEnvNames();
    for (const n of ['RENDERWELD_SECRET_KEY', 'RENDERWELD_SECRET_KEY_FILE', 'REELFORGE_SECRET_KEY', 'RENDERWELD_DATABASE_URL', 'RENDERWELD_LICENCE_KEY_FILE']) expect(names).toContain(n);
    const env: NodeJS.ProcessEnv = { RENDERWELD_SECRET_KEY: KEY, RENDERWELD_BOOTSTRAP_KEY_FILE: '/run/x', RENDERWELD_PORT: '1' };
    scrubSecretEnv(env);
    expect(env).toEqual({ RENDERWELD_PORT: '1' });
  });
});
