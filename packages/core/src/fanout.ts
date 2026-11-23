import { newId } from './fsutil';
import type { JobProgress, JobRecord } from './repositories';

/**
 * Render fan-out (D-097): a `render` parent becomes one `render_unit` child per
 * scene and exactly one `render_join`, all ordinary rows of the database queue.
 * This file is the policy every JobRepository applies inside its transactions
 * (what a child's final state does to its parent), so the memory, SQLite,
 * PostgreSQL and MySQL implementations cannot drift apart.
 */
export const UNIT_JOB_TYPE = 'render_unit';
export const JOIN_JOB_TYPE = 'render_join';

export interface ChildSpec {
  type: string;
  params: Record<string, unknown>;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
export const isTerminal = (status: string) => TERMINAL.has(status);

/** A fanned-out parent: running, waiting for its children, held by no worker. */
export const isFannedOut = (j: JobRecord) => j.status === 'running' && j.pendingChildren !== undefined && !j.leaseExpiresAt;

/**
 * Child rows for a parent: same project, API key, queue and priority. Their queue
 * position (`createdAt`) is just after the parent's, in the given order, so a
 * render already in progress finishes before renders submitted after it start,
 * while fair claiming across keys (D-090) still applies.
 */
export function childJobs(parent: JobRecord, specs: ChildSpec[]): JobRecord[] {
  const base = Date.parse(parent.createdAt);
  return specs.map((s, i) => child(parent, s, new Date(base + i + 1).toISOString()));
}

function child(parent: JobRecord, s: ChildSpec, createdAt: string): JobRecord {
  return {
    id: newId('job'),
    type: s.type,
    status: 'queued',
    params: s.params,
    createdAt,
    progress: { stage: 'queued', fraction: 0 },
    parentId: parent.id,
    queue: 'database',
    attempts: 0,
    ...(parent.projectId ? { projectId: parent.projectId } : {}),
    ...(parent.apiKeyId ? { apiKeyId: parent.apiKeyId } : {}),
    // Units and the join keep their render's class (D-103), so a render in progress is not overtaken at a lower class.
    ...(parent.priority ? { priority: parent.priority } : {}),
  };
}

/** The one join job: the parent's parameters; queued at the parent's position (ahead of later renders). */
export function joinJob(parent: JobRecord): JobRecord {
  return child(parent, { type: JOIN_JOB_TYPE, params: { ...parent.params } }, parent.createdAt);
}

export interface SettlementPlan {
  /** The parent's new row (null: nothing to change). */
  parent: JobRecord | null;
  parentFinished: boolean;
  join: JobRecord | null;
  /** Queued siblings to cancel (their new rows); apply only while still queued, else ask them to stop. */
  cancel: JobRecord[];
  /** Running siblings to ask to stop (cancel request). */
  stop: string[];
  /**
   * A unit's success took the parent's stored progress past another 10 %
   * (decided under the parent's row lock, so exactly one settlement crosses
   * each step, whichever worker it runs on): send it as `job.progress`.
   */
  progressed?: boolean;
}

const NOTHING: SettlementPlan = { parent: null, parentFinished: false, join: null, cancel: [], stop: [] };

/** `unit 3/6 (scene "intro")`, or `unit 3/6 (scene "intro", frames 120-239)` for a chunk of a long scene. */
export function describeUnit(params: Record<string, unknown>, fallback: string): string {
  const p = params as { index?: number; count?: number; sceneId?: string; range?: [number, number] };
  if (typeof p.index !== 'number') return `unit ${fallback}`;
  const scene = [p.sceneId ? `scene "${p.sceneId}"` : '', p.range ? `frames ${p.range[0]}-${p.range[1]}` : ''].filter(Boolean).join(', ');
  return `unit ${p.index + 1}${p.count ? `/${p.count}` : ''}${scene ? ` (${scene})` : ''}`;
}

function describeChild(c: JobRecord): string {
  return c.type === JOIN_JOB_TYPE ? 'the join' : describeUnit(c.params, c.id);
}

/** Finish the parent with `status` and stop every unfinished sibling (failure, cancellation). */
export function stopTree(parent: JobRecord, others: JobRecord[], status: 'failed' | 'cancelled', error: NonNullable<JobRecord['error']>, at: string): SettlementPlan {
  const why = `${status === 'failed' ? 'the render failed' : 'the render was cancelled'} (${parent.id})`;
  const cancel = others
    .filter((s) => s.status === 'queued')
    .map((s) => ({ ...s, status: 'cancelled' as const, finishedAt: at, error: { code: 'cancelled', message: `cancelled before it started: ${why}` } }));
  const stop = others.filter((s) => s.status === 'running').map((s) => s.id);
  return { parent: { ...parent, status, finishedAt: at, error }, parentFinished: true, join: null, cancel, stop };
}

/**
 * What a child's final state does to its parent (read under the parent's row
 * lock, so the decrement below is exact): a unit's success decrements
 * `pendingChildren` and the one that reaches 0 creates the join; the join's
 * success finishes the parent with the join's result; a failure or a
 * cancellation finishes the parent the same way and stops the siblings. A
 * parent that already finished (or is not fanned out) is left alone, so late
 * or repeated outcomes change nothing.
 */
export function settleChild(child: JobRecord, parent: JobRecord | null, siblings: JobRecord[], at: string): SettlementPlan {
  if (!parent || !isFannedOut(parent) || !isTerminal(child.status)) return NOTHING;
  const others = siblings.filter((s) => s.id !== child.id);
  if (child.status === 'succeeded') {
    if (child.type === JOIN_JOB_TYPE) {
      return {
        ...NOTHING,
        parent: { ...parent, status: 'succeeded', finishedAt: at, progress: { stage: 'done', fraction: 1 }, ...(child.result ? { result: child.result } : {}) },
        parentFinished: true,
      };
    }
    const left = Math.max(0, (parent.pendingChildren ?? 0) - 1);
    const join = left === 0 && !others.some((s) => s.type === JOIN_JOB_TYPE) ? joinJob(parent) : null;
    // The parent's stored progress: frames of the units that succeeded (this one included) over all frames.
    const progress = committedProgress([...others, child]);
    const step = (f: number) => Math.floor(f * 10 + 1e-9);
    const progressed = step(progress.fraction) > step(parent.progress?.fraction ?? 0);
    return { ...NOTHING, parent: { ...parent, pendingChildren: left, progress }, join, progressed };
  }
  const attempts = child.attempts && child.attempts > 1 ? ` after ${child.attempts} attempts` : '';
  const error = {
    code: child.status === 'cancelled' ? 'cancelled' : (child.error?.code ?? 'job_failed'),
    message: `${describeChild(child)} ${child.status === 'cancelled' ? 'was cancelled' : `failed${attempts}`}: ${child.error?.message ?? child.status}`,
    ...(child.error?.stage ? { stage: child.error.stage } : {}),
    unit: child.id,
  };
  return stopTree(parent, others, child.status === 'cancelled' ? 'cancelled' : 'failed', error, at);
}

const framesOf = (c: JobRecord) => Math.max(0, Number((c.params as { frames?: unknown }).frames) || 0);

/** Progress from the units that succeeded only (what a settlement knows for sure): 90 % × their frames / all frames. */
function committedProgress(children: JobRecord[]): JobProgress {
  const units = children.filter((c) => c.type === UNIT_JOB_TYPE);
  const total = units.reduce((n, c) => n + framesOf(c), 0);
  const ok = units.filter((c) => c.status === 'succeeded');
  const done = ok.reduce((n, c) => n + framesOf(c), 0);
  return { stage: 'render', fraction: total > 0 ? (0.9 * done) / total : 0, detail: `${done}/${total} frames, ${ok.length}/${units.length} units rendered` };
}

/**
 * A fanned-out parent's progress (D-097): frames done across its units over
 * the render's total frames (90 %), then the join (10 %). Agents watch only
 * the parent; get_job, long-polls and SSE compute this from the children.
 */
export function treeProgress(parent: JobRecord, children: JobRecord[]): JobProgress {
  const units = children.filter((c) => c.type === UNIT_JOB_TYPE);
  const join = children.find((c) => c.type === JOIN_JOB_TYPE);
  const total = units.reduce((n, c) => n + framesOf(c), 0);
  let done = 0;
  let finished = 0;
  for (const u of units) {
    if (u.status === 'succeeded') {
      done += framesOf(u);
      finished++;
    } else if (u.status === 'running') done += framesOf(u) * Math.min(1, Math.max(0, u.progress.fraction));
  }
  const unitPart = total > 0 ? done / total : 0;
  const joinPart = join ? (join.status === 'succeeded' ? 1 : join.status === 'running' ? join.progress.fraction : 0) : 0;
  const frames = `${Math.floor(done)}/${total} frames, ${finished}/${units.length || (parent.pendingChildren ?? 0)} units rendered`;
  if (join) return { stage: 'join', fraction: Math.min(1, 0.9 + 0.1 * joinPart), detail: `${frames}; joining (${join.status})` };
  return { stage: 'render', fraction: 0.9 * unitPart, detail: frames };
}
