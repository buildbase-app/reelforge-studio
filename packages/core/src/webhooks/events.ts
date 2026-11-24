import { PRODUCT_NAME } from '../product';
import type { JobRecord } from '../repositories';
import type { EventEnvelope } from './types';

/** Every event the server emits (D-070). `webhook.test` only goes to the endpoint being tested. */
export const EVENT_TYPES = [
  'job.queued',
  'job.started',
  'job.progress',
  'job.succeeded',
  'job.failed',
  'job.cancelled',
  'render.ready',
  'render.failed',
  'render.cancelled',
  'render.timeout',
  'render.qa_failed',
  'render.blocked',
  'licence.state_changed',
  'key.created',
  'key.revoked',
  'config.changed',
  'audit.entry',
  'webhook.test',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_DESCRIPTIONS: Record<EventType, string> = {
  'job.queued': 'a render or preview job was queued',
  'job.started': 'a job started running',
  'job.progress': 'a running job passed another 10 % (at most 10 per job)',
  'job.succeeded': 'a job finished successfully',
  'job.failed': 'a job failed (error code and message)',
  'job.cancelled': 'a job was cancelled',
  'render.ready': 'a render or preview is stored and can be fetched with get_render_output (terminal: one render.* outcome per render job)',
  'render.failed': 'a render or preview failed: typed error code, message, stage and an excerpt of the engine log (terminal)',
  'render.cancelled': 'a render or preview was cancelled (terminal)',
  'render.timeout': 'a render or preview ran longer than render.timeoutSeconds and was stopped (terminal)',
  'render.qa_failed': 'a render or preview was refused by an output quality gate (terminal; reserved for the QA gates of #294)',
  'render.blocked': 'a render was refused before it ran: the licence does not allow renders (moderation later); terminal',
  'licence.state_changed': 'the licence status changed (valid, grace, invalid, unlicensed)',
  'key.created': 'an API key was created (never the secret)',
  'key.revoked': 'an API key was revoked',
  'config.changed': 'runtime settings were changed (names only, never values)',
  'audit.entry': 'every audit log entry (only with "webhooks" in audit.sinks)',
  'webhook.test': 'sent by test_webhook to that endpoint only',
};

const PATTERN = /^(\*|[a-z_]+(\.(\*|[a-z_]+))?)$/;

/** Event filters an endpoint may use: exact types, `job.*`, or `*` (everything except job.progress and audit.entry, which are asked for by name). */
export function validEventFilter(s: string): boolean {
  if (!PATTERN.test(s)) return false;
  if (s === '*') return true;
  if (s.endsWith('.*')) return EVENT_TYPES.some((t) => t.startsWith(s.slice(0, -1)));
  return (EVENT_TYPES as readonly string[]).includes(s);
}

/** Noisy types only match when named exactly. */
const NAMED_ONLY = new Set(['job.progress', 'audit.entry', 'webhook.test']);

export function eventMatches(filters: string[], type: string): boolean {
  if (type === 'webhook.test') return false;
  for (const f of filters) {
    if (f === type) return true;
    if (NAMED_ONLY.has(type)) continue;
    if (f === '*') return true;
    if (f.endsWith('.*') && type.startsWith(f.slice(0, -1))) return true;
  }
  return false;
}

/** Render result fields safe to send (no signed download link: it is a bearer capability). */
const RENDER_FIELDS = ['renderId', 'projectId', 'kind', 'createdAt', 'durationSeconds', 'frames', 'width', 'height', 'fps', 'frameRate', 'files', 'outputUrl', 'posterUrl', 'manifestUrl'] as const;

export function renderSummary(result: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!result) return out;
  for (const k of RENDER_FIELDS) if (result[k] !== undefined) out[k] = result[k];
  return out;
}

/** The terminal render events: exactly one of them per render or preview job (#306). */
export const RENDER_TERMINAL_EVENTS = ['render.ready', 'render.failed', 'render.cancelled', 'render.timeout', 'render.qa_failed', 'render.blocked'] as const;
export type RenderTerminalEvent = (typeof RENDER_TERMINAL_EVENTS)[number];

/** Error codes that mean the render was not allowed to run (licence now; moderation later). */
export const BLOCKED_CODES = new Set(['licence_required', 'licence_invalid', 'content_blocked']);
/** The error code of a job stopped by render.timeoutSeconds. */
export const TIMEOUT_CODE = 'render_timeout';

/** Which terminal render event a finished job is; null while it is not finished. */
export function renderOutcome(job: Pick<JobRecord, 'status' | 'error'>): RenderTerminalEvent | null {
  if (job.status === 'succeeded') return 'render.ready';
  if (job.status === 'cancelled') return 'render.cancelled';
  if (job.status !== 'failed') return null;
  const code = job.error?.code ?? '';
  if (code === TIMEOUT_CODE) return 'render.timeout';
  if (code === 'qa_failed' || code.startsWith('qa_')) return 'render.qa_failed';
  if (BLOCKED_CODES.has(code)) return 'render.blocked';
  return 'render.failed';
}

