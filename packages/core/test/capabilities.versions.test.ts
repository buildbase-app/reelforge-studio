import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * #319: get_capabilities used to run `ffmpeg -version` and `ffprobe -version`
 * synchronously on every call, which blocked the event loop for every client.
 * The versions are now probed once at start-up (async), refreshed on a timer
 * or on demand, and capabilities() only reads them.
 */

const childProcess = vi.hoisted(() => ({ spawnSync: 0, spawn: 0, execFile: 0 }));
const probe = vi.hoisted(() => ({ calls: [] as string[], version: 'ffmpeg version 7.1-test' }));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawnSync: ((...args: Parameters<typeof real.spawnSync>) => {
      childProcess.spawnSync++;
      return real.spawnSync(...args);
    }) as typeof real.spawnSync,
    spawn: ((...args: Parameters<typeof real.spawn>) => {
      childProcess.spawn++;
      return real.spawn(...args);
    }) as typeof real.spawn,
    execFile: ((...args: Parameters<typeof real.execFile>) => {
      childProcess.execFile++;
      return (real.execFile as (...a: unknown[]) => unknown)(...args);
    }) as typeof real.execFile,
  };
});

vi.mock('@renderweld/media-pipeline', async (importOriginal) => {
  const real = await importOriginal<typeof import('@renderweld/media-pipeline')>();
  return {
    ...real,
    // The stubbed probe: counts calls and answers like `<bin> -version`.
    toolVersionAsync: async (bin: string) => {
      probe.calls.push(bin);
      return bin.includes('ffprobe') ? probe.version.replace('ffmpeg', 'ffprobe') : probe.version;
    },
    toolVersion: () => {
      throw new Error('synchronous tool probe called');
    },
  };
});

const { PluginRegistry, RenderWeldService, createMemoryRepositories } = await import('../src/index');
const { fakeEngine, tempDir } = await import('./helpers');

describe('get_capabilities tool versions (#319)', () => {
  const { dir, cleanup } = tempDir();
  let svc: Awaited<ReturnType<typeof RenderWeldService.create>>;

  beforeAll(async () => {
    const registry = new PluginRegistry();
    registry.registerEngine(fakeEngine('remotion'));
    svc = await RenderWeldService.create(registry, {
      repositories: createMemoryRepositories(),
      dataDir: join(dir, 'data'),
      configSources: { env: { RENDERWELD_LICENCE_MODE: 'off' } },
      maintenance: false,
    });
  });
  afterAll(async () => {
    await svc.stop();
    cleanup();
  });

  it('probes ffmpeg and ffprobe once at start-up; capabilities() never starts a process', async () => {
    expect(probe.calls).toHaveLength(2); // one ffmpeg, one ffprobe, during create()
    const before = { ...childProcess };
    for (let i = 0; i < 50; i++) {
      const c = svc.capabilities();
      expect(c.versions).toMatchObject({ ffmpeg: 'ffmpeg version 7.1-test', ffprobe: 'ffprobe version 7.1-test' });
    }
    expect(probe.calls).toHaveLength(2);
    expect(childProcess).toEqual(before); // no spawnSync, spawn or execFile on the request path
  });

  it('refreshes on demand (and concurrent refreshes share one probe); capabilities() then shows the new value', async () => {
    probe.version = 'ffmpeg version 7.2-test';
    await Promise.all([svc.refreshToolVersions(), svc.refreshToolVersions(), svc.refreshToolVersions()]);
    expect(probe.calls).toHaveLength(4);
    expect(svc.capabilities().versions.ffmpeg).toBe('ffmpeg version 7.2-test');
    expect(svc.capabilities().versions.ffprobe).toBe('ffprobe version 7.2-test');
    expect(probe.calls).toHaveLength(4);
  });
});
