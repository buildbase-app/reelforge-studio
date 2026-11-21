import { createHmac, randomUUID } from 'node:crypto';
import { ApiError } from './errors';
import type { RuntimeConfig } from './config/runtime';
import type { LicenceRepository, LicenceStateRecord, Repositories } from './repositories';

/**
 * Licence activation (issue #25, D-028, D-035).
 *
 * The licence server is BuildBase's licence API (`LicensesApi` in
 * `@buildbase/sdk`): `POST {serverUrl}/api/v1/licenses/{orgId}/{validate|activate|deactivate}`
 * with `{ key, instance }`, no credentials. Only the licence key and a random
 * instance id (created once, stored in the database) are ever sent.
 *
 *   - activate on first start and whenever the key changes;
 *   - validate at start and then daily;
 *   - the last good answer and its time are stored (LicenceState), so the
 *     server keeps rendering for up to `offlineGraceDays` (14) while the
 *     licence server cannot be reached;
 *   - start-up never waits for the network; a render waits briefly for a
 *     check that is already running.
 */

// ---- the licence server's contract ---------------------------------------------

/** Why a key does not work, as BuildBase answers it (LICENSE_REASON in @buildbase/sdk 1.8). */
export const LICENCE_SERVER_REASONS = ['not_found', 'revoked', 'expired', 'not_yet', 'limit_reached', 'not_activated'] as const;

/** BuildBase `LicenseCheckView`: every answer of validate / activate / deactivate. */
export interface LicenceAnswer {
  valid: boolean;
  reason: string | null;
  key?: { status: string; activations: number; activationLimit: number | null; expiresAt: string | null };
  item?: { id: string; title: string };
  instance?: { instance: string; activatedAt: string } | null;
}

/**
 * The calls the licence module makes. Structurally the same as `LicensesApi`
 * from `@buildbase/sdk`, so an SDK instance can be passed in as is.
 */
export interface LicenceApi {
  validate(key: string, instance?: string, signal?: AbortSignal): Promise<LicenceAnswer>;
  activate(key: string, instance: string, signal?: AbortSignal): Promise<LicenceAnswer>;
  deactivate(key: string, instance: string, signal?: AbortSignal): Promise<LicenceAnswer>;
}

export type LicenceFailureKind = 'unreachable' | 'rate_limited' | 'server_error' | 'refused' | 'bad_response';

/** The licence server could not give an answer (network, 429, 5xx, unexpected response). */
export class LicenceServerError extends Error {
  constructor(
    readonly kind: LicenceFailureKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'LicenceServerError';
  }
}

function isAnswer(v: unknown): v is LicenceAnswer {
  return typeof v === 'object' && v !== null && typeof (v as LicenceAnswer).valid === 'boolean';
}

