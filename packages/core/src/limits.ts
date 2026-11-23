import { sceneFrames, type Project } from '@reelforge/project-schema';
import type { ResolvedConfig } from './config/load';

/**
 * Resource limits (D-090, D-091; docs/security/HARDENING.md): render size,
 * job caps per key and in total, provider calls per key and per day.
 * Values come from the `limits.*` settings and are read on every check, so a
 * runtime change applies to the next request.
 */

/** Why a request was refused by a limit: the `reason` label of reelforge.limits.rejections (a fixed set). */
export type LimitReason =
  | 'render_limit'
  | 'jobs_per_key'
  | 'queue_full'
  | 'queue_wait'
  | 'render_quota'
  | 'upload_too_large'
  | 'provider_runs_per_key'
  | 'provider_budget';

export const LIMIT_REASONS: readonly LimitReason[] = ['render_limit', 'jobs_per_key', 'queue_full', 'queue_wait', 'render_quota', 'upload_too_large', 'provider_runs_per_key', 'provider_budget'];

/** One exceeded render limit: the setting, its value and what the project asks for. */
export interface RenderLimitViolation {
  limit: string;
  max: number;
  actual: number;
  message: string;
}

export type LimitSettings = ResolvedConfig['config']['limits'];

/**
 * The render limits a render (or a preview of `sceneIds` at `scale`) of this
 * project exceeds. Empty when it fits.
 */
export function renderLimitViolations(p: Project, limits: LimitSettings, opts: { sceneIds?: string[]; scale?: number } = {}): RenderLimitViolation[] {
  const scenes = opts.sceneIds ? p.scenes.filter((s) => opts.sceneIds!.includes(s.id)) : p.scenes;
  const fps = p.output.fps;
  const frames = scenes.reduce((n, s) => n + sceneFrames(s, fps), 0);
  const seconds = frames / fps;
  const scale = opts.scale ?? 1;
  const longest = Math.round(Math.max(p.output.width, p.output.height) * scale);
  const out: RenderLimitViolation[] = [];
  const check = (limit: string, max: number, actual: number, what: string) => {
    if (actual > max) out.push({ limit: `limits.${limit}`, max, actual, message: `${what} is ${actual}; limits.${limit} allows ${max}` });
  };
  check('maxScenes', limits.maxScenes, scenes.length, 'the number of scenes');
  check('maxRenderSeconds', limits.maxRenderSeconds, Math.ceil(seconds * 100) / 100, 'the duration in seconds');
  check('maxRenderFrames', limits.maxRenderFrames, frames, 'the number of frames');
  check('maxRenderDimension', limits.maxRenderDimension, longest, 'the longest output side in pixels');
  check('maxRenderFps', limits.maxRenderFps, fps, 'the frame rate');
  return out;
}

/** The UTC day a usage counter counts in, and when it resets. */
export function usageDay(now: number): { start: string; resetsAt: string; retryAfterSeconds: number } {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const end = start + 86_400_000;
  return { start: new Date(start).toISOString(), resetsAt: new Date(end).toISOString(), retryAfterSeconds: Math.max(1, Math.ceil((end - now) / 1000)) };
}

/** Usage counter keys (RateLimitRepository.reserve): provider calls of one key, and of the whole server. */
export const usageKeys = {
  providerRunsOfKey: (keyId: string) => `usage:provider-runs:key:${keyId}`,
  providerRunsTotal: 'usage:provider-runs:all',
};

/** Suggested wait before starting another job after a job cap refused one. */
export const JOB_CAP_RETRY_SECONDS = 30;
