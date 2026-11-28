import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveConfig, type RuntimeConfig } from '@renderweld/core';
import { findRemotion, REMOTION_VERSION } from '../src/load';
import { remotionEngine, remotionInstall } from '../src/plugin';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A folder laid out like a customer's own Remotion install (only the package.json files matter here). */
function fakeHome(version: string): string {
  const home = mkdtempSync(join(tmpdir(), 'rw-remotion-'));
  dirs.push(home);
  for (const pkg of ['remotion', '@remotion/renderer']) {
    mkdirSync(join(home, 'node_modules', pkg), { recursive: true });
    writeFileSync(join(home, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg, version, main: 'index.js' }));
  }
  return home;
}

type RemotionSettings = { enabled: boolean; licenceAccepted: 'none' | 'remotion'; licenseKey?: string; home: string };
const settings = (edition: 'dev' | 'release', remotion: Partial<RemotionSettings> = {}): RuntimeConfig =>
  ({
    current: {
      build: { edition, locked: {} },
      config: { engines: { remotion: { enabled: false, licenceAccepted: 'none', home: '/nonexistent', ...remotion } } },
    },
  }) as unknown as RuntimeConfig;

const reason = (s: RuntimeConfig) => {
  const r = remotionInstall(s);
  return 'reason' in r ? r.reason : null;
};

describe('Remotion licence gate (L30)', () => {
  it('defaults: off, licence not accepted, no key', () => {
    const r = resolveConfig({ env: {} }).config.engines.remotion;
    expect(r).toMatchObject({ enabled: false, licenceAccepted: 'none', home: '/opt/remotion' });
    expect(r.licenseKey).toBeUndefined();
  });

  it('development builds render with this checkout, no key needed (personal testing)', () => {
    const r = remotionInstall(settings('dev'));
    expect('install' in r && r.install.from).toBe('workspace');
    expect('install' in r && r.install.version).toBe(REMOTION_VERSION);
  });

  it('the release edition refuses until every step is done, saying which one is missing', () => {
    const home = fakeHome(REMOTION_VERSION);
    expect(reason(settings('release'))).toMatch(/Remotion is off.*own Remotion licence/);
    expect(reason(settings('release', { enabled: true }))).toMatch(/licence is not accepted/);
    expect(reason(settings('release', { enabled: true, licenceAccepted: 'remotion' }))).toMatch(/no Remotion licence key/);
    expect(reason(settings('release', { enabled: true, licenceAccepted: 'remotion', licenseKey: 'k' }))).toMatch(/not installed at \/nonexistent/);
    expect(reason(settings('release', { enabled: true, licenceAccepted: 'remotion', licenseKey: 'k', home: fakeHome('4.0.1') }))).toMatch(
      new RegExp(`4\\.0\\.1 is installed.*needs Remotion ${REMOTION_VERSION.replace(/\./g, '\\.')}`)
    );
    const ok = remotionInstall(settings('release', { enabled: true, licenceAccepted: 'remotion', licenseKey: 'k', home }));
    expect('install' in ok && ok.install).toMatchObject({ from: 'home', version: REMOTION_VERSION });
  });

  it('the release edition never falls back to the copy in this checkout', () => {
    expect(findRemotion('/nonexistent', false)).toBeNull();
    expect(findRemotion('/nonexistent', true)?.from).toBe('workspace');
  });

  it('the engine reports the reason as unavailable, so render requests are refused up front', () => {
    const engine = remotionEngine({ browserExecutable: process.execPath });
    engine.useSettings?.(settings('release'));
    expect(engine.availability()).toMatchObject({ ok: false, reason: expect.stringMatching(/own Remotion licence/) });
    expect(engine.version()).toBe('not installed');
    engine.useSettings?.(settings('dev'));
    expect(engine.availability()).toEqual({ ok: true });
    expect(engine.version()).toBe(REMOTION_VERSION);
  });
});
