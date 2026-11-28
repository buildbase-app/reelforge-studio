import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { badRequest } from './errors';
import type { AuthContext } from './keys';
import { AUDIT_RESULTS, type AuditEntry, type AuditEntryInput, type AuditFilter, type AuditRepository, type AuditResult } from './repositories';

/**
 * The audit log (#65, D-055): one append-only entry per admin or write action,
 * in the database (always) and in any selected extra sinks (audit.sinks:
 * stdout JSON lines, OTLP logs, and plugin sinks such as a signed webhook or
 * S3 export later). Entries never hold secret values: callers never pass them,
 * and `redactSecrets` removes anything that looks like one as a second line of
 * defence.
 */

// ---- request context ------------------------------------------------------------

/** Who and where a request comes from; REST and MCP set it, the service and audit log read it. */
export interface RequestContext {
  requestId: string;
  ip?: string;
  userAgent?: string;
  via: 'rest' | 'mcp' | 'cli' | 'system';
  /**
   * `scheme://host[:port]` the client used, when server.publicUrl is unset and the Host is one of
   * server.allowedHosts: links in answers are then absolute without configuration (#405).
   */
  baseUrl?: string;
  auth?: AuthContext;
  /** Set once the service wrote an audit entry for this call (the transport then writes none). */
  audited?: boolean;
  /** Set when an idempotency key replayed a stored result. */
  idempotentReplay?: boolean;
}

const requests = new AsyncLocalStorage<RequestContext>();

export function runWithRequest<T>(ctx: RequestContext, fn: () => T): T {
  return requests.run(ctx, fn);
}