/** The dedupe key of a render job's terminal event (one outcome per job, whatever the event type). */
export const renderDedupeKey = (jobId: string) => `render:${jobId}`;

/** The job as events carry it: no parameters (they can hold manifests), no signed links. */
export function jobPayload(job: JobRecord): Record<string, unknown> {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    ...(job.projectId ? { projectId: job.projectId } : {}),
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    progress: job.progress,
    ...(job.error ? { error: job.error } : {}),
    ...(job.retryOf ? { retryOf: job.retryOf } : {}),
    ...(job.status === 'succeeded' && job.result ? { result: renderSummary(job.result) } : {}),
  };
}

/** One line a person reads (chat message, email subject). */
export function eventTitle(e: EventEnvelope): string {
  const d = e.data as Record<string, any>;
  const job = d.job as Record<string, any> | undefined;
  switch (e.type) {
    case 'job.queued':
    case 'job.started':
    case 'job.succeeded':
    case 'job.cancelled':
      return `${PRODUCT_NAME}: ${job?.type ?? 'job'} ${job?.id ?? ''} ${e.type.slice(4)}${job?.projectId ? ` (project ${job.projectId})` : ''}`;
    case 'job.failed':
      return `${PRODUCT_NAME}: ${job?.type ?? 'job'} ${job?.id ?? ''} failed${job?.projectId ? ` (project ${job.projectId})` : ''}: ${job?.error?.code ?? 'error'}`;
    case 'job.progress':
      return `${PRODUCT_NAME}: ${job?.type ?? 'job'} ${job?.id ?? ''} at ${Math.round((job?.progress?.fraction ?? 0) * 100)} %`;
    case 'render.ready':
      return `${PRODUCT_NAME}: ${d.kind ?? 'render'} ${d.renderId ?? ''} of project ${d.projectId ?? '?'} is ready`;
    case 'render.failed':
    case 'render.timeout':
    case 'render.qa_failed':
      return `${PRODUCT_NAME}: ${d.kind ?? 'render'} ${d.jobId ?? ''} of project ${d.projectId ?? '?'} ${e.type === 'render.timeout' ? 'timed out' : e.type === 'render.qa_failed' ? 'failed a quality check' : 'failed'}: ${d.error?.code ?? 'error'}`;
    case 'render.cancelled':
      return `${PRODUCT_NAME}: ${d.kind ?? 'render'} ${d.jobId ?? ''} of project ${d.projectId ?? '?'} was cancelled`;
    case 'render.blocked':
      return `${PRODUCT_NAME}: ${d.kind ?? 'render'} of project ${d.projectId ?? '?'} was refused: ${d.error?.code ?? 'blocked'}`;
    case 'licence.state_changed':
      return `${PRODUCT_NAME}: licence ${d.previous?.status ?? '?'} -> ${d.status}${d.renderAllowed === false ? ' (renders are refused)' : ''}`;
    case 'key.created':
      return `${PRODUCT_NAME}: API key "${d.name ?? d.keyId}" created`;
    case 'key.revoked':
      return `${PRODUCT_NAME}: API key "${d.name ?? d.keyId}" revoked`;
    case 'config.changed':
      return `${PRODUCT_NAME}: settings changed: ${(d.keys as string[] | undefined)?.join(', ') ?? ''}`;
    case 'audit.entry':
      return `${PRODUCT_NAME} audit: ${d.entry?.action ?? ''} (${d.entry?.result ?? ''})`;
    case 'webhook.test':
      return `${PRODUCT_NAME}: test notification`;
    default:
      return `${PRODUCT_NAME}: ${e.type}`;
  }
}

/** Plain-text body (email, chat). Values only; the JSON payload goes to webhooks. */
export function eventText(e: EventEnvelope, serverUrl?: string): string {
  const lines = [eventTitle(e), '', `Event: ${e.type}`, `Time: ${e.timestamp}`, `Event id: ${e.id}`];
  const flat = (obj: Record<string, unknown>, prefix = ''): void => {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'object' && !Array.isArray(v)) flat(v as Record<string, unknown>, `${prefix}${k}.`);
      else lines.push(`${prefix}${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
    }
  };
  lines.push('');
  flat(e.data);
  if (serverUrl) lines.push('', `Server: ${serverUrl}`);
  lines.push('', '-- ', `Sent by ${PRODUCT_NAME}. Change which events reach this address with update_webhook.`);
  return lines.join('\n');
}
