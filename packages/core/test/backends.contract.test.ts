/**
 * Render backends v2 (issue #150, D-100): the contract suite for every
 * backend this repository ships, and how get_capabilities and
 * validate_project use kind, capabilities() and estimate(). Ids: BKD-nn in
 * docs/providers/backends.md.
 */
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ApiError,
  LocalBackend,
  PluginRegistry,
  REMOTION_LAMBDA_ENV,
  RemotionLambdaBackend,
  ReelforgeService,
  createMemoryRepositories,
  estimateUnits,
  type BackendCapabilities,
  type RenderBackend,
} from '../src/index';
import { CapabilitiesShape, backendContract, sampleProject } from './backend-contract';
import { fakeEngine, tempDir } from './helpers';

const LAMBDA_ENV = Object.fromEntries(REMOTION_LAMBDA_ENV.map((k) => [k, k === 'REMOTION_LAMBDA_SERVE_URL' ? 'https://example.com/site' : 'x']));

backendContract('local', {
  configured: () => new LocalBackend(async (req) => ({ runId: req.runId, dir: '/tmp/r', outputFile: '/tmp/r/final.mp4', manifestFile: '/tmp/r/render.json' }), () => ['remotion', 'html']),
  unconfigured: null,
  checkSubmit: (_req, outcome) => expect(outcome.outputFile).toMatch(/final\.mp4$/),
});

backendContract('remotion-lambda (skeleton, implemented: false)', {
  configured: () => new RemotionLambdaBackend(LAMBDA_ENV),
  unconfigured: () => new RemotionLambdaBackend({}),
});

describe('render backends v2 in the service', () => {
  const { dir, cleanup } = tempDir('reelforge-backends-');
  afterAll(cleanup);

  /** An implemented backend that renders only Remotion scenes of at most 2 s (no frame ranges). */
  class NarrowBackend implements RenderBackend {
    readonly id = 'narrow';
    readonly displayName = 'Narrow test backend';
    readonly kind = 'launcher' as const;
    readonly implemented = true;
    readonly env = [];
    configured = () => true;
    capabilities = (): BackendCapabilities => ({ engines: ['remotion'], maxUnitSeconds: 2, frameRanges: false, scaleToZero: true });
    estimate = (req: Parameters<RenderBackend['estimate']>[0]) => ({ backend: this.id, ...estimateUnits(req), seconds: 12, costUsd: 0.01, note: 'test estimate for the narrow backend' });
    submit = async (): Promise<never> => {
      throw new ApiError('not_implemented', 501, 'test backend');
    };
    cancel = async () => undefined;
  }

  async function service() {
    const registry = new PluginRegistry()
      .registerEngine(fakeEngine('remotion'))
      .registerEngine(fakeEngine('motion-canvas'))
      .registerBackend(new RemotionLambdaBackend({}))
      .registerBackend(new NarrowBackend());
    return ReelforgeService.create(registry, { repositories: createMemoryRepositories(), dataDir: join(dir, `d${Math.random()}`), configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } }, maintenance: false, webhooks: { worker: false } });
  }

  it('BKD-07 get_capabilities reports kind and capabilities of every backend; implemented stays honest', async () => {
    const svc = await service();
    try {
      const backends = svc.capabilities().backends;
      expect(backends.map((b) => [b.id, b.kind, b.implemented])).toEqual([
        ['remotion-lambda', 'managed', false],
        ['narrow', 'launcher', true],
        ['local', 'pool', true],
      ]);
      for (const b of backends) expect(CapabilitiesShape.safeParse(b.capabilities).success).toBe(true);
      // local renders whatever engines this server has.
      expect(backends.find((b) => b.id === 'local')!.capabilities).toEqual({ engines: ['remotion', 'motion-canvas'], maxUnitSeconds: null, frameRanges: false, scaleToZero: false });
      expect(backends.find((b) => b.id === 'remotion-lambda')).toMatchObject({ configured: false, implemented: false, capabilities: { engines: ['remotion'] } });
    } finally {
      await svc.stop();
    }
  });

  it('BKD-08 validate_project carries the backend estimate and checks engines and unit length against capabilities()', async () => {
    const svc = await service();
    try {
      const project = sampleProject();
      const local = await svc.validateManifest(project);
      expect(local.estimate).toMatchObject({ backend: 'local', units: project.scenes.length, costUsd: 0, seconds: null });
      expect(local.estimate!.videoSeconds).toBeCloseTo(local.summary!.durationSeconds, 3);
      const narrow = await svc.validateManifest({ ...project, render: { ...project.render, backend: 'narrow' } });
      expect(narrow.estimate).toMatchObject({ backend: 'narrow', seconds: 12, costUsd: 0.01 });
      const messages = narrow.errors.map((e) => e.message).join('\n');
      if (project.scenes.some((s) => s.engine !== 'remotion')) expect(messages).toMatch(/backend "narrow" cannot render engine "motion-canvas"/);
      expect(messages).toMatch(/backend "narrow" renders at most 2 s per scene/);
      // A skeleton keeps its single "not implemented" error (no capability noise).
      const lambda = await svc.validateManifest({ ...project, render: { ...project.render, backend: 'remotion-lambda' } });
      expect(lambda.errors.filter((e) => e.path === 'render.backend' || e.path.startsWith('scenes.')).map((e) => e.message)).toEqual(['backend "remotion-lambda" is not configured on this server (set REMOTION_LAMBDA_REGION, REMOTION_LAMBDA_FUNCTION_NAME, REMOTION_LAMBDA_SERVE_URL)']);
      expect(lambda.estimate).toMatchObject({ seconds: null, costUsd: null });
    } finally {
      await svc.stop();
    }
  });
});