export function currentRequest(): RequestContext | undefined {
  return requests.getStore();
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The caller's X-Request-Id when it is safe to log, else a new one. */
export function requestIdFrom(header: string | undefined | null): string {
  return header && REQUEST_ID.test(header) ? header : `req_${randomBytes(9).toString('base64url')}`;
}

// ---- secrets never reach the log ----------------------------------------------

const SECRET_NAME = /(secret|password|passwd|token|authorization|api[-_]?key|private[-_]?key|credential)/i;
/** Values that only say whether a secret is set. */
const SAFE_MARKERS = new Set(['set', 'not set', 'cleared', '[redacted]', '']);
const SECRET_VALUE: Array<[RegExp, string]> = [
  [/rf_[A-Za-z0-9_-]{20,}/g, 'rf_[redacted]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
];

/** A copy with secret-looking values removed: properties named like a secret, rf_ keys, bearer tokens, private keys. */
export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 20) return '[truncated]' as T;
  if (typeof value === 'string') {
    let s: string = value;
    for (const [re, rep] of SECRET_VALUE) s = s.replace(re, rep);
    return (s.length > 4000 ? `${s.slice(0, 4000)}…` : s) as T;
  }
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_NAME.test(k) && !(typeof v === 'boolean' || v === null || (typeof v === 'string' && SAFE_MARKERS.has(v)) || (typeof v === 'object' && v !== null))) {
        out[k] = '[redacted]';
      } else out[k] = redactSecrets(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

// ---- sinks ------------------------------------------------------------------------

/**
 * Where audit entries go besides the database. A plugin implements this (a
 * signed webhook, an S3 export, ...) and is registered with
 * `ServiceConfig.auditSinks`; `audit.sinks` selects which run.
 */
export interface AuditSink {
  readonly id: string;
  write(entry: AuditEntry): void | Promise<void>;
  /** Flush buffered entries (called on shutdown). */
  close?(): Promise<void>;
}

/** One JSON object per line on stdout: `{"type":"audit", ...entry}` (container log collectors pick it up). */
export class StdoutAuditSink implements AuditSink {
  readonly id = 'stdout';
  constructor(private readonly out: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {}
  write(entry: AuditEntry) {
    this.out(JSON.stringify({ type: 'audit', ...entry }));
  }
}

type OtlpValue = { stringValue: string } | { intValue: string } | { boolValue: boolean };
const otlpAttr = (key: string, v: unknown): { key: string; value: OtlpValue } | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return { key, value: { boolValue: v } };
  if (typeof v === 'number' && Number.isInteger(v)) return { key, value: { intValue: String(v) } };
  return { key, value: { stringValue: typeof v === 'string' ? v : JSON.stringify(v) } };
};

/**
 * OTLP/HTTP JSON logs (`POST <endpoint>`, normally http://collector:4318/v1/logs),
 * batched (up to 100 entries or 1 s). Opt-in: only with `otlp` in audit.sinks
 * and audit.otlp.endpoint set. Failures are logged and dropped (the database
 * copy is the record of truth).
 */
export class OtlpLogsAuditSink implements AuditSink {
  readonly id = 'otlp';
  private queue: AuditEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> = Promise.resolve();
  private lastWarn = 0;

  constructor(
    private readonly opts: {
      endpoint: string;
      serviceName?: string;
      serviceVersion?: string;
      fetch?: typeof fetch;
      timeoutMs?: number;
      log?: (level: 'info' | 'warn' | 'error', line: string) => void;
    }
  ) {}

  write(entry: AuditEntry) {
    this.queue.push(entry);
    if (this.queue.length >= 100) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), 1000);
      this.timer.unref?.();
    }
  }

  /** The OTLP request body for these entries. */
  body(entries: AuditEntry[]) {
    return {
      resourceLogs: [
        {
          resource: {
            attributes: [otlpAttr('service.name', this.opts.serviceName ?? 'renderweld'), otlpAttr('service.version', this.opts.serviceVersion)].filter(Boolean),
          },
          scopeLogs: [
            {
              scope: { name: 'renderweld.audit' },
              logRecords: entries.map((e) => {
                const ns = `${BigInt(Date.parse(e.at)) * 1_000_000n}`;
                return {
                  timeUnixNano: ns,
                  observedTimeUnixNano: ns,
                  severityNumber: e.result === 'success' ? 9 : 13,
                  severityText: e.result === 'success' ? 'INFO' : 'WARN',
                  eventName: 'renderweld.audit',
                  body: { stringValue: e.action },
                  attributes: [
                    otlpAttr('audit.id', e.id),
                    otlpAttr('audit.action', e.action),
                    otlpAttr('audit.result', e.result),
                    otlpAttr('audit.actor.type', e.actorType),
                    otlpAttr('audit.actor.id', e.actorId),
                    otlpAttr('audit.actor.name', e.actorName),
                    otlpAttr('audit.target.type', e.targetType),
                    otlpAttr('audit.target.id', e.targetId),
                    otlpAttr('client.address', e.ip),
                    otlpAttr('user_agent.original', e.userAgent),
                    otlpAttr('http.request.id', e.requestId),
                    otlpAttr('audit.data', e.data),
                  ].filter(Boolean),
                };
              }),
            },
          ],
        },
      ],
    };
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.queue.splice(0);
    if (!batch.length) return this.inflight;
    this.inflight = this.inflight.then(async () => {
      try {
        const res = await (this.opts.fetch ?? fetch)(this.opts.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(this.body(batch)),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        if (Date.now() - this.lastWarn > 60_000) {
          this.lastWarn = Date.now();
          this.opts.log?.('warn', `audit sink otlp: ${batch.length} entr${batch.length === 1 ? 'y' : 'ies'} not delivered to ${new URL(this.opts.endpoint).origin} (${(e as Error).message}); they are in the database`);
        }
      }
    });
    return this.inflight;
  }

  async close() {
    await this.flush();
  }
}

// ---- export formats ---------------------------------------------------------------

export const AUDIT_EXPORT_FORMATS = ['json', 'jsonl', 'csv'] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];
const CSV_COLUMNS = ['id', 'at', 'actorType', 'actorId', 'actorName', 'action', 'targetType', 'targetId', 'result', 'ip', 'userAgent', 'requestId', 'data'] as const;

