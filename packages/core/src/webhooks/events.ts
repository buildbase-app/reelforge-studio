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
  'render.ready': 'a render or preview is stored and can be fetched with get_render_output',
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
const RENDER_FIELDS = ['renderId', 'projectId', 'kind', 'createdAt', 'durationSeconds', 'frames', 'width', 'height', 'fps', 'files', 'outputUrl', 'posterUrl', 'manifestUrl'] as const;

export function renderSummary(result: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!result) return out;
  for (const k of RENDER_FIELDS) if (result[k] !== undefined) out[k] = result[k];
  return out;
}

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
      return `ReelForge: ${job?.type ?? 'job'} ${job?.id ?? ''} ${e.type.slice(4)}${job?.projectId ? ` (project ${job.projectId})` : ''}`;
    case 'job.failed':
      return `ReelForge: ${job?.type ?? 'job'} ${job?.id ?? ''} failed${job?.projectId ? ` (project ${job.projectId})` : ''}: ${job?.error?.code ?? 'error'}`;
    case 'job.progress':
      return `ReelForge: ${job?.type ?? 'job'} ${job?.id ?? ''} at ${Math.round((job?.progress?.fraction ?? 0) * 100)} %`;
    case 'render.ready':
      return `ReelForge: ${d.kind ?? 'render'} ${d.renderId ?? ''} of project ${d.projectId ?? '?'} is ready`;
    case 'licence.state_changed':
      return `ReelForge: licence ${d.previous?.status ?? '?'} -> ${d.status}${d.renderAllowed === false ? ' (renders are refused)' : ''}`;
    case 'key.created':
      return `ReelForge: API key "${d.name ?? d.keyId}" created`;
    case 'key.revoked':
      return `ReelForge: API key "${d.name ?? d.keyId}" revoked`;
    case 'config.changed':
      return `ReelForge: settings changed: ${(d.keys as string[] | undefined)?.join(', ') ?? ''}`;
    case 'audit.entry':
      return `ReelForge audit: ${d.entry?.action ?? ''} (${d.entry?.result ?? ''})`;
    case 'webhook.test':
      return 'ReelForge: test notification';
    default:
      return `ReelForge: ${e.type}`;
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
  lines.push('', '-- ', 'Sent by ReelForge Studio. Change which events reach this address with update_webhook.');
  return lines.join('\n');
}