function retryAfter(header: string | null, body: unknown): number | undefined {
  const fromBody = (body as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  if (typeof fromBody === 'number' && fromBody >= 0) return fromBody;
  if (!header) return undefined;
  if (/^\d+$/.test(header.trim())) return Number(header.trim());
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

export interface BuildBaseLicenceClientOptions {
  /** e.g. https://api.console.buildbase.app */
  serverUrl: string;
  /** Organisation id; `<orgId>-<environment key>` for a non-production environment. */
  orgId: string;
  version?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * The BuildBase licence API over HTTP: the same requests `LicensesApi` of
 * `@buildbase/sdk` 1.8.0 makes (D-035 says why the SDK is not a runtime
 * dependency). Sends `{ key, instance }` and nothing else: no credentials, no
 * custom headers.
 */
export class BuildBaseLicenceClient implements LicenceApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: BuildBaseLicenceClientOptions) {
    this.base = `${opts.serverUrl.replace(/\/+$/, '')}/api/${opts.version ?? 'v1'}/licenses/${encodeURIComponent(opts.orgId)}`;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  validate(key: string, instance?: string, signal?: AbortSignal) {
    return this.post('validate', instance ? { key, instance } : { key }, signal);
  }
  activate(key: string, instance: string, signal?: AbortSignal) {
    return this.post('activate', { key, instance }, signal);
  }
  deactivate(key: string, instance: string, signal?: AbortSignal) {
    return this.post('deactivate', { key, instance }, signal);
  }

  private async post(op: string, body: { key: string; instance?: string }, signal?: AbortSignal): Promise<LicenceAnswer> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      const why = timeout.aborted ? `no answer within ${Math.round(this.timeoutMs / 1000)} s` : (err.cause?.code ?? err.message);
      throw new LicenceServerError('unreachable', `licence server unreachable (${why})`);
    }
    let parsed: unknown = null;
    const text = await res.text().catch(() => '');
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (res.ok) {
      if (isAnswer(parsed)) return parsed;
      throw new LicenceServerError('bad_response', `licence server sent an unexpected answer (HTTP ${res.status})`, res.status);
    }
    const code = typeof (parsed as { code?: unknown } | null)?.code === 'string' ? (parsed as { code: string }).code : undefined;
    const message = typeof (parsed as { message?: unknown } | null)?.message === 'string' ? (parsed as { message: string }).message : undefined;
    if (res.status === 429) {
      throw new LicenceServerError('rate_limited', `licence server: too many checks (${code ?? 'HTTP 429'})`, 429, code ?? 'LICENSE_CHECKS_LIMITED', retryAfter(res.headers.get('retry-after'), parsed));
    }
    if (res.status >= 500) throw new LicenceServerError('server_error', `licence server error (HTTP ${res.status}${code ? ` ${code}` : ''})`, res.status, code, retryAfter(res.headers.get('retry-after'), parsed));
    // A refusal that still carries an answer (e.g. a 404 with reason "not_found") is an answer.
    if (isAnswer(parsed) && typeof parsed.reason === 'string') return parsed;
    throw new LicenceServerError('refused', `licence server refused the request (HTTP ${res.status}${code ? ` ${code}` : ''}${message ? `: ${message.slice(0, 200)}` : ''})`, res.status, code);
  }
}

// ---- status ------------------------------------------------------------------------

export type LicenceMode = 'required' | 'off' | 'trial';
/**
 * valid: full use. grace: full use, the licence server is unreachable and the
 * last success is recent enough. invalid: renders refused. unlicensed: no key.
 * checking: a key is set and the first check is running.
 */
export type LicenceStatus = 'valid' | 'grace' | 'invalid' | 'unlicensed' | 'checking';

export interface LicenceReport {
  status: LicenceStatus;
  /** Whether render_project / preview_scene are allowed right now. */
  renderAllowed: boolean;
  mode: LicenceMode;
  /** null when valid; a BuildBase reason (revoked, limit_reached, ...) or grace_expired, unreachable, clock_skew, deactivated, no_key, not_checked. */
  reason: string | null;
  message: string;
  /** What to do about it, when something is wrong. */
  fix?: string;
  /** Shown in get_capabilities and logged while in grace (or when the mode is not enforced). */
  warning?: string;
  /** First group only, e.g. "ABCDE-*****-*****-*****-*****". */
  key: string | null;
  keySource: string | null;
  instanceId: string;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  /** Renders keep working until then without reaching the licence server. */
  graceUntil: string | null;
  nextCheckAt: string | null;
  item: { id: string; title: string } | null;
  activations: { used: number; limit: number | null } | null;
  expiresAt: string | null;
  activatedAt: string | null;
  deactivatedAt: string | null;
  lastError: { kind: string; message: string; status?: number; code?: string; at: string } | null;
  licenceServer: { url: string; orgId: string };
}

const DAY = 86_400_000;
/** How far the clock may be off before the stored times are not trusted. */
const CLOCK_TOLERANCE_MS = 10 * 60_000;
/** Backoff after a failed check: 1 min, doubling, at most 6 h (Retry-After wins when longer). */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 6 * 3_600_000;
/** How long a render waits for a check that is already running. */
const RENDER_WAIT_MS = 20_000;

/** "ABCDE-FGHJK-..." → "ABCDE-*****-...": the first group only. */
export function maskLicenceKey(key: string): string {
  const k = key.trim();
  const groups = k.includes('-') ? k.split('-') : (k.match(/.{1,5}/g) ?? [k]);
  return [groups[0]!.slice(0, 5), ...groups.slice(1).map((g) => '*'.repeat(Math.max(1, g.length)))].join('-');
}

