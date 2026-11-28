import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SETTINGS, envNames, loadConfigFile, resolveConfig, scrubSecretEnv, secretEnvNames } from '../src/index';
import { tempDir } from './helpers';

/** Environment variable names (#413): every setting is read under its RENDERWELD_* name and its aliases, nothing else. */
const { dir, cleanup } = tempDir('renderweld-env-names-');
afterAll(cleanup);

const KEY = 'env-names-test-secret-key-0123456789abcdef';

describe('setting names', () => {
  it('every setting is named RENDERWELD_*, then its aliases (DATABASE_URL, OTEL_*, ...)', () => {
    for (const def of SETTINGS) {
      expect(def.env, def.key).toMatch(/^RENDERWELD_[A-Z0-9_]+$/);
      expect(envNames(def), def.key).toEqual([def.env, ...(def.aliases ?? [])]);
    }
    expect(envNames(SETTINGS.find((d) => d.key === 'database.url')!)).toEqual(['RENDERWELD_DATABASE_URL', 'DATABASE_URL']);
  });

  it('no setting is read under a REELFORGE_* name', () => {
    expect(SETTINGS.flatMap(envNames).filter((n) => /REELFORGE/i.test(n))).toEqual([]);
    const r = resolveConfig({ env: { REELFORGE_PORT: '5555', REELFORGE_SECRET_KEY: KEY, REELFORGE_LICENCE_MODE: 'off' } });
    expect(r.config.server.port).toBe(4321);
    expect(r.config.security.secretKey).toBeUndefined();
    expect(r.config.licence.mode).toBe('required');
  });

  it('the RENDERWELD_* name is used and named as the origin; a secret is read from _FILE too', () => {
    const file = join(dir, 'secret');
    writeFileSync(file, `${KEY}\n`);
    const r = resolveConfig({ env: { RENDERWELD_PORT: '5555', RENDERWELD_SECRET_KEY_FILE: file } });
    expect(r.config.server.port).toBe(5555);
    expect(r.config.security.secretKey).toBe(KEY);
    expect(r.settings.get('server.port')).toMatchObject({ source: 'env', origin: 'RENDERWELD_PORT' });
    expect(r.settings.get('security.secretKey')).toMatchObject({ source: 'env', origin: 'RENDERWELD_SECRET_KEY_FILE' });
  });

  it('the config file comes from RENDERWELD_CONFIG only', () => {
    const file = join(dir, 'renderweld.yaml');
    writeFileSync(file, 'limits:\n  renderConcurrency: 3\n');
    expect(loadConfigFile({ RENDERWELD_CONFIG: file })?.path).toBe(file);
    expect(loadConfigFile({ REELFORGE_CONFIG: file })).toBeUndefined();
    expect(loadConfigFile({ RENDERWELD_CONFIG: '  ' })).toBeUndefined();
  });

  it('render child processes lose every secret setting (D-086)', () => {
    const names = secretEnvNames();
    for (const n of ['RENDERWELD_SECRET_KEY', 'RENDERWELD_SECRET_KEY_FILE', 'RENDERWELD_DATABASE_URL', 'DATABASE_URL', 'RENDERWELD_LICENCE_KEY_FILE']) expect(names).toContain(n);
    const env: NodeJS.ProcessEnv = { RENDERWELD_SECRET_KEY: KEY, RENDERWELD_BOOTSTRAP_KEY_FILE: '/run/x', RENDERWELD_PORT: '1' };
    scrubSecretEnv(env);
    expect(env).toEqual({ RENDERWELD_PORT: '1' });
  });
});