export function auditToJsonl(entries: AuditEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
}

/** RFC 4180 CSV with a header row; `data` as JSON. Cells starting with = + - @ are prefixed with ' (spreadsheet formula injection). */
export function auditToCsv(entries: AuditEntry[], header = true): string {
  const rows = entries.map((e) => CSV_COLUMNS.map((c) => csvCell(e[c])).join(','));
  return [...(header ? [CSV_COLUMNS.join(',')] : []), ...rows].join('\r\n') + (header || rows.length ? '\r\n' : '');
}

function csvCell(v: unknown): string {
  const cell = (v: unknown) => {
    let s = v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return cell(v);
}

// ---- query parsing ----------------------------------------------------------------

export const MAX_AUDIT_PAGE = 1000;
export const MAX_AUDIT_EXPORT = 100_000;

/** Opaque page cursor of the entry a page ended with. */
export function auditCursor(e: Pick<AuditEntry, 'at' | 'id'>): string {
  return Buffer.from(`${e.at}|${e.id}`).toString('base64url');
}

/** list_audit_events / GET /v1/audit arguments -> AuditFilter. Throws bad_request. */
export function parseAuditQuery(q: Record<string, unknown>, maxLimit = MAX_AUDIT_PAGE): AuditFilter {
  const str = (k: string) => {
    const v = q[k];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || v.length > 200) throw badRequest(`${k} must be a string`);
    return v;
  };
  const time = (k: string) => {
    const v = str(k);
    if (v === undefined) return undefined;
    const t = Date.parse(v);
    if (!Number.isFinite(t)) throw badRequest(`${k} must be an ISO-8601 time, e.g. "2026-11-21T00:00:00Z"`);
    return new Date(t).toISOString();
  };
  const f: AuditFilter = {};
  const from = time('from'), to = time('to');
  if (from) f.from = from;
  if (to) f.to = to;
  const actorId = str('actorId') ?? str('actor');
  if (actorId) f.actorId = actorId;
  const action = str('action');
  if (action) f.action = action;
  const targetType = str('targetType');
  if (targetType) f.targetType = targetType;
  const targetId = str('targetId') ?? str('target');
  if (targetId) f.targetId = targetId;
  const result = str('result');
  if (result) {
    if (!AUDIT_RESULTS.includes(result as AuditResult)) throw badRequest(`result must be one of ${AUDIT_RESULTS.join(', ')}`);
    f.result = result as AuditResult;
  }
  const cursor = str('cursor');
  if (cursor) {
    const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    if (!at || !id || !Number.isFinite(Date.parse(at))) throw badRequest('cursor is invalid; pass nextCursor from the previous page');
    f.before = { at, id };
  }
  const rawLimit = q.limit;
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== '') {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > maxLimit) throw badRequest(`limit must be an integer from 1 to ${maxLimit}`);
    f.limit = n;
  }
  return f;
}

// ---- the log ----------------------------------------------------------------------

export interface AuditLogOptions {
  sinks?: AuditSink[];
  log?: (level: 'info' | 'warn' | 'error', line: string) => void;
}

/** Writes audit entries (database first, then the selected sinks) and reads them back. */
export class AuditLog {
  private sinks: AuditSink[];

  constructor(
    private readonly repo: AuditRepository,
    private readonly opts: AuditLogOptions = {}
  ) {
    this.sinks = opts.sinks ?? [];
  }

  /** Replace the extra sinks (audit.sinks is a runtime setting). Removed sinks are flushed. */
  setSinks(sinks: AuditSink[]) {
    const removed = this.sinks.filter((s) => !sinks.includes(s));
    this.sinks = sinks;
    for (const s of removed) void s.close?.().catch(() => undefined);
  }

  activeSinks(): string[] {
    return ['database', ...this.sinks.map((s) => s.id)];
  }

