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
  /** Output format (#302); absent on renders made before it (MP4). */
  format?: string;
  codec?: string;
  alpha?: boolean;
  file?: string;
  /** Absent for audio-only renders. */
  posterUrl?: string;
  files: string[];
  downloadUrl: string;
  downloadUrlExpiresAt: string;
  downloadVia: 'bucket' | 'server';
  storage?: { driver: string; prefix: string };
  captions?: {
    mode: string;
    burned: boolean;
    cues: number;
    language: string | null;
    files: Array<{ format: string; file: string; downloadUrl: string; downloadUrlExpiresAt: string }>;
    qa: { ok: boolean; issues: Array<{ cue: number; rule: string; message: string }> };
  };
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
    message: string
  ) {
    super(message);
  }
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
      try {
        const b = (await res.json()) as { error?: { code?: string; message?: string } };
        code = b.error?.code ?? code;
        message = b.error?.message ?? message;
      } catch {
        // not JSON
      }
      throw new HttpError(res.status, code, message);
    }
    return res;
  }

  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return (await this.send('GET', path, { signal })).json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown = {}, idempotent = false): Promise<T> {
    return (await this.send('POST', path, { body, idempotent })).json() as Promise<T>;
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
