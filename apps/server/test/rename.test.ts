import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, PluginRegistry } from '@reelforge/core';
import { startServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/**
 * The rename compatibility layer on a real server and CLI (#412): RENDERWELD_*
 * names, the old REELFORGE_* names with one warning each, conflicts stop the
 * start, and the `renderweld` / `reelforge` commands.
 */
const { dir, cleanup } = tempDir('reelforge-rename-srv-');
const drops: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const d of drops) await d();
  cleanup();
});

const SECRET_KEY = 'rename-server-secret-key-0123456789abcdef';
const OTHER_KEY = 'rename-server-other-key-0123456789abcdef';
const repo = resolve(__dirname, '../../..');
const tsx = join(repo, 'node_modules/.bin/tsx');
const registry = () => new PluginRegistry().registerEngine(fakeEngine('remotion'));

describe('server start-up with old and new names', () => {
  it('an old name alone works and is warned about exactly once per variable (also after a runtime change); new names are silent', async () => {
    const dataDir = join(dir, 'warn');
    const db = await testDatabase(dataDir);
    drops.push(db.drop);
    const configFile = join(dir, 'renderweld.yaml');
    writeFileSync(configFile, 'limits:\n  maxJsonBytes: 65536\n');
    const lines: string[] = [];
    const server = await startServer(
      { dataDir, port: 0, host: '127.0.0.1' },
      {
        registry,
        env: { ...db.env, RENDERWELD_CONFIG: configFile, REELFORGE_RATE_LIMIT_PER_MINUTE: '321', REELFORGE_SECRET_KEY: SECRET_KEY, RENDERWELD_LICENCE_MODE: 'off', RENDERWELD_LOG_LEVEL: 'info' },
        logWrite: (_level, line) => lines.push(line),
        licence: { start: false },
      }
    );
    try {
      expect(server.config.rateLimitPerMinute).toBe(321);
      expect(server.config.resolved.config.limits.maxJsonBytes).toBe(65536);
      await server.service.updateConfig({ 'limits.rateLimitPerMinute': 222 });
      const text = lines.join('\n');
      const count = (s: string) => text.split(s).length - 1;
      expect(count('REELFORGE_RATE_LIMIT_PER_MINUTE is an old name: rename it to RENDERWELD_RATE_LIMIT_PER_MINUTE')).toBe(1);
      expect(count('REELFORGE_SECRET_KEY is an old name: rename it to RENDERWELD_SECRET_KEY')).toBe(1);
      expect(count('is an old name')).toBe(2);
      expect(text).not.toContain(SECRET_KEY);
      // get_config names the variable that supplied each value.
      const report = server.service.getConfig({ prefix: 'limits' });
      expect(report.settings.find((s) => s.key === 'limits.maxJsonBytes')).toMatchObject({ source: 'file', origin: configFile });
    } finally {
      await server.close();
    }
  }, 60_000);

  it('both names with different values stop the start, naming both and never the secret', async () => {
    const dataDir = join(dir, 'clash');
    const err = await startServer(
      { dataDir, port: 0, host: '127.0.0.1' },
      { registry, env: { RENDERWELD_SECRET_KEY: SECRET_KEY, REELFORGE_SECRET_KEY: OTHER_KEY, RENDERWELD_LICENCE_MODE: 'off' }, quiet: true, licence: { start: false } }
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ConfigError);
    const message = (err as Error).message;
    expect(message).toMatch(/RENDERWELD_SECRET_KEY, REELFORGE_SECRET_KEY: RENDERWELD_SECRET_KEY and its old name REELFORGE_SECRET_KEY are both set, with different values/);
    expect(message).not.toContain(SECRET_KEY);
    expect(message).not.toContain(OTHER_KEY);
  });
});