  /**
   * Append an entry. The request context (key name, IP, user agent, request
   * id) is added when the entry is about the current request's caller.
   * Secrets are redacted. Sinks get the entry after the database has it; a
   * failing sink never fails the action.
   */
  async write(input: AuditEntryInput): Promise<AuditEntry> {
    const req = currentRequest();
    // The request's fields belong to the entry when it is about the caller (or the caller is not known yet: auth.denied).
    const sameActor = req && (input.actorId === undefined || !req.auth || input.actorId === req.auth.keyId);
    const merged: AuditEntryInput = { ...input };
    if (req && sameActor) {
      if (req.auth && input.actorType === 'api_key') {
        merged.actorId ??= req.auth.keyId;
        merged.actorName ??= req.auth.name;
      }
      merged.ip ??= req.ip;
      merged.userAgent ??= req.userAgent;
      merged.requestId ??= req.requestId;
      if (req.via === 'rest' || req.via === 'mcp') merged.data = { ...(input.data ?? {}), via: req.via };
      req.audited = true;
    }
    if (merged.userAgent && merged.userAgent.length > 512) merged.userAgent = merged.userAgent.slice(0, 512);
    for (const k of ['actorId', 'actorName', 'action', 'targetType', 'targetId', 'ip', 'requestId'] as const) {
      const v = merged[k];
      if (typeof v === 'string' && v.length > 191) merged[k] = v.slice(0, 191);
    }
    const clean = redactSecrets(merged);
    for (const k of Object.keys(clean) as Array<keyof AuditEntryInput>) if (clean[k] === undefined) delete clean[k];
    const entry = await this.repo.write(clean);
    for (const s of this.sinks) {
      try {
        const r = s.write(entry);
        if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((e) => this.sinkFailed(s, e));
      } catch (e) {
        this.sinkFailed(s, e);
      }
    }
    return entry;
  }

  private lastSinkWarn = new Map<string, number>();
  private sinkFailed(s: AuditSink, e: unknown) {
    const now = Date.now();
    if (now - (this.lastSinkWarn.get(s.id) ?? 0) < 60_000) return;
    this.lastSinkWarn.set(s.id, now);
    this.opts.log?.('warn', `audit sink ${s.id} failed: ${(e as Error).message}`);
  }

  /** A page of entries, newest first, with the cursor of the next page. */
  async list(filter: AuditFilter = {}): Promise<{ events: AuditEntry[]; nextCursor: string | null }> {
    const limit = filter.limit ?? 100;
    const events = await this.repo.list({ ...filter, limit });
    return { events, nextCursor: events.length === limit ? auditCursor(events[events.length - 1]!) : null };
  }

  /** Matching entries (up to `max`), newest first, one database page at a time (streamed exports). */
  async *pages(filter: AuditFilter = {}, max = MAX_AUDIT_EXPORT): AsyncGenerator<AuditEntry[]> {
    let before = filter.before;
    let seen = 0;
    while (seen < max) {
      const want = Math.min(MAX_AUDIT_PAGE, max - seen);
      const page = await this.repo.list({ ...filter, before, limit: want });
      if (page.length) yield page;
      seen += page.length;
      if (page.length < want) return;
      before = { at: page[page.length - 1]!.at, id: page[page.length - 1]!.id };
    }
  }

  /** Every matching entry (up to `max`), newest first. */
  async all(filter: AuditFilter = {}, max = MAX_AUDIT_EXPORT): Promise<{ events: AuditEntry[]; truncated: boolean }> {
    const events: AuditEntry[] = [];
    for await (const page of this.pages(filter, max + 1)) events.push(...page);
    return events.length > max ? { events: events.slice(0, max), truncated: true } : { events, truncated: false };
  }

  /** Retention: delete entries older than `retentionDays` (0 keeps everything). */
  async sweep(retentionDays: number, now = Date.now()): Promise<number> {
    if (!(retentionDays > 0)) return 0;
    return this.repo.deleteOlderThan(new Date(now - retentionDays * 86_400_000).toISOString());
  }

  async close() {
    await Promise.all(this.sinks.map((s) => s.close?.().catch(() => undefined)));
  }
}
