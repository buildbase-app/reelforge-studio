import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  ConfigSchema,
  ElevenLabsTts,
  PluginRegistry,
  RenderWeldService,
  RuntimeConfig,
  SETTINGS,
  SecretCipher,
  DEV_BUILD,
  createMemoryRepositories,
  currentBuild,
  parseBuildInfo,
  readConfigFile,
  resolveConfig,
  setPath,
  type ConfigIssue,
} from '../src/index';
import { DEFAULT_ENCODER_SETTINGS, encoderSettings, h264Args, setEncoderSettings } from '@renderweld/media-pipeline';
import { fakeEngine, tempDir } from './helpers';

const { dir, cleanup } = tempDir('reelforge-config-');
afterAll(cleanup);

const KEY = 'unit-test-secret-key-0123456789abcdef';
const file = (data: unknown) => ({ path: '/etc/reelforge.yaml', data });
function issues(fn: () => unknown): ConfigIssue[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  throw new Error('expected a ConfigError');
}

describe('config schema', () => {
  it('describes every setting with env names, scope and a description; secrets are marked', () => {
    expect(SETTINGS.length).toBeGreaterThan(25);
    const keys = SETTINGS.map((s) => s.key);
    for (const k of ['server.port', 'limits.rateLimitPerMinute', 'storage.dataDir', 'database.url', 'security.secretKey', 'providers.elevenlabs.apiKey', 'logging.level', 'licence.key', 'render.ffmpegPath']) {
      expect(keys).toContain(k);
    }
    for (const s of SETTINGS) {
      expect(s.env).toMatch(/^RENDERWELD_[A-Z0-9_]+$/);
      expect(s.description.length).toBeGreaterThan(5);
      expect(['startup', 'runtime']).toContain(s.scope);
    }
    expect(new Set(SETTINGS.flatMap((s) => [s.env, ...(s.aliases ?? [])])).size).toBe(SETTINGS.flatMap((s) => [s.env, ...(s.aliases ?? [])]).length);
    const byKey = new Map(SETTINGS.map((s) => [s.key, s]));
    for (const k of ['database.url', 'security.secretKey', 'security.bootstrapKey', 'providers.elevenlabs.apiKey', 'licence.key']) expect(byKey.get(k)?.secret).toBe(true);
    for (const k of ['server.port', 'server.host', 'database.url', 'storage.dataDir', 'security.secretKey']) expect(byKey.get(k)?.scope).toBe('startup');
    for (const k of ['limits.rateLimitPerMinute', 'limits.renderConcurrency', 'server.allowedHosts', 'logging.level']) expect(byKey.get(k)?.scope).toBe('runtime');
  });

  it('has defaults that are a valid configuration', () => {
    const r = resolveConfig({ env: {} });
    expect(ConfigSchema.safeParse(r.config).success).toBe(true);
    expect(r.config.server).toMatchObject({ host: '127.0.0.1', port: 4321, allowedHosts: [] });
    expect(r.config.limits).toEqual({
      rateLimitPerMinute: 300,
      rateLimitStore: 'auto',
      // Before the key lookup, per client address (#305)
      preAuthPerMinute: 1200,
      authFailuresPerMinute: 20,
      authLockoutSeconds: 60,
      authLockoutMaxSeconds: 3600,
      maxUploadBytes: 209715200,
      maxJsonBytes: 2097152,
      renderConcurrency: 1,
      // Backpressure (#307): 503 overloaded past this many requests in progress per instance
      maxInflightRequests: 64,
      inflightWaitMs: 3000,
      // Resource limits (D-090, D-091)
      maxQueuedJobsPerKey: 100,
      maxQueuedJobs: 1000,
      maxRunningJobsPerKey: 0,
      // Admission by estimated wait (D-103): off by default
      maxEstimatedWaitSeconds: 0,
      maxRenderSeconds: 180,
      maxRenderFrames: 5400,
      maxScenes: 50,
      maxRenderDimension: 3840,
      maxRenderFps: 60,
      providerRunsPerKeyPerDay: 500,
      providerRunsPerDay: 0,
    });
    // The total queue cap follows the effective queue (D-090): unbounded with the database queue.
    expect(resolveConfig({ env: { RENDERWELD_QUEUE_DRIVER: 'database' } }).config.limits.maxQueuedJobs).toBe(0);
    expect(resolveConfig({ env: { RENDERWELD_ROLE: 'api', DATABASE_URL: 'postgresql://u@db/x' } }).config.limits.maxQueuedJobs).toBe(0);
    expect(resolveConfig({ env: { RENDERWELD_ROLE: 'api', RENDERWELD_QUEUE_DRIVER: 'inprocess' } }).config.limits.maxQueuedJobs).toBe(1000);
    expect(resolveConfig({ env: { RENDERWELD_QUEUE_DRIVER: 'database', RENDERWELD_MAX_QUEUED_JOBS: '50' } }).config.limits.maxQueuedJobs).toBe(50);
    expect(r.config.database.url).toMatch(/^file:\/.*\/data\/reelforge\.db$/);
    expect([...r.settings.values()].every((s) => s.source === 'default')).toBe(true);
  });
});

