/**
 * The public REST API (/v1), and nothing else. The API key goes in the
 * Authorization header of each call: never in a URL, a cookie or a log.
 */

export interface Me {
  id: string;
  name: string;
  scopes: string[];
  expiresAt?: string | null;
}

export interface Job {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  projectId?: string;
  params: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress: { stage: string; fraction: number; detail?: string };
  result?: Record<string, unknown>;
  error?: { code: string; message: string; stage?: string; unit?: string };
  retryOf?: string;
  attempts?: number;
  workerId?: string;
  parentId?: string;
  pendingChildren?: number;
  priority?: string;
  queuePosition?: number;
}

export interface ProjectSummary {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  title: string;
  scenes: number;
  durationSeconds: number;
}

export interface RenderSummary {
  renderId: string;
  projectId: string;
  kind: string;
  createdAt: string;
  durationSeconds: number;
  frames: number;
  width: number;
  height: number;
  fps: number;
  files: string[];
  downloadUrl: string;
  downloadUrlExpiresAt: string;
  downloadVia: 'bucket' | 'server';
  storage?: { driver: string; prefix: string };
  /** Present on renders with the audio pipeline (#301); older servers and renders have none. */
  audio?: RenderAudio;
  captions?: {
    mode: string;
    burned: boolean;
    cues: number;
    language: string | null;
    files: Array<{ format: string; file: string; downloadUrl: string; downloadUrlExpiresAt: string }>;
    qa: { ok: boolean; issues: Array<{ cue: number; rule: string; message: string }> };
  };
}

