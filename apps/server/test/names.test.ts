import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@renderweld/core';
import { startServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/**
 * The product's names on a real server and CLI (#413): RENDERWELD_* variables
 * only, the one `renderweld` command, and image labels that say RenderWeld.
 */
const { dir, cleanup } = tempDir('renderweld-names-srv-');
const drops: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const d of drops) await d();
  cleanup();
});

const SECRET_KEY = 'names-server-secret-key-0123456789abcdef';
const repo = resolve(__dirname, '../../..');
const tsx = join(repo, 'node_modules/.bin/tsx');
const registry = () => new PluginRegistry().registerEngine(fakeEngine('remotion'));
const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(tsx, ['apps/server/src/cli.ts', ...args], { cwd: repo, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 60_000 });

describe('server start-up', () => {
  it('reads RENDERWELD_* names and the config file without warnings; REELFORGE_* names are not read', async () => {
    const dataDir = join(dir, 'names');
    const db = await testDatabase(dataDir);
    drops.push(db.drop);
    const configFile = join(dir, 'renderweld.yaml');
    writeFileSync(configFile, 'limits:\n  maxJsonBytes: 65536\n');
    const lines: string[] = [];
    const server = await startServer(
      { dataDir, port: 0, host: '127.0.0.1' },
      {
        registry,
        env: { ...db.env, RENDERWELD_CONFIG: configFile, RENDERWELD_RATE_LIMIT_PER_MINUTE: '321', REELFORGE_MAX_JSON_BYTES: '1000', RENDERWELD_SECRET_KEY: SECRET_KEY, RENDERWELD_LICENCE_MODE: 'off', RENDERWELD_LOG_LEVEL: 'info' },
        logWrite: (_level, line) => lines.push(line),
        licence: { start: false },
      }
    );
    try {
      expect(server.config.rateLimitPerMinute).toBe(321);
      // The file's value stands: the old variable name is ignored.
      expect(server.config.resolved.config.limits.maxJsonBytes).toBe(65536);
      const text = lines.join('\n');
      expect(text).not.toMatch(/old name|REELFORGE_/);
      expect(text).not.toContain(SECRET_KEY);
      const report = server.service.getConfig({ prefix: 'limits' });
      expect(report.settings.find((s) => s.key === 'limits.maxJsonBytes')).toMatchObject({ source: 'file', origin: configFile });
      expect(report.settings.find((s) => s.key === 'limits.rateLimitPerMinute')).toMatchObject({ source: 'env', origin: 'RENDERWELD_RATE_LIMIT_PER_MINUTE' });
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe('the renderweld command', () => {
  it('is the only command: package.json, the image and the source ship no other name', () => {
    const pkg = JSON.parse(readFileSync(join(repo, 'apps/server/package.json'), 'utf8'));
    expect(pkg.bin).toEqual({ renderweld: './src/cli.ts' });
    const dockerfile = readFileSync(join(repo, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/> \/usr\/local\/bin\/renderweld /);
    expect(dockerfile).not.toMatch(/\/usr\/local\/bin\/reelforge/);
    expect(existsSync(join(repo, 'apps/server/src/reelforge.ts'))).toBe(false);
  });

  it('usage and messages name renderweld', () => {
    expect(run([]).stdout).toMatch(/^ {2}renderweld migrate/m);
    const worker = run(['worker']);
    expect(worker.status).toBe(1);
    expect(worker.stderr).toMatch(/^usage: renderweld worker --once/m);
  }, 120_000);

  it('the image labels say RenderWeld, its seller and both licences (#413, #779)', () => {
    const dockerfile = readFileSync(join(repo, 'Dockerfile'), 'utf8');
    const labels = Object.fromEntries([...dockerfile.matchAll(/^\s*(?:LABEL\s+)?([a-z.]+)="([^"]*)"/gm)].map((m) => [m[1], m[2]]));
    expect(labels).toMatchObject({
      'org.opencontainers.image.title': 'RenderWeld',
      'org.opencontainers.image.url': 'https://renderweld.com',
      // The seller, and both licences a buyer can hold (#779).
      'org.opencontainers.image.vendor': 'Jagodana LLC',
      'org.opencontainers.image.licenses': 'PolyForm-Noncommercial-1.0.0 OR LicenseRef-RenderWeld-Commercial',
      'app.renderweld.edition': '${RENDERWELD_EDITION}',
    });
    // Both licences, the trademark policy and the guide to them ship in /app (#779).
    expect(dockerfile).toMatch(/^COPY LICENSE\.md NOTICE COMMERCIAL-LICENSE\.md TRADEMARK\.md LICENSING\.md \/app\/$/m);
    expect(Object.keys(labels).filter((k) => k.includes('reelforge'))).toEqual([]);
    expect(labels['org.opencontainers.image.description']).toMatch(/^Self-hosted video rendering for AI agents/);
  });

  it('config check and config show name the variable that supplied each value', () => {
    const configFile = join(dir, 'check.yaml');
    writeFileSync(configFile, 'limits:\n  renderConcurrency: 3\n');
    const env = { RENDERWELD_DATA_DIR: join(dir, 'cli'), RENDERWELD_PORT: '4400', RENDERWELD_RATE_LIMIT_PER_MINUTE: '99', REELFORGE_PORT: '4999', RENDERWELD_SECRET_KEY: SECRET_KEY };
    const check = run(['config', 'check', '--file', configFile], env);
    expect(check.status).toBe(0);
    expect(check.stdout).toMatch(new RegExp(`configuration is valid \\(config file ${configFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    expect(check.stdout).toMatch(/^ {2}server\.port <- RENDERWELD_PORT$/m);
    expect(check.stdout).toMatch(/^ {2}limits\.rateLimitPerMinute <- RENDERWELD_RATE_LIMIT_PER_MINUTE$/m);
    expect(check.stdout).not.toMatch(/REELFORGE|old name/);
    expect(check.stdout).not.toContain(SECRET_KEY);
    const show = run(['config', 'show', '--offline'], env);
    expect(show.status).toBe(0);
    expect(show.stdout).toMatch(/server\.port\s+4400\s+\(env: RENDERWELD_PORT, start-up only\)$/m);
    expect(show.stdout).not.toContain(SECRET_KEY);
  }, 120_000);
});
