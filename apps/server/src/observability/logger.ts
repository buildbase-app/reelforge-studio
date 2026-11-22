import { SeverityNumber, context, trace, type Logger as OtelLogger } from '@opentelemetry/api';
import { RuntimeConfig, type ResolvedConfig } from '@reelforge/core';
import { Redactor } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export type LogsExporter = 'stdout' | 'pretty' | 'otlp';

/** What the server and the core call to log. `fields` are structured (JSON keys / OTLP attributes). */
export type LogFn = (level: LogLevel, msg: string, fields?: LogFields) => void;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SEVERITY: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

export interface StructuredLoggerOptions {
  /** The current minimum level (logging.level is a runtime setting: read on every call). */
  level: () => LogLevel;
  exporter?: LogsExporter;
  service?: string;
  quiet?: boolean;
  /** Where lines go (tests capture them). Default: stdout, warn/error to stderr. */
  write?: (level: LogLevel, line: string) => void;
}

/**
 * The server's logger (D-051): JSON lines (`stdout`), readable lines
 * (`pretty`) or JSON lines plus OpenTelemetry log records (`otlp`). Every
 * message and field passes the Redactor first; the active trace and span ids
 * are added so logs and traces join up.
 */
export class StructuredLogger {
  exporter: LogsExporter;
  /** Set by Observability while observability.logs.exporter is `otlp`. */
  otlp: OtelLogger | null = null;
  readonly redactor = new Redactor();
  service: string;
  private readonly write: (level: LogLevel, line: string) => void;

  constructor(private readonly opts: StructuredLoggerOptions) {
    this.exporter = opts.exporter ?? 'stdout';
    this.service = opts.service ?? 'reelforge-studio';
    this.write =
      opts.write ??
      ((level, line) => {
        (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
      });
  }

  enabled(level: LogLevel): boolean {
    return !this.opts.quiet && LEVELS[level] >= LEVELS[this.opts.level()];
  }

  /** Bound, so it can be handed around as a plain function (ServiceConfig.log, prepareDatabase). */
  readonly log: LogFn = (level, msg, fields) => {
    if (!this.enabled(level)) return;
    const text = this.redactor.text(msg);
    const safe = fields ? (this.redactor.value(fields) as LogFields) : undefined;
    const span = trace.getSpan(context.active())?.spanContext();
    const traced = span && span.traceId !== '00000000000000000000000000000000' ? { trace_id: span.traceId, span_id: span.spanId } : {};
    if (this.exporter === 'pretty') {
      const extra = safe ? Object.entries(safe).map(([k, v]) => ` ${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('') : '';
      this.write(level, `[reelforge] ${level === 'info' ? '' : `${level}: `}${text}${extra}`);
    } else {
      this.write(level, JSON.stringify({ time: new Date().toISOString(), level, msg: text, service: this.service, ...safe, ...traced }));
    }
    if (this.exporter === 'otlp' && this.otlp) {
      const attributes: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(safe ?? {})) {
        if (v === undefined || v === null) continue;
        attributes[k] = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : JSON.stringify(v);
      }
      try {
        this.otlp.emit({ severityNumber: SEVERITY[level], severityText: level.toUpperCase(), body: text, attributes, context: context.active() });
      } catch {
        // Never let telemetry break the caller.
      }
    }
  };
}

/**
 * The secret values to redact by exact match: every secret setting's current
 * value (plus the password inside a database URL and each OTLP header value)
 * and provider settings stored with configure_provider.
 */
export function secretValues(resolved: ResolvedConfig, providerOverlay: Record<string, string | undefined> = {}): string[] {
  const out: string[] = [];
  for (const s of resolved.settings.values()) {
    if (!s.def.secret || typeof s.value !== 'string' || !s.value) continue;
    // A SQLite file path is not secret (and is logged on start); any other database URL is.
    const dbUrl = s.def.key === 'database.url' || s.def.key === 'database.readUrl';
    if (dbUrl && s.value.startsWith('file:')) continue;
    out.push(s.value);
    if (dbUrl) {
      try {
        const password = decodeURIComponent(new URL(s.value).password);
        if (password) out.push(password);
      } catch {
        // file: URLs and other non-URL forms hold no password
      }
    }
    if (s.def.key === 'observability.otlp.headers') {
      for (const part of s.value.split(',')) {
        const v = part.slice(part.indexOf('=') + 1).trim();
        if (v) out.push(v, ...v.split(/\s+/).slice(1));
      }
    }
  }
  for (const [name, v] of Object.entries(providerOverlay)) {
    const def = RuntimeConfig.settingForProviderEnv(name);
    if (v && (!def || def.secret)) out.push(v);
  }
  return out;
}