describe('setPath', () => {
  it('writes a dotted key, creating parents, and refuses a key that would reach Object.prototype', () => {
    const o: Record<string, unknown> = {};
    setPath(o, 'server.publicUrl', 'https://studio.example.com');
    expect(o).toEqual({ server: { publicUrl: 'https://studio.example.com' } });
    for (const key of ['__proto__.polluted', 'a.__proto__.polluted', 'constructor.prototype.polluted', 'a.prototype', 'a.constructor']) {
      expect(() => setPath({}, key, true)).toThrow(/refused key/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('sources and precedence', () => {
  it('defaults < file < env < runtime, per key, with the source and origin of each', () => {
    const r = resolveConfig({
      env: { RENDERWELD_RATE_LIMIT_PER_MINUTE: '20', RENDERWELD_RENDER_CONCURRENCY: '3' },
      file: file({ limits: { rateLimitPerMinute: 10, renderConcurrency: 2, maxJsonBytes: 4096 }, server: { port: 8080 } }),
      runtime: { 'limits.rateLimitPerMinute': 30 },
    });
    expect(r.config.limits).toMatchObject({ rateLimitPerMinute: 30, renderConcurrency: 3, maxJsonBytes: 4096, maxUploadBytes: 209715200 });
    expect(r.config.server.port).toBe(8080);
    const s = (k: string) => {
      const v = r.settings.get(k)!;
      return [v.source, v.origin];
    };
    expect(s('limits.rateLimitPerMinute')).toEqual(['runtime', 'database']);
    expect(s('limits.renderConcurrency')).toEqual(['env', 'RENDERWELD_RENDER_CONCURRENCY']);
    expect(s('limits.maxJsonBytes')).toEqual(['file', '/etc/reelforge.yaml']);
    expect(s('limits.maxUploadBytes')).toEqual(['default', undefined]);
  });

  it('computes defaults from other effective values (database URL and cache in the data directory)', () => {
    const r = resolveConfig({ env: { RENDERWELD_DATA_DIR: '/srv/rf' } });
    expect(r.config.database.url).toBe('file:/srv/rf/reelforge.db');
    expect(r.config.storage.cacheDir).toBe('/srv/rf/cache');
    expect(r.settings.get('database.url')!.source).toBe('default');
  });

  it('parses env text by kind: integers, booleans, comma lists; empty variables count as unset', () => {
    const r = resolveConfig({
      env: { RENDERWELD_PORT: '0', RENDERWELD_MIGRATE_ON_START: 'no', RENDERWELD_CHROMIUM_NO_SANDBOX: '1', RENDERWELD_ALLOWED_HOSTS: ' A.example , b ,', RENDERWELD_PUBLIC_URL: '', RENDERWELD_HOST: '' },
    });
    expect(r.config.server.port).toBe(0);
    expect(r.config.database.migrateOnStart).toBe(false);
    expect(r.config.render.chromiumNoSandbox).toBe(true);
    expect(r.config.server.allowedHosts).toEqual(['a.example', 'b']);
    expect(r.config.server.publicUrl).toBeUndefined();
    expect(r.config.server.host).toBe('127.0.0.1');
  });

  it('keeps existing names working as aliases; the RENDERWELD_ name wins (with a warning)', () => {
    const r = resolveConfig({ env: { DATABASE_URL: 'postgresql://u:p@db/rf', ELEVENLABS_API_KEY: 'sk_alias', FFMPEG_PATH: '/opt/ffmpeg', REMOTION_LAMBDA_REGION: 'eu-west-1' } });
    expect(r.config.database.url).toBe('postgresql://u:p@db/rf');
    expect(r.settings.get('database.url')!.origin).toBe('DATABASE_URL');
    expect(r.config.providers.elevenlabs.apiKey).toBe('sk_alias');
    expect(r.config.render.ffmpegPath).toBe('/opt/ffmpeg');
    expect(r.config.render.backends.remotionLambda.region).toBe('eu-west-1');
    const both = resolveConfig({ env: { RENDERWELD_DATABASE_URL: 'postgresql://a/rf', DATABASE_URL: 'postgresql://b/rf' } });
    expect(both.config.database.url).toBe('postgresql://a/rf');
    expect(both.warnings.join()).toMatch(/RENDERWELD_DATABASE_URL, DATABASE_URL .*using RENDERWELD_DATABASE_URL/);
    expect(both.warnings.join()).not.toContain('postgresql://');
  });

  it('reads every secret from <NAME>_FILE (also for aliases); the variable wins over its file', () => {
    const f = (name: string, text: string) => {
      const p = join(dir, name);
      writeFileSync(p, text);
      return p;
    };
    const r = resolveConfig({
      env: {
        RENDERWELD_SECRET_KEY_FILE: f('sk', `${KEY}\n`),
        DATABASE_URL_FILE: f('db', 'mysql://u:p@db/rf\n'),
        ELEVENLABS_API_KEY_FILE: f('el', 'sk_from_file'),
        RENDERWELD_BOOTSTRAP_KEY_FILE: f('bk', 'rf_fromAfile_7Qx2Lm9Vb4Nc8Zr1Ty6Hp3Kw5Dj0Gs'),
        RENDERWELD_LICENCE_KEY: 'LIC-ENV',
        RENDERWELD_LICENCE_KEY_FILE: f('lic', 'LIC-FILE'),
      },
    });
    expect(r.config.security.secretKey).toBe(KEY);
    expect(r.config.database.url).toBe('mysql://u:p@db/rf');
    expect(r.config.providers.elevenlabs.apiKey).toBe('sk_from_file');
    expect(r.config.security.bootstrapKey).toBe('rf_fromAfile_7Qx2Lm9Vb4Nc8Zr1Ty6Hp3Kw5Dj0Gs');
    expect(r.config.licence.key).toBe('LIC-ENV');
    expect(r.settings.get('security.secretKey')!.origin).toBe('RENDERWELD_SECRET_KEY_FILE');
    // Every secret has a _FILE variant; non-secrets do not read one.
    expect(resolveConfig({ env: { RENDERWELD_PORT_FILE: f('port', '9999') } }).config.server.port).toBe(4321);
    const bad = issues(() => resolveConfig({ env: { RENDERWELD_SECRET_KEY_FILE: join(dir, 'missing'), DATABASE_URL_FILE: f('empty', '\n') } }));
    expect(bad.map((i) => i.origin).sort()).toEqual(['DATABASE_URL_FILE', 'RENDERWELD_SECRET_KEY_FILE']);
    expect(bad.find((i) => i.origin === 'DATABASE_URL_FILE')?.message).toMatch(/is empty/);
    expect(bad.find((i) => i.origin === 'RENDERWELD_SECRET_KEY_FILE')?.message).toMatch(/cannot read .*ENOENT/);
  });

  it('reports every problem at once, showing values of non-secrets only', () => {
    const list = issues(() =>
      resolveConfig({
        env: { RENDERWELD_PORT: 'eighty', RENDERWELD_SECRET_KEY: 'too-short-secret', RENDERWELD_BOOTSTRAP_KEY: 'not-a-key-SECRETVALUE', RENDERWELD_LOG_LEVEL: 'loud' },
        file: file({ limits: { rateLimitPerMinute: -5 }, server: { prot: 1 }, nope: {} }),
      })
    );
    const text = JSON.stringify(list) + new ConfigError(list).message;
    expect(list.map((i) => i.key)).toEqual(expect.arrayContaining(['server.port', 'security.secretKey', 'security.bootstrapKey', 'logging.level']));
    expect(text).toContain('got "eighty"');
    expect(text).toContain('"loud"');
    expect(text).toMatch(/Unrecognized key.*prot/);
    expect(text).not.toContain('too-short-secret');
    expect(text).not.toContain('SECRETVALUE');
  });

  it('storage drivers need their settings; keys come in pairs (STO-15)', () => {
    expect(issues(() => resolveConfig({ env: { RENDERWELD_STORAGE_DRIVER: 's3' } })).map((i) => i.key)).toEqual(['storage.s3.bucket']);
    expect(issues(() => resolveConfig({ env: { RENDERWELD_STORAGE_DRIVER: 'azure' } })).map((i) => i.key)).toEqual(['storage.azure.container', 'storage.azure.accountUrl']);
    expect(issues(() => resolveConfig({ env: { RENDERWELD_STORAGE_DRIVER: 'gcs' } })).map((i) => i.key)).toEqual(['storage.gcs.bucket']);
    const pair = issues(() => resolveConfig({ env: { RENDERWELD_STORAGE_DRIVER: 's3', RENDERWELD_S3_BUCKET: 'b', RENDERWELD_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE' } }));
    expect(pair.map((i) => i.key)).toEqual(['storage.s3.secretAccessKey']);
    expect(JSON.stringify(pair)).not.toContain('AKIAEXAMPLE');
    expect(issues(() => resolveConfig({ env: { RENDERWELD_S3_KMS_KEY_ID: 'k' } }))[0]!.key).toBe('storage.s3.kmsKeyId');
    const ok = resolveConfig({ env: { RENDERWELD_STORAGE_DRIVER: 's3', RENDERWELD_S3_BUCKET: 'b', RENDERWELD_S3_SSE: 'aws:kms', RENDERWELD_S3_KMS_KEY_ID: 'arn:aws:kms:eu-west-1:1:key/x' } });
    expect(ok.config.storage.s3).toMatchObject({ bucket: 'b', serverSideEncryption: 'aws:kms', forcePathStyle: false });
  });

  it('storage endpoints are SSRF-safe: http only to internal hosts, no credentials or query (STO-16)', () => {
    const bad = (url: string) => issues(() => resolveConfig({ env: { RENDERWELD_S3_ENDPOINT: url } }))[0]?.message ?? '';
    expect(bad('http://s3.example.com')).toMatch(/only allowed for internal hosts/);
    expect(bad('https://user:pw@s3.example.com')).toMatch(/must not contain credentials/);
    expect(bad('https://s3.example.com/?x=1')).toMatch(/query/);
    for (const ok of ['https://s3.example.com', 'http://minio:9000', 'http://127.0.0.1:9000', 'http://10.1.2.3:9000', 'http://minio.storage.svc:9000', 'http://[::1]:9000']) {
      expect(() => resolveConfig({ env: { RENDERWELD_S3_ENDPOINT: ok } }), ok).not.toThrow();
    }
  });

  it('reads YAML and JSON config files; a broken file never echoes its content', () => {
    const y = join(dir, 'c.yaml');
    writeFileSync(y, 'server:\n  port: 9000\n  allowedHosts: [Studio.Example.com]\nlimits:\n  rateLimitPerMinute: 60 # per key\n');
    const j = join(dir, 'c.json');
    writeFileSync(j, JSON.stringify({ logging: { level: 'debug' }, security: { secretKey: KEY } }));
    const ry = resolveConfig({ env: {}, file: readConfigFile(y) });
    expect(ry.config.server).toMatchObject({ port: 9000, allowedHosts: ['studio.example.com'] });
    expect(ry.config.limits.rateLimitPerMinute).toBe(60);
    const rj = resolveConfig({ env: {}, file: readConfigFile(j) });
    expect(rj.config.logging.level).toBe('debug');
    expect(rj.settings.get('security.secretKey')!.source).toBe('file');
    const broken = join(dir, 'broken.yaml');
    writeFileSync(broken, 'security:\n  secretKey: "hunter2-hunter2-hunter2-hunter2-hunter2\n  : [\n');
    const e = issues(() => readConfigFile(broken));
    expect(e[0]!.message).toMatch(/not valid YAML/);
    expect(JSON.stringify(e)).not.toContain('hunter2');
    expect(issues(() => readConfigFile(join(dir, 'nope.yaml')))[0]!.message).toMatch(/cannot read the config file.*ENOENT/);
  });
});

describe('release build: licence settings fixed by the image (D-039)', () => {
  const release = parseBuildInfo({
    edition: 'release',
    version: '0.1.0',
    locked: { 'licence.mode': 'required', 'licence.serverUrl': 'https://api.console.buildbase.app', 'licence.orgId': '6b01478bb42d2c444e99fcd8' },
  });

  it('a build from source is a dev build: nothing is fixed', () => {
    expect(currentBuild()).toEqual(DEV_BUILD);
    const r = resolveConfig({ env: { RENDERWELD_LICENCE_MODE: 'off' } });
    expect(r.settings.get('licence.mode')).toMatchObject({ value: 'off', source: 'env' });
    expect(r.build.edition).toBe('dev');
  });

  it('fixed values have source "build"; the same value again is accepted', () => {
    const r = resolveConfig({ env: { RENDERWELD_LICENCE_MODE: 'required' }, build: release });
    expect(r.settings.get('licence.mode')).toMatchObject({ value: 'required', source: 'build', origin: 'release build 0.1.0' });
    expect(r.settings.get('licence.serverUrl')).toMatchObject({ value: 'https://api.console.buildbase.app', source: 'build' });
    expect(r.config.licence.orgId).toBe('6b01478bb42d2c444e99fcd8');
    // Other licence settings stay configurable.
    expect(resolveConfig({ env: { RENDERWELD_LICENCE_OFFLINE_GRACE_DAYS: '3' }, build: release }).config.licence.offlineGraceDays).toBe(3);
  });

  it('the config file or env cannot change them: every attempt is refused at start with a clear error', () => {
    const found = issues(() =>
      resolveConfig({
        env: { RENDERWELD_LICENCE_MODE: 'off', RENDERWELD_LICENCE_SERVER_URL: 'http://fake-licence.local' },
        file: file({ licence: { orgId: 'aaaaaaaaaaaaaaaaaaaaaaaa' } }),
        build: release,
      })
    );
    expect(found.map((i) => [i.key, i.source, i.origin])).toEqual([
      ['licence.mode', 'env', 'RENDERWELD_LICENCE_MODE'],
      ['licence.serverUrl', 'env', 'RENDERWELD_LICENCE_SERVER_URL'],
      ['licence.orgId', 'file', '/etc/reelforge.yaml'],
    ]);
    expect(found[0]!.message).toMatch(/fixed by this release build to "required".*noncommercial development only \(LICENSING\.md\)/);
  });

  it('update_config refuses them with build_locked_setting; get_config shows the source and the edition', async () => {
    const repos = createMemoryRepositories();
    const rc = new RuntimeConfig(repos, { env: { RENDERWELD_SECRET_KEY: KEY }, build: release });
    await rc.load();
    const err = await rc.update({ 'licence.mode': 'off', 'licence.serverUrl': 'http://fake.local' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'build_locked_setting', status: 409 });
    expect(err.details.issues.map((i: { key: string; code: string }) => [i.key, i.code])).toEqual([
      ['licence.mode', 'build_locked'],
      ['licence.serverUrl', 'build_locked'],
    ]);
    expect(await repos.settings.list()).toEqual([]);
    const report = rc.report({ prefix: 'licence' });
    expect(report.edition).toBe('release');
    expect(report.settings.find((s) => s.key === 'licence.mode')).toMatchObject({ value: 'required', source: 'build', origin: 'release build 0.1.0' });
    // The licence key itself stays a runtime setting.
    await rc.update({ 'licence.key': 'ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2' });
    expect(rc.report({ prefix: 'licence.key' }).settings[0]).toMatchObject({ value: 'set', source: 'runtime' });
  });

  it('build-info.json is checked: a release build must fix all three, mode only to "required", and nothing else', () => {
    expect(() => parseBuildInfo({ edition: 'release', locked: { 'licence.mode': 'required' } })).toThrow(/must fix "licence.serverUrl".*must fix "licence.orgId"/);
    expect(() =>
      parseBuildInfo({ edition: 'release', locked: { 'licence.mode': 'off', 'licence.serverUrl': 'https://a.example', 'licence.orgId': 'aaaaaaaa' } })
    ).toThrow(/to "required"/);
    expect(() => parseBuildInfo({ edition: 'dev', locked: { 'server.port': 1 } })).toThrow(/cannot be fixed by a build/);
    expect(() => parseBuildInfo({ edition: 'release', locked: {}, extra: 1 })).toThrow();
    expect(parseBuildInfo({ edition: 'dev' })).toMatchObject({ edition: 'dev', locked: {} });
  });
});

describe('SecretCipher (AES-256-GCM)', () => {
  it('round-trips, uses a fresh IV, and binds the value to its name', () => {
    const c = new SecretCipher(KEY);
    const a = c.encrypt('ELEVENLABS_API_KEY', 'sk_live_value');
    const b = c.encrypt('ELEVENLABS_API_KEY', 'sk_live_value');
    expect(a).not.toBe(b);
    expect(a).not.toContain('sk_live_value');
    expect(a.startsWith(`v1.${c.kid}.`)).toBe(true);
    expect(c.decrypt('ELEVENLABS_API_KEY', a)).toBe('sk_live_value');
    expect(new SecretCipher(KEY).decrypt('ELEVENLABS_API_KEY', a)).toBe('sk_live_value');
    expect(() => c.decrypt('OTHER_NAME', a)).toThrow(/authentication failed/);
  });

  it('detects a wrong key and changed data without revealing the value', () => {
    const c = new SecretCipher(KEY);
    const v = c.encrypt('licence.key', 'LIC-SECRET');
    expect(() => new SecretCipher('another-secret-key-0123456789abcdefgh').decrypt('licence.key', v)).toThrow(/different RENDERWELD_SECRET_KEY/);
    const parts = v.split('.');
    parts[4] = Buffer.from('tampered!').toString('base64url');
    try {
      c.decrypt('licence.key', parts.join('.'));
      throw new Error('no error');
    } catch (e) {
      expect((e as Error).message).toMatch(/authentication failed/);
      expect((e as Error).message).not.toContain('LIC-SECRET');
    }
    expect(() => new SecretCipher('short')).toThrow(/at least 32 characters/);
  });
});

describe('RuntimeConfig', () => {
  const fresh = async (env: NodeJS.ProcessEnv = { RENDERWELD_SECRET_KEY: KEY }, repos = createMemoryRepositories()) => {
    const rc = new RuntimeConfig(repos, { env });
    await rc.load();
    return { rc, repos };
  };

  it('changes a runtime setting: source becomes runtime, it is stored, and listeners hear about it', async () => {
    const { rc, repos } = await fresh({ RENDERWELD_SECRET_KEY: KEY, RENDERWELD_RATE_LIMIT_PER_MINUTE: '100' });
    const heard: string[][] = [];
    rc.onChange((_r, keys) => heard.push(keys));
    const r = await rc.update({ 'limits.rateLimitPerMinute': 5 }, 'key_admin');
    expect(r.changes).toEqual([{ key: 'limits.rateLimitPerMinute', from: 100, to: 5 }]);
    expect(r.settings[0]).toMatchObject({ key: 'limits.rateLimitPerMinute', value: 5, source: 'runtime', updatedBy: 'key_admin', scope: 'runtime' });
    expect(heard).toEqual([['limits.rateLimitPerMinute']]);
    expect((await repos.settings.list())[0]).toMatchObject({ key: 'limits.rateLimitPerMinute', value: '5', scheme: 'plain', updatedBy: 'key_admin' });
    // null clears the runtime value: the environment applies again.
    await rc.update({ limits: { rateLimitPerMinute: null } });
    expect(rc.report({ prefix: 'limits.rateLimitPerMinute' }).settings[0]).toMatchObject({ value: 100, source: 'env', origin: 'RENDERWELD_RATE_LIMIT_PER_MINUTE' });
  });

  it('refuses start-up-only keys with where to set them, and changes nothing (all or nothing)', async () => {
    const { rc, repos } = await fresh();
    const err = await rc.update({ 'limits.rateLimitPerMinute': 7, 'server.port': 9999 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'startup_only_setting', status: 409 });
    expect(err.message).toContain('server.port');
    expect(err.message).toContain('RENDERWELD_PORT');
    expect(err.message).toContain('RENDERWELD_CONFIG');
    expect(err.details.issues[0]).toMatchObject({ key: 'server.port', code: 'startup_only', setIn: { configFile: 'server.port', env: ['RENDERWELD_PORT'] } });
    expect(await repos.settings.list()).toEqual([]);
    expect(rc.config.limits.rateLimitPerMinute).toBe(300);
    const db = await rc.update({ 'database.url': 'postgresql://x/y' }).catch((e) => e);
    expect(db.details.issues[0].setIn.env).toEqual(['RENDERWELD_DATABASE_URL', 'RENDERWELD_DATABASE_URL_FILE', 'DATABASE_URL', 'DATABASE_URL_FILE']);
    expect(db.message).not.toContain('postgresql://x/y');
  });

  it('refuses unknown keys and invalid values with every problem listed', async () => {
    const { rc } = await fresh();
    const err = await rc.update({ 'limits.rateLimit': 1, 'limits.renderConcurrency': 0, 'logging.level': 'loud', 'licence.key': 'two\nlines' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'invalid_setting', status: 422 });
    expect(err.details.issues.map((i: { key: string; code: string }) => `${i.key}:${i.code}`)).toEqual([
      'limits.rateLimit:unknown_setting',
      'limits.renderConcurrency:invalid_value',
      'logging.level:invalid_value',
      'licence.key:invalid_value',
    ]);
    expect(JSON.stringify(err.details)).not.toContain('two\\nlines');
    await expect(rc.update({})).rejects.toMatchObject({ code: 'bad_request' });
    await expect(rc.update(null)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('refuses to store secrets without RENDERWELD_SECRET_KEY and says how to set it', async () => {
    const { rc, repos } = await fresh({});
    expect(rc.report().secretKey).toBe('not set');
    const err = await rc.update({ 'providers.elevenlabs.apiKey': 'sk_nope_1234' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'secret_key_required', status: 409 });
    expect(err.message).toMatch(/RENDERWELD_SECRET_KEY.*openssl rand -base64 32/);
    expect(err.message).not.toContain('sk_nope_1234');
    await expect(rc.setProviderValues({ ELEVENLABS_API_KEY: 'sk_nope_1234' }, 'elevenlabs')).rejects.toMatchObject({ code: 'secret_key_required' });
    expect(await repos.providerSettings.values()).toEqual({});
    // Non-secret runtime settings still work without the key.
    await rc.update({ 'logging.level': 'debug' });
    expect(rc.config.logging.level).toBe('debug');
  });

  it('stores secrets encrypted and shows them only as set / not set', async () => {
    const { rc, repos } = await fresh({ RENDERWELD_SECRET_KEY: KEY, DATABASE_URL: 'postgresql://user:dbpass-secret@db/rf' });
    const r = await rc.update({ 'licence.key': 'LIC-SECRET-1', 'providers.elevenlabs.apiKey': 'sk_secret_2' });
    expect(r.changes).toEqual([
      { key: 'licence.key', from: 'not set', to: 'set' },
      { key: 'providers.elevenlabs.apiKey', from: 'not set', to: 'set' },
    ]);
    const report = rc.report();
    const text = JSON.stringify(report);
    for (const s of ['LIC-SECRET-1', 'sk_secret_2', 'dbpass-secret', KEY]) expect(text).not.toContain(s);
    const entry = (k: string) => report.settings.find((s) => s.key === k)!;
    expect(entry('licence.key')).toMatchObject({ value: 'set', source: 'runtime', secret: true, atRest: 'aes-256-gcm' });
    expect(entry('providers.elevenlabs.apiKey')).toMatchObject({ value: 'set', source: 'runtime', atRest: 'aes-256-gcm' });
    expect(entry('database.url')).toMatchObject({ value: 'set', source: 'env', origin: 'DATABASE_URL' });
    expect(entry('security.bootstrapKey')).toMatchObject({ value: 'not set', source: 'default' });
    expect(entry('security.secretKey')).toMatchObject({ value: 'set', source: 'env' });
    const stored = JSON.stringify([await repos.settings.list(), await repos.providerSettings.values()]);
    expect(stored).not.toContain('LIC-SECRET-1');
    expect(stored).not.toContain('sk_secret_2');
    // The provider key is in ProviderSetting (shared with configure_provider) and reaches the provider env overlay.
    expect(Object.keys(await repos.providerSettings.values())).toEqual(['ELEVENLABS_API_KEY']);
    expect(rc.providerEnvOverlay().ELEVENLABS_API_KEY).toBe('sk_secret_2');
  });

  it('encrypts plaintext provider settings once when the key is present, and keeps working without the key', async () => {
    const repos = createMemoryRepositories();
    await repos.providerSettings.apply({ ELEVENLABS_API_KEY: { value: 'sk_plain_v01', scheme: 'plain' }, PLUGIN_TOKEN: { value: 'tok', scheme: 'plain' } }, new Date().toISOString(), 'elevenlabs');
    const without = await fresh({}, repos);
    expect(without.rc.config.providers.elevenlabs.apiKey).toBe('sk_plain_v01');
    expect(without.rc.warnings().join()).toMatch(/2 provider setting\(s\) are stored in plain text \(ELEVENLABS_API_KEY, PLUGIN_TOKEN\)/);
    expect(await without.rc.encryptPlaintext()).toEqual([]);
    const withKey = await fresh({ RENDERWELD_SECRET_KEY: KEY }, repos);
    expect(await withKey.rc.encryptPlaintext()).toEqual(['ELEVENLABS_API_KEY', 'PLUGIN_TOKEN']);
    expect(await withKey.rc.encryptPlaintext()).toEqual([]);
    const rows = await repos.providerSettings.values();
    expect(Object.values(rows).map((r) => r.scheme)).toEqual(['aes-256-gcm', 'aes-256-gcm']);
    expect(JSON.stringify(rows)).not.toContain('sk_plain_v01');
    expect(withKey.rc.config.providers.elevenlabs.apiKey).toBe('sk_plain_v01');
    expect(withKey.rc.providerEnvOverlay().PLUGIN_TOKEN).toBe('tok');
    expect((await repos.providerSettings.list())[0]!.providerId).toBe('elevenlabs');
  });

  it('reports a secret it cannot decrypt (wrong or missing key) instead of failing to start', async () => {
    const repos = createMemoryRepositories();
    await (await fresh({ RENDERWELD_SECRET_KEY: KEY }, repos)).rc.update({ 'providers.elevenlabs.apiKey': 'sk_x', 'licence.key': 'LIC' });
    for (const env of [{}, { RENDERWELD_SECRET_KEY: 'a-different-secret-key-0123456789abc' }]) {
      const { rc } = await fresh(env, repos);
      expect(rc.config.providers.elevenlabs.apiKey).toBeUndefined();
      expect(rc.config.licence.key).toBeUndefined();
      const e = rc.report().settings.find((s) => s.key === 'providers.elevenlabs.apiKey')!;
      expect(e.error).toMatch(/cannot decrypt the stored value of ELEVENLABS_API_KEY/);
      expect(rc.warnings().join()).toMatch(/cannot decrypt/);
    }
  });

  it('ignores a stored runtime value that no longer validates, with a warning', async () => {
    const repos = createMemoryRepositories();
    await repos.settings.apply({ 'limits.renderConcurrency': { value: '0', scheme: 'plain' }, 'server.port': { value: '1', scheme: 'plain' }, 'gone.key': { value: '1', scheme: 'plain' } }, new Date().toISOString());
    const { rc } = await fresh({}, repos);
    expect(rc.config.limits.renderConcurrency).toBe(1);
    expect(rc.config.server.port).toBe(4321);
    expect(rc.warnings().join('\n')).toMatch(/renderConcurrency/);
    expect(rc.warnings().join('\n')).toMatch(/"server.port", which is start-up only/);
    expect(rc.warnings().join('\n')).toMatch(/unknown setting "gone.key"/);
  });
});

describe('RenderWeldService configuration', () => {
  it('applies runtime settings live, audit-logs changes, and refuses provider keys without the secret key', async () => {
    const repos = createMemoryRepositories();
    const providerEnv: NodeJS.ProcessEnv = {};
    const registry = new PluginRegistry().registerEngine(fakeEngine('remotion')).registerProvider(new ElevenLabsTts(providerEnv));
    const s = await RenderWeldService.create(registry, { repositories: repos, dataDir: join(dir, 'svc'), providerEnv, configSources: { env: {} } });
    await expect(s.configureProvider('elevenlabs', { ELEVENLABS_API_KEY: 'sk_refused' })).rejects.toMatchObject({ code: 'secret_key_required' });
    const r = await s.updateConfig({ 'limits.renderConcurrency': 3, 'limits.maxUploadBytes': 1234 }, { actorType: 'api_key', actorId: 'key_1' });
    expect(r.changes.map((c) => c.key)).toEqual(['limits.renderConcurrency', 'limits.maxUploadBytes']);
    expect(s.jobs.concurrency).toBe(3);
    expect(s.assets.limits.maxBytes).toBe(1234);
    expect(s.capabilities().limits).toMatchObject({ renderConcurrency: 3, maxUploadBytes: 1234 });
    const [entry] = await repos.audit.list({ limit: 1 });
    expect(entry).toMatchObject({ action: 'config.update', actorType: 'api_key', actorId: 'key_1', data: { changes: [{ key: 'limits.renderConcurrency', from: 1, to: 3 }, { key: 'limits.maxUploadBytes', from: 209715200, to: 1234 }] } });
    // A new service on the same database starts with the runtime values.
    const again = await RenderWeldService.create(new PluginRegistry().registerEngine(fakeEngine('remotion')), { repositories: repos, dataDir: join(dir, 'svc'), configSources: { env: {} } });
    expect(again.jobs.concurrency).toBe(3);
    expect(again.getConfig({ prefix: 'limits' }).settings.map((x) => x.source)).toEqual(['default', 'default', ...Array(4).fill('default'), 'runtime', 'default', 'runtime', ...Array(13).fill('default')]);
  });

  it('applies the encoder memory settings (#307) at start and at runtime, to every encode of the process', async () => {
    const make = (env: NodeJS.ProcessEnv) =>
      RenderWeldService.create(new PluginRegistry().registerEngine(fakeEngine('remotion')), { repositories: createMemoryRepositories(), dataDir: join(dir, 'svc-enc'), configSources: { env } });
    try {
      await make({});
      expect(encoderSettings()).toEqual({ threads: 2, lookahead: 20 });
      const s = await make({ RENDERWELD_RENDER_ENCODER_THREADS: '0' });
      expect(encoderSettings()).toEqual({ threads: 0, lookahead: 20 });
      await s.updateConfig({ 'render.encoderThreads': 3, 'render.encoderLookahead': 12 });
      expect(encoderSettings()).toEqual({ threads: 3, lookahead: 12 });
      expect(h264Args().join(' ')).toContain('-threads 3');
    } finally {
      setEncoderSettings(DEFAULT_ENCODER_SETTINGS);
    }
  });

  it('configure_provider stores encrypted values that providers see, and get_config shows the same key as runtime', async () => {
    const repos = createMemoryRepositories();
    const providerEnv: NodeJS.ProcessEnv = { ELEVENLABS_API_KEY: 'sk_from_env' };
    const registry = new PluginRegistry().registerEngine(fakeEngine('remotion')).registerProvider(new ElevenLabsTts(providerEnv));
    const s = await RenderWeldService.create(registry, { repositories: repos, dataDir: join(dir, 'svc2'), providerEnv, configSources: { env: { ...providerEnv, RENDERWELD_SECRET_KEY: KEY } } });
    expect((await s.listProviders())[0]!.settings[0]).toMatchObject({ set: true, source: 'env' });
    await s.configureProvider('elevenlabs', { ELEVENLABS_API_KEY: 'sk_from_api' });
    expect(providerEnv.ELEVENLABS_API_KEY).toBe('sk_from_api');
    expect((await s.listProviders())[0]!.settings[0]).toMatchObject({ set: true, source: 'api' });
    expect(s.getConfig({ prefix: 'providers' }).settings[0]).toMatchObject({ key: 'providers.elevenlabs.apiKey', value: 'set', source: 'runtime', atRest: 'aes-256-gcm' });
    await s.updateConfig({ 'providers.elevenlabs.apiKey': null });
    expect(providerEnv.ELEVENLABS_API_KEY).toBe('sk_from_env');
    expect((await s.listProviders())[0]!.settings[0]).toMatchObject({ set: true, source: 'env' });
  });
});

describe('number settings from the environment (#343 CodeQL)', () => {
  it('parses plain decimals and refuses a long hostile digit string in linear time', async () => {
    const { NUMBER_TEXT } = await import('../src/config/load');
    for (const ok of ['1', '-1.5', '.5', '3.']) expect(NUMBER_TEXT.test(ok)).toBe(true);
    for (const bad of ['1.2.3', 'abc', '-', '']) expect(NUMBER_TEXT.test(bad)).toBe(false);
    const hostile = '9' + '99'.repeat(50_000) + 'x';
    const t = performance.now();
    expect(NUMBER_TEXT.test(hostile)).toBe(false);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