/** HMAC of the key with the instance id: which key the stored state is for, without storing the key. */
export function licenceKeyHash(key: string, instanceId: string): string {
  return createHmac('sha256', `reelforge-licence:${instanceId}`).update(key.trim()).digest('hex');
}

export function newInstanceId(): string {
  return `rf-${randomUUID()}`;
}

interface Explained {
  message: string;
  fix?: string;
}

const ACTIVATE_HOW = 'activate_licence (MCP), POST /v1/licence {"key": "..."} (REST) or `reelforge licence activate <key>`';

function explain(reason: string, ctx: { host: string; graceDays: number; lastSuccessAt?: string; error?: string }): Explained {
  switch (reason) {
    case 'no_key':
      return {
        message: 'No licence key is set.',
        fix: `Set the key from your ReelForge purchase with ${ACTIVATE_HOW} (stored encrypted; needs REELFORGE_SECRET_KEY), or REELFORGE_LICENCE_KEY / REELFORGE_LICENCE_KEY_FILE and restart.`,
      };
    case 'not_found':
      return { message: 'The licence server does not know this licence key.', fix: `Check the key in your ReelForge purchase (store account, orders) and set it again with ${ACTIVATE_HOW}.` };
    case 'revoked':
      return { message: 'The licence key has been revoked.', fix: 'A refunded or disabled purchase revokes its key. Contact ReelForge support, or activate another key.' };
    case 'expired':
      return { message: 'The licence has expired.', fix: `Renew the licence or buy a new one, then activate the new key with ${ACTIVATE_HOW}.` };
    case 'not_yet':
      return { message: 'The licence is not valid yet (its start date is in the future).', fix: 'Wait until the start date, or contact ReelForge support.' };
    case 'limit_reached':
      return {
        message: 'The licence key is already active on as many servers as it allows.',
        fix: `Free an activation: run deactivate_licence (DELETE /v1/licence, \`reelforge licence deactivate\`) on the server that holds it, or release it in your store account; then activate again here with ${ACTIVATE_HOW}.`,
      };
    case 'not_activated':
      return { message: 'This server holds no activation of the licence key.', fix: `Activate it with ${ACTIVATE_HOW}.` };
    case 'deactivated':
      return { message: 'This server gave its licence activation back (deactivate_licence).', fix: `Activate again with ${ACTIVATE_HOW}.` };
    case 'grace_expired':
      return {
        message: `The licence server (${ctx.host}) has not been reachable for more than ${ctx.graceDays} days${ctx.lastSuccessAt ? ` (last successful check ${ctx.lastSuccessAt})` : ''}.`,
        fix: `Allow outbound HTTPS to ${ctx.host} (firewall, proxy). Renders work again after the next successful check; POST /v1/licence or activate_licence checks at once.`,
      };
    case 'unreachable':
      return {
        message: `The licence key could not be checked: the licence server (${ctx.host}) is unreachable${ctx.error ? ` (${ctx.error})` : ''}. The first activation needs it once; after that the server works offline for up to ${ctx.graceDays} days.`,
        fix: `Allow outbound HTTPS to ${ctx.host}. The server retries by itself; POST /v1/licence or activate_licence retries at once.`,
      };
    case 'clock_skew':
      return {
        message: 'The system clock is earlier than the last licence check, so the offline grace period cannot be trusted.',
        fix: `Correct the system clock (NTP), or let the server reach ${ctx.host} for a fresh check.`,
      };
    case 'not_checked':
      return { message: 'The licence key has not been checked yet.', fix: `Wait a moment, or check at once with ${ACTIVATE_HOW}.` };
    default:
      return { message: `The licence server refused the licence key (${reason}).`, fix: 'Contact ReelForge support with this reason.' };
  }
}

// ---- the manager ---------------------------------------------------------------------

export interface LicenceManagerOptions {
  repo: LicenceRepository;
  api: LicenceApi;
  /** The configured key now and where it comes from (runtime settings can change it). */
  key: () => { value?: string; source?: string };
  mode: LicenceMode;
  graceDays: number;
  licenceServer: { url: string; orgId: string };
  /** Injectable clock (ms since epoch). */
  now?: () => number;
  checkIntervalMs?: number;
  log?: (level: 'info' | 'warn' | 'error', line: string) => void;
  newInstanceId?: () => string;
  /** Schedule the daily check and retries (default true; the CLI turns it off). */
  timers?: boolean;
}

