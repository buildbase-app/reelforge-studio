// Unit tests for the local setup helpers (scripts/dev/lib.mjs): `pnpm test:dev`.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { weakKeyReason } from '../../packages/core/src/keyStrength';
import { RENAMED_ENV } from '../../packages/core/src/config/rename';
import {
  compareVersions,
  envEntries,
  findChromium,
  generateApiKey,
  generateSecretKey,
  headlessShellExe,
  mergeEnv,
  missingFfmpegFeatures,
  nodeMeets,
  parseEnvText,
  parseFfmpegVersion,
  planEnvFile,
  portFree,
} from './lib.mjs';

describe('prerequisite parsing', () => {
  it('reads FFmpeg versions from distro, static, Windows and git builds', () => {
    expect(parseFfmpegVersion('ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers')).toEqual([6, 1, 1]);
    expect(parseFfmpegVersion('ffmpeg version 5.1.6-0+deb12u1 Copyright (c) 2000-2024')).toEqual([5, 1, 6]);
    expect(parseFfmpegVersion('ffmpeg version n7.0.2 Copyright')).toEqual([7, 0, 2]);
    expect(parseFfmpegVersion('ffmpeg version 7.1-essentials_build-www.gyan.dev Copyright')).toEqual([7, 1, 0]);
    expect(parseFfmpegVersion('ffmpeg version 4.4.2-0ubuntu0.22.04.1')).toEqual([4, 4, 2]);
    expect(parseFfmpegVersion('ffmpeg version N-118000-g1234abcd Copyright')).toBeNull();
    expect(parseFfmpegVersion('command not found')).toBeNull();
  });

  it('compares versions part by part', () => {
    expect(compareVersions([4, 4, 2], [5, 1])).toBe(-1);
    expect(compareVersions([5, 1, 0], [5, 1])).toBe(0);
    expect(compareVersions([6, 1, 1], [5, 1])).toBe(1);
  });

  it('finds missing encoders and filters in ffmpeg listings', () => {
    const encoders = ' V....D libx264              libx264 H.264 / AVC\n A....D aac                  AAC (Advanced Audio Coding)\n';
    expect(missingFfmpegFeatures(encoders, ['libx264', 'aac'])).toEqual([]);
    const filters = ' ... alimiter          A->A       Audio lookahead limiter.\n ... ebur128           A->N       EBU R128 scanner.\n';
    expect(missingFfmpegFeatures(filters, ['alimiter', 'ebur128', 'ass'])).toEqual(['ass']);
  });

  it('checks the Node major against .nvmrc', () => {
    expect(nodeMeets('v22.11.0', '22')).toBe(true);
    expect(nodeMeets('v24.1.0', '22')).toBe(true);
    expect(nodeMeets('v20.18.0', '22')).toBe(false);
  });
});

describe('secrets', () => {
  it('secret key: 32 random bytes in base64 (openssl rand -base64 32)', () => {
    const k = generateSecretKey();
    expect(k).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(k, 'base64')).toHaveLength(32);
    expect(generateSecretKey()).not.toBe(k);
  });

  it('bootstrap key: passes the server strength check every time', () => {
    for (let i = 0; i < 200; i++) {
      const k = generateApiKey();
      expect(k).toMatch(/^rf_[A-Za-z0-9_-]{43}$/);
      expect(weakKeyReason(k)).toBeNull();
    }
  });
});

