/**
 * REELFORGE_SECRET_KEY at start-up and the licence-state seal without a fixed
 * fallback (#305). Test ids SECT-26..29 (docs/security/HARDENING.md).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LOCAL_SEAL_FILE,
  RuntimeConfig,
  createMemoryRepositories,
  licenceSealKey,
  licenceSealSecret,
  parseBuildInfo,
  resolveConfig,
  sealLicenceState,
  secretKeyProblem,
  unsealLicenceState,
} from '../src/index';
import { tempDir } from './helpers';

const { dir, cleanup } = tempDir('reelforge-secret-key-');
afterAll(cleanup);

const release = parseBuildInfo({
  edition: 'release',
  locked: { 'licence.mode': 'required', 'licence.serverUrl': 'https://licence.example.test', 'licence.orgId': 'aaaaaaaaaaaaaaaaaaaaaaaa' },
});
const KEY = 'secret-key-test-0123456789abcdefghijklmnop';

describe('REELFORGE_SECRET_KEY at start-up (#305)', () => {
  it('SECT-26 the release edition refuses to start without it, with a fix; a dev build warns; with it, nothing to say', () => {
    const rel = secretKeyProblem(resolveConfig({ env: {}, build: release }));
    expect(rel.error).toMatch(/REELFORGE_SECRET_KEY is not set: the release edition does not start without it/);
    expect(rel.error).toMatch(/REELFORGE_SECRET_KEY_FILE/);
    expect(rel.error).toMatch(/openssl rand -base64 32/);
    expect(secretKeyProblem(resolveConfig({ env: { REELFORGE_SECRET_KEY: KEY }, build: release }))).toEqual({});
    const dev = secretKeyProblem(resolveConfig({ env: {} }));
    expect(dev.error).toBeUndefined();
    expect(dev.warning).toMatch(/licence-seal\.key/);
    expect(secretKeyProblem(resolveConfig({ env: { REELFORGE_SECRET_KEY: KEY } }))).toEqual({});
  });

  it('SECT-27 the seal secret: the secret key when set; never a constant; a release build without it throws', async () => {
    const repos = createMemoryRepositories();
    const withKey = new RuntimeConfig(repos, { env: { REELFORGE_SECRET_KEY: KEY }, build: release });
    await withKey.load();
    expect(licenceSealSecret(withKey, join(dir, 'a'))).toBe(KEY);
    expect(existsSync(join(dir, 'a', LOCAL_SEAL_FILE))).toBe(false);
    const releaseNoKey = new RuntimeConfig(createMemoryRepositories(), { env: {}, build: release });
    await releaseNoKey.load();
    expect(() => licenceSealSecret(releaseNoKey, join(dir, 'b'))).toThrow(/release edition needs REELFORGE_SECRET_KEY/);
    expect(() => licenceSealKey('', 'rf-1')).toThrow(/needs a secret/);
  });

  it('SECT-28 a dev build without the secret key keeps a random seal secret in <dataDir>/licence-seal.key (0600), the same after a restart', async () => {
    const rc = new RuntimeConfig(createMemoryRepositories(), { env: {} });
    await rc.load();
    const dataDir = join(dir, 'dev');
    const first = licenceSealSecret(rc, dataDir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const file = join(dataDir, LOCAL_SEAL_FILE);
    expect(readFileSync(file, 'utf8').trim()).toBe(first);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(licenceSealSecret(rc, dataDir)).toBe(first);
    // Another data directory: another secret. No data directory: a secret for this process only.
    expect(licenceSealSecret(rc, join(dir, 'dev2'))).not.toBe(first);
    expect(licenceSealSecret(rc)).not.toBe(licenceSealSecret(rc));
  });

  it('SECT-29 a state forged with the old fixed key is not trusted by a dev build without the secret key', async () => {
    const rc = new RuntimeConfig(createMemoryRepositories(), { env: {} });
    await rc.load();
    const secret = licenceSealSecret(rc, join(dir, 'forge'));
    const now = new Date().toISOString();
    const state = { instanceId: 'rf-forge', answer: { valid: true, reason: null }, lastCheckedAt: now, lastSuccessAt: now, highWaterAt: now, updatedAt: now };
    // What anyone could compute before #305: the seal keyed by the constant in the source.
    const forged = sealLicenceState(state, 'reelforge-licence-state-unkeyed-v1');
    expect(unsealLicenceState(forged, secret).untrusted).toBe(true);
    expect(unsealLicenceState(sealLicenceState(state, secret), secret).untrusted).toBe(false);
  });
});