/**
 * Keeps the licence state: activates, validates, applies the offline grace
 * period and answers whether renders are allowed. One per running server.
 */
export class LicenceManager {
  private state: LicenceStateRecord | null = null;
  private inflight: Promise<LicenceReport> | null = null;
  /** A check was asked for and has not produced its answer yet ("checking"). */
  private pending = false;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = false;
  private lastLogged = '';
  private readonly now: () => number;
  private readonly interval: number;
  private readonly log: NonNullable<LicenceManagerOptions['log']>;

  constructor(private readonly opts: LicenceManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.interval = opts.checkIntervalMs ?? DAY;
    this.log = opts.log ?? (() => undefined);
  }

  get mode(): LicenceMode {
    return this.opts.mode;
  }

  /** Read (or create, once) the stored state. No network. */
  async init(): Promise<void> {
    this.state = await this.opts.repo.init((this.opts.newInstanceId ?? newInstanceId)(), new Date(this.now()).toISOString());
    if (this.opts.mode === 'trial') this.log('warn', 'licence: licence.mode "trial" is not built yet; behaving as "required"');
  }

  get instanceId(): string {
    if (!this.state) throw new Error('LicenceManager.init() was not called');
    return this.state.instanceId;
  }

  /** Start the background check (activate or validate) without waiting for it, then daily. */
  start(): void {
    this.stopped = false;
    void this.check('start').catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The configured key changed (update_config / activate_licence): check it now, in the background. */
  keyChanged(): void {
    void this.check('key changed').catch(() => undefined);
  }

  private schedule(at: number) {
    if (this.opts.timers === false || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    // setTimeout holds at most ~24.8 days; re-arm in steps.
    const delay = Math.min(Math.max(0, at - this.now()), 2 ** 31 - 1);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check('scheduled').catch(() => undefined);
    }, delay);
    this.timer.unref?.();
  }

  private iso(ms: number) {
    return new Date(ms).toISOString();
  }