describe('.env.local', () => {
  const entries = (o = {}) => envEntries({ chromiumPath: '/opt/chs/chrome-headless-shell', ...o });

  it('a new file has every setting dev needs, and parses back', () => {
    const plan = planEnvFile(null, entries(), { date: '2026-11-25' });
    expect(plan.action).toBe('create');
    const v = parseEnvText(plan.content);
    expect(v).toMatchObject({
      RENDERWELD_PORT: '4321',
      RENDERWELD_DATA_DIR: './.data',
      RENDERWELD_LICENCE_MODE: 'off',
      RENDERWELD_DASHBOARD_ENABLED: 'true',
      RENDERWELD_CHROMIUM_PATH: '/opt/chs/chrome-headless-shell',
    });
    expect(Buffer.from(v.RENDERWELD_SECRET_KEY!, 'base64')).toHaveLength(32);
    expect(weakKeyReason(v.RENDERWELD_BOOTSTRAP_KEY!)).toBeNull();
    expect(v.RENDERWELD_DATABASE_URL).toBeUndefined(); // SQLite by default
  });

  it('every RENDERWELD_* name it writes is a real setting (no typos)', () => {
    const all = entries({ database: 'postgres', minio: true, stt: { command: '/x', model: 'tiny', modelDir: '/m' } });
    for (const x of all) {
      if (typeof x === 'string') continue;
      const [k] = x;
      if (k.startsWith('RENDERWELD_DEV_') || k.startsWith('TEST_')) continue; // dev compose and test variables
      expect(RENAMED_ENV.map((r) => r.name), k).toContain(k);
    }
  });

  it('an existing file is never changed without --force', () => {
    const first = planEnvFile(null, entries()).content;
    const again = planEnvFile(first, entries());
    expect(again.action).toBe('keep');
    expect(again.content).toBe(first);
    // The secrets in the file survive a second run.
    expect(parseEnvText(again.content).RENDERWELD_SECRET_KEY).toBe(parseEnvText(first).RENDERWELD_SECRET_KEY);
  });

  it('a later --postgres only appends what is missing; a hand-edited value stays', () => {
    const first = planEnvFile(null, entries()).content.replace('RENDERWELD_PORT=4321', 'RENDERWELD_PORT=4400');
    const plan = planEnvFile(first, entries({ database: 'postgres' }));
    expect(plan.action).toBe('append');
    expect(plan.content.startsWith(first)).toBe(true);
    expect(plan.added).toEqual(['RENDERWELD_DEV_POSTGRES_PASSWORD', 'RENDERWELD_DATABASE_URL', 'TEST_POSTGRES_URL']);
    expect(plan.conflicts).toEqual(['RENDERWELD_PORT']);
    const v = parseEnvText(plan.content);
    expect(v.RENDERWELD_PORT).toBe('4400');
    expect(v.RENDERWELD_DATABASE_URL).toBe(`postgresql://renderweld:${v.RENDERWELD_DEV_POSTGRES_PASSWORD}@127.0.0.1:5432/renderweld`);
  });

  it('switching database without --force keeps the old URL and reports it', () => {
    const pg = planEnvFile(null, entries({ database: 'postgres' })).content;
    const plan = planEnvFile(pg, entries({ database: 'mysql' }));
    expect(plan.conflicts).toContain('RENDERWELD_DATABASE_URL');
    expect(parseEnvText(plan.content).RENDERWELD_DATABASE_URL).toMatch(/^postgresql:/);
  });

  it('--force replaces the file with new secrets', () => {
    const first = planEnvFile(null, entries()).content;
    const plan = planEnvFile(first, entries(), { force: true });
    expect(plan.action).toBe('replace');
    expect(parseEnvText(plan.content).RENDERWELD_SECRET_KEY).not.toBe(parseEnvText(first).RENDERWELD_SECRET_KEY);
  });

  it('values that need quoting survive the round trip', () => {
    const plan = planEnvFile(null, ['# c', ['RENDERWELD_CHROMIUM_PATH', 'C:\\Program Files\\chs # x']]);
    expect(parseEnvText(plan.content).RENDERWELD_CHROMIUM_PATH).toBe('C:\\Program Files\\chs # x');
  });
});

describe('dev:all environment', () => {
  it('the shell wins over the file', () => {
    const { env } = mergeEnv({ RENDERWELD_PORT: '4321' }, { RENDERWELD_PORT: '5000' });
    expect(env.RENDERWELD_PORT).toBe('5000');
  });

  it('an old REELFORGE_* name in the shell replaces the RENDERWELD_* twin instead of clashing', () => {
    const { env, notes } = mergeEnv({ RENDERWELD_CHROMIUM_PATH: '/file' }, { REELFORGE_CHROMIUM_PATH: '/shell' });
    expect(env.RENDERWELD_CHROMIUM_PATH).toBe('/shell');
    expect(env.REELFORGE_CHROMIUM_PATH).toBeUndefined();
    expect(notes).toHaveLength(1);
  });
});

describe('Chrome Headless Shell discovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-chs-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('prefers the configured path, then the newest Playwright revision', () => {
    const pw = join(dir, 'pw');
    for (const rev of ['1200', '1243']) {
      const p = join(pw, `chromium_headless_shell-${rev}`, headlessShellExe('linux', 'x64'));
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, '');
    }
    const env = { PLAYWRIGHT_BROWSERS_PATH: pw };
    expect(findChromium({ env, platform: 'linux', arch: 'x64', home: dir, repoDir: dir })).toEqual({
      path: join(pw, 'chromium_headless_shell-1243', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      source: 'playwright',
    });
    expect(findChromium({ env: { ...env, REELFORGE_CHROMIUM_PATH: join(dir, 'nope') }, platform: 'linux', home: dir, repoDir: dir })).toMatchObject({ path: null, missing: join(dir, 'nope') });
  });

  it('knows each platform layout', () => {
    expect(headlessShellExe('darwin', 'arm64')).toBe(join('chrome-headless-shell-mac-arm64', 'chrome-headless-shell'));
    expect(headlessShellExe('win32', 'x64')).toBe(join('chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    expect(findChromium({ env: {}, platform: 'linux', home: join(dir, 'empty'), repoDir: join(dir, 'empty') })).toBeNull();
  });
});

describe('ports', () => {
  it('sees a port in use', async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const { port } = srv.address() as { port: number };
    expect(await portFree(port)).toBe(false);
    await new Promise((r) => srv.close(r));
    expect(await portFree(port)).toBe(true);
  });
});