describe('the renderweld and reelforge commands', () => {
  const run = (entry: 'cli.ts' | 'reelforge.ts', args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(tsx, [`apps/server/src/${entry}`, ...args], { cwd: repo, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 60_000 });
  const NOTICE = /^reelforge: this command is now called renderweld \(ReelForge is now RenderWeld\); "reelforge" keeps working until a removal date announced in the release notes \(docs\/RENAMED\.md\)\.$/;

  it('package.json ships both bins: renderweld is the CLI, reelforge the old name', () => {
    const pkg = JSON.parse(readFileSync(join(repo, 'apps/server/package.json'), 'utf8'));
    expect(pkg.bin).toEqual({ renderweld: './src/cli.ts', reelforge: './src/reelforge.ts' });
    expect(readFileSync(join(repo, 'Dockerfile'), 'utf8')).toMatch(/\/usr\/local\/bin\/renderweld[\s\S]*\/usr\/local\/bin\/reelforge/);
  });

  it('reelforge prints one deprecation line on stderr; stdout is the same as renderweld; renderweld prints none', () => {
    const env = { RENDERWELD_DATA_DIR: join(dir, 'cli'), RENDERWELD_PORT: '4400', RENDERWELD_SECRET_KEY: SECRET_KEY };
    const fresh = run('cli.ts', ['config', 'check'], env);
    const old = run('reelforge.ts', ['config', 'check'], env);
    expect(fresh.status).toBe(0);
    expect(old.status).toBe(0);
    expect(old.stdout).toBe(fresh.stdout);
    expect(fresh.stderr).toBe('');
    expect(old.stderr.trim().split('\n')).toHaveLength(1);
    expect(old.stderr.trim()).toMatch(NOTICE);
    // Usage under the name the command was started with.
    expect(run('cli.ts', []).stdout).toMatch(/^ {2}renderweld migrate/m);
    expect(run('reelforge.ts', []).stdout).toMatch(/^ {2}reelforge migrate/m);
  }, 120_000);

  it('config check and config show name the variable that supplied each value, and flag old names', () => {
    const configFile = join(dir, 'renderweld.yaml');
    writeFileSync(configFile, 'limits:\n  renderConcurrency: 3\n');
    const env = { RENDERWELD_DATA_DIR: join(dir, 'cli'), RENDERWELD_PORT: '4400', REELFORGE_RATE_LIMIT_PER_MINUTE: '99', REELFORGE_SECRET_KEY: SECRET_KEY };
    const check = run('cli.ts', ['config', 'check', '--file', configFile], env);
    expect(check.status).toBe(0);
    expect(check.stdout).toMatch(new RegExp(`configuration is valid \\(config file ${configFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    expect(check.stdout).toMatch(/^ {2}server\.port <- RENDERWELD_PORT$/m);
    expect(check.stdout).toMatch(/^ {2}limits\.rateLimitPerMinute <- REELFORGE_RATE_LIMIT_PER_MINUTE \(old name; rename it to RENDERWELD_RATE_LIMIT_PER_MINUTE\)$/m);
    expect(check.stdout).toMatch(/^ {2}! REELFORGE_RATE_LIMIT_PER_MINUTE is an old name: rename it to RENDERWELD_RATE_LIMIT_PER_MINUTE/m);
    expect(check.stdout).not.toContain(SECRET_KEY);
    const show = run('cli.ts', ['config', 'show', '--offline'], env);
    expect(show.status).toBe(0);
    expect(show.stdout).toMatch(/server\.port\s+4400\s+\(env: RENDERWELD_PORT, start-up only\)$/m);
    expect(show.stdout).toMatch(/limits\.rateLimitPerMinute\s+99\s+\(env: REELFORGE_RATE_LIMIT_PER_MINUTE\)\s+\[old name; rename it to RENDERWELD_RATE_LIMIT_PER_MINUTE\]$/m);
    expect(show.stdout).not.toContain(SECRET_KEY);
  }, 120_000);

  it('config check fails on a clash, naming both names and no value; two different config files are refused too', () => {
    const clash = run('cli.ts', ['config', 'check'], { RENDERWELD_SECRET_KEY: SECRET_KEY, REELFORGE_SECRET_KEY: OTHER_KEY });
    expect(clash.status).toBe(1);
    expect(clash.stderr).toMatch(/RENDERWELD_SECRET_KEY and its old name REELFORGE_SECRET_KEY are both set, with different values/);
    expect(clash.stderr + clash.stdout).not.toMatch(new RegExp(`${SECRET_KEY}|${OTHER_KEY}`));
    const a = join(dir, 'renderweld.yaml');
    const b = join(dir, 'reelforge.yaml');
    writeFileSync(b, 'limits:\n  renderConcurrency: 4\n');
    const files = run('cli.ts', ['config', 'check'], { RENDERWELD_CONFIG: a, REELFORGE_CONFIG: b, RENDERWELD_SECRET_KEY: SECRET_KEY });
    expect(files.status).toBe(1);
    expect(files.stderr).toMatch(/RENDERWELD_CONFIG and its old name REELFORGE_CONFIG are both set, with different values/);
  }, 120_000);
});
