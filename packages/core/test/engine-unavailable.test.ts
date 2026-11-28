/**
 * #783 (plan L30): an engine that cannot render here (the Remotion engine without the customer's own Remotion licence
 * and install) keeps its templates listed, marked unavailable with the reason, what they need and what to use instead;
 * validate_project names the alternatives; previews reach the engine marked as previews (Remotion's isProduction).
 * Fake engines.
 */
import { join } from 'node:path';
import { BUILTIN_THEMES, type TimelineScene } from '@renderweld/project-schema';
import { resolveTools } from '@renderweld/media-pipeline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, RenderWeldService, createMemoryRepositories, type EnginePlugin, type EngineRenderContext } from '../src/index';
import { renderSceneClip } from '../src/render';
import { fakeEngine, tempDir } from './helpers';

const REASON = 'Remotion is off: it needs your own Remotion licence';
const locked: EnginePlugin = {
  ...fakeEngine('remotion'),
  availability: () => ({ ok: false, reason: REASON }),
  requires: 'Needs your own Remotion licence',
  alternatives: { 'kinetic-title': ['html-title'], 'remotion-layout': ['html-layout', 'hyperframes-layout'] },
};
const registry = () => new PluginRegistry().registerEngine(locked).registerEngine(fakeEngine('html'));

const { dir, cleanup } = tempDir('reelforge-engine-unavailable-');
let svc: RenderWeldService;
beforeAll(async () => {
  svc = await RenderWeldService.create(registry(), { repositories: createMemoryRepositories(), dataDir: join(dir, 'data'), configSources: { env: { RENDERWELD_LICENCE_MODE: 'off' } } });
});
afterAll(async () => {
  await svc.jobs.shutdown(0);
  await svc.stop();
  cleanup();
});

describe('templates of an engine that cannot render here (#783)', () => {
  it('list_templates keeps them, marked unavailable with the reason, the requirement and the alternatives', () => {
    const byId = Object.fromEntries(svc.listTemplates().map((t) => [t.id, t]));
    expect(byId['kinetic-title']).toMatchObject({
      engine: 'remotion',
      available: false,
      unavailableReason: REASON,
      requires: 'Needs your own Remotion licence',
      alternatives: ['html-title'],
    });
    expect(byId['remotion-layout']).toMatchObject({ available: false, alternatives: ['html-layout', 'hyperframes-layout'] });
    expect(byId['html-title']).toMatchObject({ engine: 'html', available: true });
    expect(byId['html-title']).not.toHaveProperty('requires');
    expect(byId['html-title']).not.toHaveProperty('unavailableReason');
  });

  it('an engine whose availability() throws is listed as unavailable with the error', () => {
    const throwing: EnginePlugin = { ...fakeEngine('remotion'), availability: () => { throw new Error('probe failed'); } };
    const infos = new PluginRegistry().registerEngine(throwing).templateInfos('remotion');
    expect(infos.length).toBeGreaterThan(0);
    expect(infos[0]).toMatchObject({ available: false, unavailableReason: 'probe failed' });
  });

  it('validate_project refuses the scene with the reason and names the templates to use instead', async () => {
    await svc.createProject({
      schemaVersion: '0.2',
      projectId: 'locked',
      title: 'locked engine',
      output: { width: 1080, height: 1920, fps: 30, format: 'mp4' },
      scenes: [
        { id: 'hook', engine: 'remotion', template: 'kinetic-title', durationFrames: 45, props: { headline: 'Hook' } },
        { id: 'card', engine: 'html', template: 'html-title', durationFrames: 45, props: { headline: 'Card' } },
      ],
    });
    const v = await svc.validateProject('locked');
    expect(v.ok).toBe(false);
    expect(v.errors).toContainEqual({ path: 'scenes.0.engine', message: `engine "remotion" cannot render on this server: ${REASON}. Use html-title instead of kinetic-title` });
  });
});

describe('previews reach the engine marked as previews (#783: isProduction false)', () => {
  const run = async (preview: boolean | undefined) => {
    const base = fakeEngine('remotion');
    const seen: Array<boolean | undefined> = [];
    const engine: EnginePlugin = { ...base, render: (scene, ctx: EngineRenderContext) => (seen.push(ctx.preview), base.render(scene, ctx)) };
    const t = tempDir();
    try {
      const scene = { id: 's1', engine: 'remotion', template: 'kinetic-title', props: { headline: 'Hi' }, assets: [], durationFrames: 6, startFrame: 0, endFrame: 6 } as unknown as TimelineScene;
      await renderSceneClip({
        runId: 'r1',
        scene,
        output: { width: 64, height: 112, fps: 30 } as never,
        theme: BUILTIN_THEMES[0]!.tokens,
        assets: new Map(),
        registry: new PluginRegistry().registerEngine(engine),
        tools: resolveTools(),
        cacheDir: t.dir,
        out: `${t.dir}/s1.mp4`,
        workDir: `${t.dir}/work`,
        signal: new AbortController().signal,
        log: () => undefined,
        progress: () => undefined,
        ...(preview === undefined ? {} : { preview }),
      });
    } finally {
      t.cleanup();
    }
    return seen;
  };
  it('a preview sets preview: true; a render leaves it unset', async () => {
    expect(await run(true)).toEqual([true]);
    expect(await run(undefined)).toEqual([undefined]);
  });
});
