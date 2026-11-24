/**
 * The real-render driver's own checks (docs/runbooks/SCALE-TEST.md): every manifest of the mix is valid,
 * the mix is deterministic, and a dry run against the in-memory fake server keeps the requested number of
 * renders in flight, retries 503s with the same idempotency key, and reports each render once.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProject } from '@reelforge/project-schema';
import { afterAll, describe, expect, it } from 'vitest';
import { buildManifest, config, fakeTransport, pickWeighted, PROFILES, rng, run } from './real-render';

const out = mkdtempSync(join(tmpdir(), 'rf-real-test-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('real-render driver', () => {
  it('builds a valid manifest for every size and engine', () => {
    for (const profile of Object.keys(PROFILES)) {
      for (const engine of ['html', 'hyperframes', 'remotion']) {
        const m = buildManifest(`t-${profile}-${engine}`.toLowerCase(), profile, [[engine, 1]], rng(1));
        const v = parseProject(m);
        expect(v.ok, JSON.stringify(!v.ok && v.issues)).toBe(true);
        expect(m.scenes.length * 5).toBe(PROFILES[profile]!.seconds);
      }
    }
  });

  it('picks a deterministic weighted mix', () => {
    const a = rng(7);
    const b = rng(7);
    const w: [string, number][] = [['x', 0.6], ['y', 0.3], ['z', 0.1]];
    const picks = Array.from({ length: 2000 }, () => pickWeighted(w, a()));
    expect(picks).toEqual(Array.from({ length: 2000 }, () => pickWeighted(w, b())));
    const share = picks.filter((p) => p === 'x').length / picks.length;
    expect(share).toBeGreaterThan(0.55);
    expect(share).toBeLessThan(0.65);
  });

  it('dry run: holds the steps, retries refusals and reports every render once', async () => {
    const cfg = config({ LOAD_DRY_RUN: '1', LOAD_STEPS: '5:400,20:400', LOAD_DRAIN_SECONDS: '2000', LOAD_DRY_TIME_SCALE: '0.001', LOAD_DRY_RENDER_MS: '20', LOAD_DRY_SLOTS: '10', LOAD_DRY_503_RATE: '0.2', LOAD_PROJECTS_PER_PROFILE: '2', LOAD_VERIFY_EVERY: '3', LOAD_OUT: out });
    const r = await run(cfg, fakeTransport(cfg.dry, rng(2)), ['rf_k1', 'rf_k2'], () => undefined);
    expect(r.lines.length).toBeGreaterThan(20);
    expect(new Set(r.ids).size).toBe(r.ids.length);
    expect(r.report.all.succeeded).toBe(r.lines.length);
    expect(r.report.all.refusals['503']).toBeGreaterThan(0);
    expect(r.report.steps.map((s) => s.inFlight)).toEqual([5, 20]);
    expect(r.report.steps[1]!.submitted).toBeGreaterThan(0);
    expect(r.report.all.verified.ok).toBeGreaterThan(0);
    expect(r.report.gates.every((g) => g.ok)).toBe(true);
    // 20 in flight on 10 fake slots: renders wait in the queue.
    expect(Math.max(...r.lines.filter((l) => l.step === 1).map((l) => l.queueWaitS ?? 0))).toBeGreaterThan(0);
    const jsonl = readFileSync(join(r.dir, 'jobs.jsonl'), 'utf8').trim().split('\n');
    expect(jsonl.length).toBe(r.lines.length);
    expect(JSON.parse(readFileSync(join(r.dir, 'ids.json'), 'utf8'))).toEqual(r.ids);
    expect(readFileSync(join(r.dir, 'summary.md'), 'utf8')).toContain('DRY RUN');
  });

  it('enqueue mode submits a fixed number and does not wait for them', async () => {
    const cfg = config({ LOAD_DRY_RUN: '1', LOAD_MODE: 'enqueue', LOAD_ENQUEUE_TOTAL: '50', LOAD_ENQUEUE_PARALLEL: '8', LOAD_DRY_503_RATE: '0', LOAD_DRY_SLOTS: '0', LOAD_PROJECTS_PER_PROFILE: '1', LOAD_OUT: out });
    const r = await run(cfg, fakeTransport(cfg.dry, rng(3)), ['rf_k1'], () => undefined);
    expect(r.ids.length).toBe(50);
    expect(r.lines.every((l) => l.status === 'accepted')).toBe(true);
  });
});
