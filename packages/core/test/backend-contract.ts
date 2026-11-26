/**
 * The contract every render backend passes (issue #150, D-100). A new backend
 * calls backendContract() from its own test file with a factory for its
 * configured and unconfigured states. Ids: BKD-01..BKD-06 in
 * docs/providers/backends.md.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseProject, type Project } from '@renderweld/project-schema';
import { RENDER_BACKEND_KINDS, type BackendContext, type RenderBackend, type RenderRequest } from '../src/index';

export const CapabilitiesShape = z.strictObject({
  engines: z.array(z.string().min(1)),
  maxUnitSeconds: z.number().positive().nullable(),
  frameRanges: z.boolean(),
  scaleToZero: z.boolean(),
});

export const EstimateShape = z.strictObject({
  backend: z.string().min(1),
  videoSeconds: z.number().nonnegative(),
  units: z.number().int().nonnegative(),
  seconds: z.number().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  note: z.string().min(10),
});

export function sampleProject(): Project {
  const r = parseProject(JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8')));
  if (!r.ok) throw new Error('examples/sample-reel.json does not parse');
  return r.project;
}

export interface BackendContractOptions {
  /** A backend with every setting it needs (null: it cannot be configured in a test, e.g. needs a live account). */
  configured: (() => RenderBackend) | null;
  /** A backend without its settings (null: it needs none, like `local`). */
  unconfigured: (() => RenderBackend) | null;
  /** For implemented backends: check the outcome of a real submit (the fake engine, an emulator). */
  checkSubmit?: (req: RenderRequest, outcome: Awaited<ReturnType<RenderBackend['submit']>>) => void | Promise<void>;
}

export function backendContract(name: string, opts: BackendContractOptions): void {
  const any = (opts.configured ?? opts.unconfigured)!;
  const project = sampleProject();
  const req = (): RenderRequest => ({ jobId: 'job_contract', runId: `run_contract_${Date.now()}`, kind: 'render', project, projectVersion: 1 });
  const ctx = (): BackendContext => ({ signal: new AbortController().signal, log: () => undefined, progress: () => undefined });

  describe(`render backend contract: ${name}`, () => {
    it('BKD-01 identity: id, display name, kind, env names, implemented flag', () => {
      const b = any();
      expect(b.id).toMatch(/^[a-z0-9-]+$/);
      expect(b.displayName.length).toBeGreaterThan(3);
      expect(RENDER_BACKEND_KINDS).toContain(b.kind);
      expect(Array.isArray(b.env) && b.env.every((e) => /^[A-Z][A-Z0-9_]*$/.test(e))).toBe(true);
      expect(typeof b.implemented).toBe('boolean');
    });

    it('BKD-02 configured / unconfigured follow the environment object it was given', () => {
      if (opts.configured) expect(opts.configured().configured()).toBe(true);
      if (opts.unconfigured) {
        const b = opts.unconfigured();
        expect(b.configured()).toBe(false);
        expect(b.env.length).toBeGreaterThan(0); // something to set
      }
    });

    it('BKD-03 capabilities have the documented shape', () => {
      for (const make of [opts.configured, opts.unconfigured]) {
        if (!make) continue;
        const cap = make().capabilities();
        expect(CapabilitiesShape.safeParse(cap).error?.issues ?? []).toEqual([]);
      }
    });

    it('BKD-04 estimate: shape, units and seconds of video of the request, no invented numbers when not implemented', () => {
      const b = any();
      const e = b.estimate({ kind: 'render', project });
      expect(EstimateShape.safeParse(e).error?.issues ?? []).toEqual([]);
      expect(e.backend).toBe(b.id);
      expect(e.units).toBe(project.scenes.length);
      expect(e.videoSeconds).toBeGreaterThan(0);
      const one = b.estimate({ kind: 'preview', project, sceneIds: [project.scenes[0]!.id] });
      expect(one.units).toBe(1);
      if (!b.implemented) expect([e.seconds, e.costUsd]).toEqual([null, null]);
    });

    it('BKD-05 submit: renders when implemented and configured; otherwise a clear error and nothing started', async () => {
      if (opts.unconfigured) {
        await expect(opts.unconfigured().submit(req(), ctx())).rejects.toMatchObject({ code: 'backend_not_configured', status: 409 });
      }
      if (!opts.configured) return;
      const b = opts.configured();
      if (!b.implemented) {
        await expect(b.submit(req(), ctx())).rejects.toMatchObject({ code: 'not_implemented', status: 501 });
        return;
      }
      const r = req();
      const outcome = await b.submit(r, ctx());
      expect(outcome.runId).toBe(r.runId);
      await opts.checkSubmit?.(r, outcome);
    });

    it('BKD-06 cancel resolves for a job it does not know (cancellation is idempotent)', async () => {
      await expect(any().cancel('job_unknown')).resolves.toBeUndefined();
    });
  });
}