  /**
   * Activate (first time for this key, or after the activation was lost) or
   * validate the configured key. Single flight: a call while a check runs
   * gets that check's result. `force` also activates a deactivated key.
   */
  check(why = 'manual', opts: { force?: boolean } = {}): Promise<LicenceReport> {
    if (this.inflight && !opts.force) return this.inflight;
    this.pending = true;
    const run = (this.inflight ?? Promise.resolve()).catch(() => undefined).then(() => this.doCheck(why, Boolean(opts.force)));
    const p = run.finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private async doCheck(why: string, force: boolean): Promise<LicenceReport> {
    if (!this.state) await this.init();
    // Another process (the CLI) may have changed the stored state.
    const stored = await this.opts.repo.get();
    let s: LicenceStateRecord = { ...(stored ?? this.state!) };
    const key = this.opts.key().value?.trim();
    const now = this.now();
    if (!key) {
      this.state = s;
      this.pending = false;
      this.announce();
      return this.report();
    }
    const hash = licenceKeyHash(key, s.instanceId);
    if (s.keyHash !== hash) {
      // A different key: nothing stored applies to it.
      s = { instanceId: s.instanceId, keyHash: hash, ...(s.highWaterAt ? { highWaterAt: s.highWaterAt } : {}), updatedAt: this.iso(now) };
    }
    if (force) {
      delete s.deactivatedAt;
      delete s.activatedAt;
    } else if (s.deactivatedAt) {
      // Given back on purpose: never take the activation again by itself.
      this.state = s;
      this.pending = false;
      this.announce();
      return this.report();
    }
    const activate = !s.activatedAt;
    try {
      let answer = activate ? await this.opts.api.activate(key, s.instanceId) : await this.opts.api.validate(key, s.instanceId);
      // The activation was freed elsewhere (seller reset, store account): take a slot again.
      if (!activate && !answer.valid && answer.reason === 'not_activated') answer = await this.opts.api.activate(key, s.instanceId);
      const at = this.now();
      s.answer = sanitize(answer);
      s.lastCheckedAt = this.iso(at);
      delete s.lastError;
      if (answer.valid) {
        s.lastSuccessAt = this.iso(at);
        s.activatedAt = s.activatedAt ?? answer.instance?.activatedAt ?? this.iso(at);
        // A fresh success is the reference time again (a clock that was wrong and got fixed).
        s.highWaterAt = this.iso(at);
      } else {
        if (answer.reason === 'not_activated' || answer.reason === 'limit_reached' || answer.reason === 'not_found') delete s.activatedAt;
        s.highWaterAt = this.iso(Math.max(at, s.highWaterAt ? Date.parse(s.highWaterAt) : 0));
      }
      this.failures = 0;
      s.nextCheckAt = this.iso(at + this.interval);
    } catch (e) {
      const at = this.now();
      const err =
        e instanceof LicenceServerError ? e : new LicenceServerError('unreachable', `licence check failed (${(e as Error)?.message ?? String(e)})`);
      this.failures++;
      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.failures - 1));
      const wait = Math.max(backoff, (err.retryAfterSeconds ?? 0) * 1000);
      s.lastCheckedAt = this.iso(at);
      s.lastError = { kind: err.kind, message: err.message, ...(err.status ? { status: err.status } : {}), ...(err.code ? { code: err.code } : {}), at: this.iso(at) };
      s.highWaterAt = this.iso(Math.max(at, s.highWaterAt ? Date.parse(s.highWaterAt) : 0));
      // Jitter (up to 10 %) so many servers behind one outage do not retry together.
      s.nextCheckAt = this.iso(at + Math.round(wait * (1 + Math.random() * 0.1)));
    }
    s.updatedAt = this.iso(this.now());
    try {
      await this.opts.repo.save(s);
    } finally {
      this.state = s;
      this.pending = false;
    }
    this.schedule(Date.parse(s.nextCheckAt!));
    this.announce(why);
    return this.report();
  }

  /** Log status changes (and each failed check while in grace). Never logs the key. */
  private announce(why?: string) {
    const r = this.report();
    const line =
      r.status === 'valid'
        ? `licence: valid${r.item ? ` (${r.item.title})` : ''}${r.activations ? `, ${r.activations.used}/${r.activations.limit ?? '∞'} activations` : ''}`
        : r.status === 'grace'
          ? `licence: ${r.warning}`
          : r.status === 'unlicensed'
            ? `licence: ${r.message}${r.renderAllowed ? ' (licence.mode "off": renders are allowed)' : ` Renders are refused. ${r.fix}`}`
            : `licence: ${r.status}${r.reason ? ` (${r.reason})` : ''}: ${r.message}${r.renderAllowed ? '' : ' Renders are refused.'}${r.fix ? ` Fix: ${r.fix}` : ''}`;
    const sig = `${r.status}|${r.reason}|${r.status === 'grace' ? r.lastError?.at : ''}`;
    if (sig === this.lastLogged) return;
    this.lastLogged = sig;
    const level = r.status === 'valid' ? 'info' : r.status === 'grace' || r.renderAllowed || r.reason === 'deactivated' ? 'warn' : 'error';
    this.log(level, why && why !== 'scheduled' && r.status === 'valid' ? `${line} [${why}]` : line);
  }

  /** The current status, from the stored state and the clock. */
  report(): LicenceReport {
    const s = this.state;
    if (!s) throw new Error('LicenceManager.init() was not called');
    const mode = this.opts.mode;
    const enforced = mode !== 'off';
    const k = this.opts.key();
    const key = k.value?.trim();
    const now = this.now();
    const graceMs = this.opts.graceDays * DAY;
    const host = safeHost(this.opts.licenceServer.url);
    const forKey = Boolean(key) && s.keyHash === licenceKeyHash(key!, s.instanceId);
    const answer = forKey ? (s.answer as LicenceAnswer | undefined) : undefined;
    const lastSuccess = forKey && s.lastSuccessAt ? Date.parse(s.lastSuccessAt) : undefined;
    const lastError = forKey ? (s.lastError ?? null) : null;
    const highWater = s.highWaterAt ? Date.parse(s.highWaterAt) : undefined;
    const clockOk = (lastSuccess === undefined || lastSuccess <= now + CLOCK_TOLERANCE_MS) && (highWater === undefined || now >= highWater - CLOCK_TOLERANCE_MS);

    let status: LicenceStatus;
    let reason: string | null = null;
    let graceUntil: number | undefined;
    if (!key) {
      status = 'unlicensed';
      reason = 'no_key';
    } else if (forKey && s.deactivatedAt) {
      status = 'invalid';
      reason = 'deactivated';
    } else if (answer && !answer.valid) {
      // The licence server said no; being offline now does not change that.
      status = 'invalid';
      reason = answer.reason ?? 'refused';
    } else if (lastSuccess === undefined) {
      if (lastError) {
        status = 'invalid';
        reason = 'unreachable';
      } else {
        status = this.pending ? 'checking' : 'invalid';
        reason = this.pending ? null : 'not_checked';
      }
    } else if (!clockOk) {
      status = 'invalid';
      reason = 'clock_skew';
    } else if (now - lastSuccess > graceMs) {
      status = this.pending ? 'checking' : 'invalid';
      reason = 'grace_expired';
    } else {
      graceUntil = lastSuccess + graceMs;
      status = lastError ? 'grace' : 'valid';
    }

    const ex = reason ? explain(reason, { host, graceDays: this.opts.graceDays, lastSuccessAt: s.lastSuccessAt, error: lastError?.message }) : null;
    const allowed = status === 'valid' || status === 'grace';
    let message = ex?.message ?? (status === 'checking' ? 'The licence is being checked.' : 'The licence is valid.');
    let warning: string | undefined;
    if (status === 'grace') {
      message = `The licence server cannot be reached; the licence was last confirmed ${s.lastSuccessAt}.`;
      warning = `licence server unreachable (${lastError?.message ?? 'no answer'}); renders keep working until ${new Date(graceUntil!).toISOString()} (offline grace, ${this.opts.graceDays} days from the last successful check). Allow outbound HTTPS to ${host}.`;
    } else if (!allowed && !enforced) {
      warning = `licence ${status}${reason ? ` (${reason})` : ''}, but licence.mode is "off" (development/CI): renders are allowed.`;
    }
    if (mode === 'trial' && !allowed) message += ' (licence.mode "trial" is not built yet and behaves as "required".)';
    const ak = answer?.key;
    return {
      status,
      renderAllowed: allowed || !enforced,
      mode,
      reason,
      message,
      ...(ex?.fix ? { fix: ex.fix } : {}),
      ...(warning ? { warning } : {}),
      key: key ? maskLicenceKey(key) : null,
      keySource: key ? (k.source ?? null) : null,
      instanceId: s.instanceId,
      lastCheckedAt: forKey ? (s.lastCheckedAt ?? null) : null,
      lastSuccessAt: forKey ? (s.lastSuccessAt ?? null) : null,
      graceUntil: graceUntil !== undefined ? new Date(graceUntil).toISOString() : null,
      nextCheckAt: key && !s.deactivatedAt ? (s.nextCheckAt ?? null) : null,
      item: answer?.item ? { id: answer.item.id, title: answer.item.title } : null,
      activations: ak ? { used: ak.activations, limit: ak.activationLimit } : null,
      expiresAt: ak?.expiresAt ?? null,
      activatedAt: forKey ? (s.activatedAt ?? null) : null,
      deactivatedAt: forKey ? (s.deactivatedAt ?? null) : null,
      lastError,
      licenceServer: { ...this.opts.licenceServer },
    };
  }

  /** Short form for get_capabilities. */
  summary() {
    const r = this.report();
    return {
      status: r.status,
      renderAllowed: r.renderAllowed,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.graceUntil ? { graceUntil: r.graceUntil } : {}),
      ...(r.warning ? { warning: r.warning } : {}),
      ...(!r.renderAllowed && r.fix ? { fix: r.fix } : {}),
      details: 'get_licence (GET /v1/licence)',
    };
  }

  /**
   * Throw a structured error when renders are not allowed. Waits (briefly)
   * for a check that is already running, so a render right after start-up or
   * after activate_licence gets the fresh answer.
   */
  async assertRenderAllowed(): Promise<void> {
    if (this.inflight) {
      let t: NodeJS.Timeout | undefined;
      await Promise.race([this.inflight.catch(() => undefined), new Promise((r) => (t = setTimeout(r, RENDER_WAIT_MS)))]);
      clearTimeout(t);
    }
    const r = this.report();
    if (r.renderAllowed) return;
    const code = r.status === 'unlicensed' ? 'licence_required' : 'licence_invalid';
    throw new ApiError(code, 403, `Rendering is disabled: ${r.message}${r.fix ? ` Fix: ${r.fix}` : ''} Existing projects and renders can still be read, listed and downloaded.`, {
      licence: { status: r.status, reason: r.reason, message: r.message, fix: r.fix, key: r.key, lastSuccessAt: r.lastSuccessAt, lastError: r.lastError },
    });
  }

  /** Activate the configured key now (also a deactivated one) and wait for the answer. */
  activateNow(): Promise<LicenceReport> {
    return this.check('activate', { force: true });
  }

  /** Give this server's activation back. The key stays configured but is not activated again by itself. */
  async deactivate(): Promise<LicenceReport> {
    if (this.inflight) await this.inflight.catch(() => undefined);
    if (!this.state) await this.init();
    const key = this.opts.key().value?.trim();
    if (!key) throw new ApiError('licence_key_missing', 409, 'No licence key is set, so there is no activation to give back.');
    const stored = (await this.opts.repo.get()) ?? this.state!;
    let answer: LicenceAnswer;
    try {
      answer = await this.opts.api.deactivate(key, stored.instanceId);
    } catch (e) {
      const err = e instanceof LicenceServerError ? e : new LicenceServerError('unreachable', (e as Error).message);
      throw new ApiError('licence_server_unavailable', err.kind === 'rate_limited' ? 429 : 503, `The activation was not given back: ${err.message}. Nothing changed; try again later.`, {
        kind: err.kind,
        ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
      });
    }
    const at = this.iso(this.now());
    const hash = licenceKeyHash(key, stored.instanceId);
    const s: LicenceStateRecord = {
      ...(stored.keyHash === hash ? stored : { instanceId: stored.instanceId, keyHash: hash }),
      answer: sanitize(answer),
      lastCheckedAt: at,
      deactivatedAt: at,
      updatedAt: at,
    };
    delete s.activatedAt;
    delete s.lastError;
    delete s.nextCheckAt;
    await this.opts.repo.save(s);
    this.state = s;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.announce();
    return this.report();
  }
}