export interface RenderAudio {
  track: 'mixed' | 'silent' | 'none';
  preset: string;
  target: { integrated: number; truePeak: number } | null;
  normalisation: string;
  measured: { integrated: number | null; truePeak: number | null; lra: number | null } | null;
  qa: { ok: boolean; issues: Array<{ rule: string; severity: 'warn' | 'fail'; message: string }> };
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

export interface RenderCaptionsView {
  renderId: string;
  mode: string;
  burned: boolean;
  burnLanguage: string | null;
  approved: boolean;
  languages: Array<{
    language: string | null;
    primary: boolean;
    burned: boolean;
    source: string;
    cues: CaptionCue[];
    descriptions: CaptionCue[];
    qa: { ok: boolean; issues: Array<{ cue: number; rule: string; message: string }> };
    files: Record<string, string>;
  }>;
}

export interface Percentiles {
  p50Ms: number | null;
  p95Ms: number | null;
  samples: number;
}

export interface AnalyticsPoint {
  start: string;
  jobs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  unfinished: number;
}

export type DeliveryCounts = Record<'pending' | 'delivering' | 'succeeded' | 'dead', number>;

export interface AnalyticsSummary {
  range: { from: string; to: string; bucket: 'day' | 'hour'; maxRangeDays: number };
  generatedAt: string;
  scan: { jobs: number; limit: number; truncated: boolean; coveredFrom: string };
  totals: AnalyticsPoint & { renders: number; previews: number; successRate: number | null; failureRate: number | null };
  series: AnalyticsPoint[];
  renderTime: Percentiles;
  queueWait: Percentiles;
  engines: { renders: number; sampled: number; byEngine: Array<Percentiles & { engine: string; scenes: number; totalMs: number }> };
  minutesRendered: { renders: number; previews: number; total: number };
  storage: { measuredAt: string; totalBytes: number; renders: { count: number; bytes: number }; assets: { objects: number; bytes: number } } | { measuredAt: string; error: string };
  errors: Array<{ code: string; count: number; lastAt: string; stage?: string; message: string }>;
  webhooks: {
    totals: DeliveryCounts & { successRate: number | null };
    endpoints: Array<{ id: string; name: string; type: string; enabled: boolean; counts: DeliveryCounts; successRate: number | null }>;
  };
}

export interface ConfigEntry {
  key: string;
  value: unknown;
  source: string;
  origin?: string;
  scope: 'startup' | 'runtime';
  secret: boolean;
  kind: 'string' | 'integer' | 'number' | 'boolean' | 'list' | 'enum' | 'path' | 'url';
  options?: string[];
  min?: number;
  max?: number;
  locked?: true;
  env: string;
  description: string;
  placeholder?: string;
  updatedAt?: string;
  updatedBy?: string;
  error?: string;
}

export interface ConfigReport {
  edition: string;
  configFile: string | null;
  secretKey: 'set' | 'not set';
  settings: ConfigEntry[];
  warnings: Array<{ key?: string; message: string }>;
}

export interface KeyRecord {
  id: string;
  name: string;
  scopes: string[];
  prefix: string;
  status: 'active' | 'expired' | 'revoked';
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  rotatedAt?: string;
  previousSecretExpiresAt?: string;
}

export interface Webhook {
  id: string;
  name: string;
  description?: string;
  type: string;
  url?: string;
  email?: { provider: string; to: string[] };
  events: string[];
  enabled: boolean;
  disabledReason?: string;
  signing?: { rotating: boolean; previousSecretValidUntil?: string };
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  eventType: string;
  eventId: string;
  dedupeKey?: string;
  status: 'pending' | 'delivering' | 'succeeded' | 'dead';
  attempts: number;
  lastStatus?: number;
  lastError?: string;
  latencyMs?: number;
  createdAt: string;
  deliveredAt?: string;
  giveUpAt?: string;
}

export interface WebhookLog {
  webhook: { id: string; name: string; type: string; enabled: boolean; disabledReason?: string };
  deliveries: WebhookDelivery[];
  nextCursor: string | null;
  summary: { deliveries: number; attempts: number; successRate: number | null; latencyMs: { p50: number | null; p95: number | null; max: number | null }; lastSuccessAt: string | null; lastFailureAt: string | null };
  retry: { windowHours: number; maxAttempts: number; timeoutSeconds: number };
}

export interface Provider {
  id: string;
  kind: string;
  displayName: string;
  configured: boolean;
  costNote?: string;
  settings: Array<{ name: string; set: boolean; source: string; error?: string }>;
}

export interface Licence {
  status: string;
  renderAllowed: boolean;
  mode: string;
  reason: string | null;
  message: string;
  fix?: string;
  key: string | null;
  lastCheckedAt: string | null;
  graceUntil: string | null;
  item: { id: string; title: string } | null;
  activations: { used: number; limit: number | null } | null;
  expiresAt: string | null;
}

export interface AuditEntry {
  id: string;
  at: string;
  actorType: string;
  actorId?: string;
  actorName?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  result: 'success' | 'failure' | 'denied';
  ip?: string;
  requestId?: string;
}

export interface RenderManifest {
  wallClockMillis?: number;
  projectVersion?: number;
  checks?: Record<string, string>;
  scenes?: Array<{ sceneId: string; engine: string; template: string | null; frames: number; millis?: number; frameRange?: [number, number] }>;
  versions?: { server?: string; ffmpeg?: string; engines?: Record<string, string> };
  project?: { title?: string };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The error body's details (e.g. update_config's `issues`). */
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

/** What a key's scopes allow, as the server checks it: admin implies every scope but owner; owner implies all. */
export function can(scopes: string[], scope: string): boolean {
  if (scopes.includes('owner') || scopes.includes(scope)) return true;
  return scope !== 'owner' && scopes.includes('admin');
}

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export class Api {
  constructor(private readonly key: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.key}`, ...extra };
  }

  private async send(method: string, path: string, init: { body?: unknown; accept?: string; idempotent?: boolean; signal?: AbortSignal } = {}): Promise<Response> {
    const headers = this.headers({ Accept: init.accept ?? 'application/json' });
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.idempotent) headers['Idempotency-Key'] = crypto.randomUUID();
    const res = await fetch(path, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: init.signal,
    });
    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = res.statusText || 'request failed';
      let details: Record<string, unknown> | undefined;
      try {
        const b = (await res.json()) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
        code = b.error?.code ?? code;
        message = b.error?.message ?? message;
        details = b.error?.details;
      } catch {
        // not JSON
      }
      throw new HttpError(res.status, code, message, details);
    }
    return res;
  }

  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return (await this.send('GET', path, { signal })).json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown = {}, idempotent = false): Promise<T> {
    return (await this.send('POST', path, { body, idempotent })).json() as Promise<T>;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return (await this.send('PATCH', path, { body })).json() as Promise<T>;
  }

  /**
   * Save a file the API streams (an audit export): fetched with the key in the header,
   * then handed to the browser as an object URL. A plain link would need the key in the URL.
   */
  async download(path: string, fallbackName: string): Promise<void> {
    const res = await this.send('GET', path, { accept: '*/*' });
    const name = /filename="([\w.-]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  /** A file the browser cannot fetch with a header by itself (poster, video): an object URL to revoke later. */
  async objectUrl(path: string, signal?: AbortSignal): Promise<string> {
    const blob = await (await this.send('GET', path, { accept: '*/*', signal })).blob();
    return URL.createObjectURL(blob);
  }

  /**
   * A server-sent event stream (GET /v1/jobs/:id/events) read with fetch, because
   * EventSource cannot send the Authorization header. Resolves when the server ends it.
   */
  async events(path: string, onEvent: (event: string, data: string) => void, signal: AbortSignal): Promise<void> {
    const res = await this.send('GET', path, { accept: 'text/event-stream', signal });
    if (!res.body) return;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += value.replace(/\r\n?/g, '\n');
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = parseEvent(block);
        if (ev) onEvent(ev.event, ev.data);
      }
    }
  }
}

/** One SSE block ("event: x\ndata: y") -> its event name and data. */
export function parseEvent(block: string): { event: string; data: string } | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

/**
 * Where the browser can play a render from. A link signed by this server works
 * on this origin without the key (its path and query only); a bucket link is
 * another origin, which the page's CSP does not allow, so that file is fetched
 * through the API instead.
 */
export function sameOriginLink(r: Pick<RenderSummary, 'downloadUrl' | 'downloadVia'>): string | null {
  if (r.downloadVia !== 'server') return null;
  try {
    const u = new URL(r.downloadUrl);
    return u.pathname.startsWith('/v1/renders/') ? `${u.pathname}${u.search}` : null;
  } catch {
    return null;
  }
}