/**
 * A LicenceManager configured from the effective configuration (licence.*):
 * the key follows runtime changes. Used by the service and the CLI.
 */
export function createLicenceManager(
  settings: RuntimeConfig,
  repos: Repositories,
  opts: { api?: LicenceApi; fetch?: typeof fetch; now?: () => number; checkIntervalMs?: number; timers?: boolean; log?: LicenceManagerOptions['log'] } = {}
): LicenceManager {
  const lc = settings.config.licence;
  return new LicenceManager({
    repo: repos.licence,
    api: opts.api ?? new BuildBaseLicenceClient({ serverUrl: lc.serverUrl, orgId: lc.orgId, fetch: opts.fetch }),
    key: () => {
      const st = settings.current.settings.get('licence.key');
      const value = typeof st?.value === 'string' ? st.value : undefined;
      return { value, source: st && st.source !== 'default' ? `${st.source}${st.origin && st.source !== 'runtime' ? ` (${st.origin})` : ''}` : undefined };
    },
    mode: lc.mode,
    graceDays: lc.offlineGraceDays,
    licenceServer: { url: lc.serverUrl, orgId: lc.orgId },
    now: opts.now,
    checkIntervalMs: opts.checkIntervalMs,
    timers: opts.timers,
    log: opts.log,
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Keep only the documented fields of an answer (nothing else is stored). */
function sanitize(a: LicenceAnswer): Record<string, unknown> {
  return {
    valid: a.valid,
    reason: a.reason ?? null,
    ...(a.key
      ? { key: { status: String(a.key.status), activations: Number(a.key.activations), activationLimit: a.key.activationLimit ?? null, expiresAt: a.key.expiresAt ?? null } }
      : {}),
    ...(a.item ? { item: { id: String(a.item.id), title: String(a.item.title) } } : {}),
    ...(a.instance ? { instance: { instance: String(a.instance.instance), activatedAt: String(a.instance.activatedAt) } } : a.instance === null ? { instance: null } : {}),
  };
}
