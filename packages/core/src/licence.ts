import { createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ApiError } from './errors';
import { userAgent } from './product';
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
 *   - validate daily (and at start when the stored answer is not fresh);
 *   - the last good answer and its time are stored (LicenceState), so the
 *     server keeps rendering for up to `offlineGraceDays` (14) while the
 *     licence server cannot be reached;
 *   - start-up never waits for the network; a render waits briefly for a
 *     check that is already running.
 *
 * Several instances on one database (D-098): one deployment = one shared
 * LicenceState = one activation, however many instances run. The automatic
 * checks (start, daily, key change) are single flight per deployment: an
 * instance first takes the check with a compare-and-set on `nextCheckAt`
 * (LicenceRepository.claimCheck), so N api instances make one call a day;
 * the others read the stored, sealed state. A `worker` instance (`readOnly`)
 * never calls the licence server: it reads the stored state every minute and
 * applies it like the api would.
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
  /**
   * The licence server's clock (its HTTP `Date` header), added by
   * BuildBaseLicenceClient; not part of BuildBase's answer body.
   */
  serverTime?: string;
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
  /** Refuse HTTP redirects, so the call never leaves serverUrl's host (release builds, D-039). */
  noRedirects?: boolean;
}

/**
 * The BuildBase licence API over HTTP: the same requests `LicensesApi` of
 * `@buildbase/sdk` 1.8.0 makes (D-035 says why the SDK is not a runtime
 * dependency). Sends `{ key, instance }` and nothing else: no credentials, and
 * no custom header beyond the product User-Agent (#413).
 */
export class BuildBaseLicenceClient implements LicenceApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly redirect: RequestRedirect;

  constructor(opts: BuildBaseLicenceClientOptions) {
    this.redirect = opts.noRedirects ? 'error' : 'follow';
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
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': userAgent('Licence') },
        body: JSON.stringify(body),
        redirect: this.redirect,
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
    const serverTime = res.headers.get('date') ?? undefined;
    if (isAnswer(parsed) && serverTime && !Number.isNaN(Date.parse(serverTime))) parsed.serverTime = new Date(serverTime).toISOString();
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
  /** null when valid; a BuildBase reason (revoked, limit_reached, ...) or grace_expired, unreachable, clock_skew, state_untrusted, deactivated, no_key, not_checked, waiting_for_api (worker). */
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
  /** Which instance of the deployment ran the last licence check (D-098). */
  checkedBy: string | null;
  /** Whether this instance calls the licence server (api / all) or only reads the stored state (worker, D-098). */
  checksLicenceServer: boolean;
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
/** How often a running server records the latest clock time it has seen (besides every start and check). */
const CLOCK_MARK_INTERVAL_MS = 3_600_000;
/** How often an instance re-reads the stored state (a check another instance ran; workers). */
const REFRESH_MS = 60_000;
/** How long an instance holds the deployment's licence check (D-098); another instance takes over after it. */
const CHECK_LEASE_MS = 2 * 60_000;

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

const ACTIVATE_HOW = 'activate_licence (MCP), POST /v1/licence {"key": "..."} (REST) or `renderweld licence activate <key>`';

function explain(reason: string, ctx: { host: string; graceDays: number; lastSuccessAt?: string; error?: string }): Explained {
  switch (reason) {
    case 'no_key':
      return {
        message: 'No licence key is set.',
        fix: `Set the key from your RenderWeld purchase with ${ACTIVATE_HOW} (stored encrypted; needs REELFORGE_SECRET_KEY), or REELFORGE_LICENCE_KEY / REELFORGE_LICENCE_KEY_FILE and restart.`,
      };
    case 'not_found':
      return { message: 'The licence server does not know this licence key.', fix: `Check the key in your RenderWeld purchase (store account, orders) and set it again with ${ACTIVATE_HOW}.` };
    case 'revoked':
      return { message: 'The licence key has been revoked.', fix: 'A refunded or disabled purchase revokes its key. Contact RenderWeld support, or activate another key.' };
    case 'expired':
      return { message: 'The licence has expired.', fix: `Renew the licence or buy a new one, then activate the new key with ${ACTIVATE_HOW}.` };
    case 'not_yet':
      return { message: 'The licence is not valid yet (its start date is in the future).', fix: 'Wait until the start date, or contact RenderWeld support.' };
    case 'limit_reached':
      return {
        message: 'The licence key is already active on as many servers as it allows.',
        fix: `Free an activation: run deactivate_licence (DELETE /v1/licence, \`renderweld licence deactivate\`) on the server that holds it, or release it in your store account; then activate again here with ${ACTIVATE_HOW}.`,
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
    case 'state_untrusted':
      return {
        message:
          'The stored licence state failed its integrity check (it was changed outside RenderWeld, REELFORGE_SECRET_KEY changed, or it was written by an older version), so the offline grace period does not apply until the licence server confirms the licence.',
        fix: `Allow outbound HTTPS to ${ctx.host}; the next successful check restores normal operation (POST /v1/licence or activate_licence checks at once).`,
      };
    case 'not_checked':
      return { message: 'The licence key has not been checked yet.', fix: `Wait a moment, or check at once with ${ACTIVATE_HOW}.` };
    case 'waiting_for_api':
      return {
        message:
          'This worker has not found a licence check in the shared database yet. Workers never call the licence server: an api (or all) instance checks the licence and stores the result, and workers read it.',
        fix: `Start an api instance on the same database with the licence key, or activate it there with ${ACTIVATE_HOW}. This worker starts claiming render jobs within a minute of a successful check.`,
      };
    default:
      return { message: `The licence server refused the licence key (${reason}).`, fix: 'Contact RenderWeld support with this reason.' };
  }
}

// ---- integrity of the stored state (D-089) -------------------------------------------

/** Where the seal lives inside the stored `answer` JSON (no schema change). */
const SEAL_FIELD = '_reelforgeSeal';

interface Seal {
  v: 1;
  serverTimeAt?: string;
  mac: string;
}

/**
 * Key for the stored-state seal: HKDF-SHA256 of the seal secret (see
 * licenceSealSecret) with the instance id as salt. Anyone who knows the secret
 * can still forge a state; the point is that editing the database row alone
 * does not work, and a forged state needs code or the secret. There is no
 * fixed fallback (#305): a seal keyed by a constant anyone can read in the
 * source protected nothing.
 */
export function licenceSealKey(secret: string, instanceId: string): Buffer {
  if (!secret) throw new Error('the licence state seal needs a secret (REELFORGE_SECRET_KEY)');
  return Buffer.from(hkdfSync('sha256', secret, instanceId, 'reelforge licence state seal v1', 32));
}

/** Where a dev build without REELFORGE_SECRET_KEY keeps its random seal secret. */
export const LOCAL_SEAL_FILE = 'licence-seal.key';

/**
 * The secret the stored licence state is sealed with (#305): security.secretKey
 * (REELFORGE_SECRET_KEY or _FILE). A release build refuses to start without it
 * (secretKeyProblem); this throws as a last guard. A dev build without it uses a
 * random secret kept in `<dataDir>/licence-seal.key` (mode 0600, created on
 * first use), so a restart keeps trusting its own state; instances that share a
 * database then need the same REELFORGE_SECRET_KEY to trust each other's.
 * Without a data directory the secret lives only as long as the process.
 */
export function licenceSealSecret(settings: RuntimeConfig, dataDir?: string): string {
  const key = settings.config.security.secretKey;
  if (key) return key;
  if (settings.current.build.edition === 'release') throw new Error('the release edition needs REELFORGE_SECRET_KEY (or REELFORGE_SECRET_KEY_FILE) to seal the licence state');
  if (!dataDir) return randomBytes(32).toString('hex');
  const file = join(dataDir, LOCAL_SEAL_FILE);
  try {
    const text = readFileSync(file, 'utf8').trim();
    if (text.length >= 32) return text;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  mkdirSync(dataDir, { recursive: true });
  const fresh = randomBytes(32).toString('hex');
  try {
    writeFileSync(file, fresh + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    // Another process of this data directory created it first: use that one.
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return readFileSync(file, 'utf8').trim();
    throw e;
  }
  chmodSync(file, 0o600);
  return fresh;
}

function sealMac(key: Buffer, s: LicenceStateRecord, answer: Record<string, unknown> | undefined, serverTimeAt: string | undefined): string {
  const canonical = JSON.stringify([
    s.instanceId,
    s.keyHash ?? null,
    answer ?? null,
    s.lastCheckedAt ?? null,
    s.lastSuccessAt ?? null,
    s.activatedAt ?? null,
    s.deactivatedAt ?? null,
    s.highWaterAt ?? null,
    serverTimeAt ?? null,
  ]);
  return createHmac('sha256', key).update(canonical).digest('hex');
}

/** The state as stored: the seal (and the licence server's time) inside `answer`. */
export function sealLicenceState(s: LicenceStateRecord & { serverTimeAt?: string }, secret: string): LicenceStateRecord {
  const { serverTimeAt, ...rest } = s;
  const answer = rest.answer ? stripSeal(rest.answer) : undefined;
  const seal: Seal = { v: 1, ...(serverTimeAt ? { serverTimeAt } : {}), mac: sealMac(licenceSealKey(secret, s.instanceId), rest, answer, serverTimeAt) };
  return { ...rest, answer: { ...(answer ?? {}), [SEAL_FIELD]: seal } };
}

function stripSeal(answer: Record<string, unknown>): Record<string, unknown> | undefined {
  const { [SEAL_FIELD]: _seal, ...rest } = answer;
  return Object.keys(rest).length ? rest : undefined;
}

/**
 * Read a stored state: verify its seal. A state that carries a licence answer
 * or a last success and whose seal is missing or wrong is not trusted: those
 * fields are dropped (`untrusted: true`), so the server needs an online check
 * before it renders again.
 */
export function unsealLicenceState(stored: LicenceStateRecord, secret: string): { state: LicenceStateRecord & { serverTimeAt?: string }; untrusted: boolean } {
  const raw = stored.answer;
  const seal = raw?.[SEAL_FIELD] as Seal | undefined;
  const answer = raw ? stripSeal(raw) : undefined;
  const state: LicenceStateRecord & { serverTimeAt?: string } = { ...stored };
  if (answer) state.answer = answer;
  else delete state.answer;
  if (seal && typeof seal === 'object' && seal.v === 1 && typeof seal.mac === 'string') {
    const want = Buffer.from(sealMac(licenceSealKey(secret, stored.instanceId), state, answer, seal.serverTimeAt), 'hex');
    const got = Buffer.from(seal.mac, 'hex');
    if (got.length === want.length && timingSafeEqual(got, want)) {
      if (seal.serverTimeAt) state.serverTimeAt = seal.serverTimeAt;
      return { state, untrusted: false };
    }
  }
  if (!answer && !state.lastSuccessAt) return { state, untrusted: false }; // nothing to trust yet (a new state)
  delete state.answer;
  delete state.lastSuccessAt;
  return { state, untrusted: true };
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
  /** Keys the seal of the stored state (D-089): security.secretKey, see licenceSealSecret. Required (#305). */
  sealSecret: string;
  /**
   * Worker role (D-098): never call the licence server, only read the stored
   * state (every `refreshMs`) and apply it. Never writes the state.
   */
  readOnly?: boolean;
  /** This instance's name in `checkedBy` (default `<hostname>-<pid>`; the server passes its worker id). */
  instanceName?: string;
  /** How often the stored state is re-read (default 60 s). */
  refreshMs?: number;
}

/**
 * Keeps the licence state: activates, validates, applies the offline grace
 * period and answers whether renders are allowed. One per running server.
 */
export class LicenceManager {
  private state: (LicenceStateRecord & { serverTimeAt?: string }) | null = null;
  /** The stored state failed its integrity check and no answer has replaced it yet. */
  private untrusted = false;
  private inflight: Promise<LicenceReport> | null = null;
  /** A check was asked for and has not produced its answer yet ("checking"). */
  private pending = false;
  private timer: NodeJS.Timeout | null = null;
  private clockTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = false;
  private lastLogged = '';
  private readonly now: () => number;
  private readonly interval: number;
  private readonly log: NonNullable<LicenceManagerOptions['log']>;
  private readonly name: string;
  /** When this instance got its current key (start or key change): a check of another key stored later is a conflict. */
  private keySeenAt = 0;
  private conflictLogged = false;

  constructor(private readonly opts: LicenceManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.interval = opts.checkIntervalMs ?? DAY;
    this.log = opts.log ?? (() => undefined);
    this.name = opts.instanceName ?? `${hostname()}-${process.pid}`;
  }

  /** Whether this instance only reads the stored state (worker role, D-098). */
  get readOnly(): boolean {
    return Boolean(this.opts.readOnly);
  }

  get mode(): LicenceMode {
    return this.opts.mode;
  }

  /** The stored state, its seal checked (see unsealLicenceState). */
  private async load(): Promise<(LicenceStateRecord & { serverTimeAt?: string }) | null> {
    const stored = await this.opts.repo.get();
    return stored ? this.verify(stored) : null;
  }

  private verify(stored: LicenceStateRecord): LicenceStateRecord & { serverTimeAt?: string } {
    const { state, untrusted } = unsealLicenceState(stored, this.opts.sealSecret);
    if (untrusted && !this.untrusted) {
      this.log(
        'error',
        this.readOnly
          ? 'licence: the stored licence state failed its integrity check (changed outside RenderWeld, or this worker has a different REELFORGE_SECRET_KEY than the api instances); this worker claims no render jobs until it reads a valid state.'
          : 'licence: the stored licence state failed its integrity check (changed outside RenderWeld, REELFORGE_SECRET_KEY changed, or written by an older version); an online licence check is needed before renders are allowed again.'
      );
    }
    // Untrusted until a trusted state with an answer is read: this instance's or another instance's check (D-098).
    this.untrusted = untrusted || (this.untrusted && !(state.answer || state.lastSuccessAt));
    return state;
  }

  private async save(s: LicenceStateRecord & { serverTimeAt?: string }): Promise<void> {
    await this.opts.repo.save(sealLicenceState(s, this.opts.sealSecret));
  }

  /** Read (or create, once) the stored state and record the clock (markClock). No network. */
  async init(): Promise<void> {
    this.keySeenAt = this.now();
    this.state = this.verify(await this.opts.repo.init((this.opts.newInstanceId ?? newInstanceId)(), new Date(this.now()).toISOString()));
    if (this.opts.mode === 'trial') this.log('warn', 'licence: licence.mode "trial" is not built yet; behaving as "required"');
    if (this.readOnly) {
      // A worker only reads (D-098); the clock check against the stored marker still applies in report().
      this.announce();
      return;
    }
    await this.markClock('start');
  }

  /** Re-read the stored state (another instance's check, D-098). No network, no write. */
  async refresh(): Promise<LicenceReport> {
    const stored = await this.load();
    if (stored && !this.inflight) {
      this.state = stored;
      if (this.pending && this.hasOutcome(stored)) this.pending = false;
    }
    this.announce();
    return this.report();
  }

  /** Whether the stored state holds a check result for the configured key. */
  private hasOutcome(s: LicenceStateRecord): boolean {
    if (this.readOnly) return Boolean(s.keyHash && (s.answer || s.lastError || s.lastSuccessAt || s.deactivatedAt));
    const key = this.opts.key().value?.trim();
    return Boolean(key && s.keyHash === licenceKeyHash(key, s.instanceId) && (s.answer || s.lastError || s.lastSuccessAt));
  }

  /**
   * The "highest time seen" marker (highWaterAt), checked and moved forward at
   * every start and hourly while running, not only at licence checks. A clock
   * set back more than 10 minutes behind it gets no offline grace (clock_skew)
   * until it is correct again or a licence check succeeds. It cannot see time
   * that passes while the server is stopped (docs/DEPLOY.md#licence).
   */
  async markClock(why: 'start' | 'timer' = 'timer'): Promise<void> {
    if (this.readOnly) return;
    if (this.inflight) return; // a check is about to store the state (and the marker) anyway
    const stored = (await this.load()) ?? this.state;
    if (!stored) return;
    const now = this.now();
    const high = stored.highWaterAt ? Date.parse(stored.highWaterAt) : undefined;
    if (high !== undefined && now < high - CLOCK_TOLERANCE_MS) {
      this.state = stored;
      if (why === 'start') {
        this.log('error', `licence: the system clock (${this.iso(now)}) is behind the latest time this server has seen (${stored.highWaterAt}); the offline grace period does not apply until the clock is correct or a licence check succeeds.`);
      }
      return;
    }
    if (high !== undefined && now <= high) {
      this.state = stored;
      return;
    }
    const next = { ...stored, highWaterAt: this.iso(now), updatedAt: this.iso(now) };
    if (this.inflight) return;
    // Compare-and-set: never write back an older state over a check another instance just stored.
    if (await this.opts.repo.save(sealLicenceState(next, this.opts.sealSecret), { ifUpdatedAt: stored.updatedAt })) this.state = next;
    else this.state = (await this.load()) ?? stored;
  }

  get instanceId(): string {
    if (!this.state) throw new Error('LicenceManager.init() was not called');
    return this.state.instanceId;
  }

  /**
   * Start the background check (activate or validate) without waiting for it,
   * then daily; single flight per deployment (D-098). A worker (readOnly)
   * only re-reads the stored state.
   */
  start(): void {
    this.stopped = false;
    void this.check('start', { claim: true }).catch(() => undefined);
    if (this.opts.timers === false) return;
    if (!this.clockTimer && !this.readOnly) {
      this.clockTimer = setInterval(() => void this.markClock('timer').catch(() => undefined), CLOCK_MARK_INTERVAL_MS);
      this.clockTimer.unref?.();
    }
    if (!this.refreshTimer) {
      // Re-read what another instance stored; an api instance also takes a check that is due (robust to timer drift and sleep).
      this.refreshTimer = setInterval(() => void this.check('refresh', { claim: true }).catch(() => undefined), this.opts.refreshMs ?? REFRESH_MS);
      this.refreshTimer.unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /**
   * The configured key changed (update_config / activate_licence, or another
   * instance's change reached this one): check it now, in the background,
   * unless another instance already did (D-098).
   */
  keyChanged(): void {
    this.keySeenAt = this.now();
    this.conflictLogged = false;
    void this.check('key changed', { claim: true }).catch(() => undefined);
  }

  private schedule(at: number) {
    if (this.opts.timers === false || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    // setTimeout holds at most ~24.8 days; re-arm in steps.
    const delay = Math.min(Math.max(0, at - this.now()), 2 ** 31 - 1);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check('scheduled', { claim: true }).catch(() => undefined);
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
   * `claim` (the automatic checks): only when the deployment's check is due
   * and this instance wins it (D-098); otherwise the stored state is used.
   * A readOnly manager (worker) never calls the licence server: it re-reads.
   */
  check(why = 'manual', opts: { force?: boolean; claim?: boolean } = {}): Promise<LicenceReport> {
    if (this.inflight && !opts.force) return this.inflight;
    if (this.readOnly) return this.refresh();
    this.pending = true;
    const run = (this.inflight ?? Promise.resolve()).catch(() => undefined).then(() => this.doCheck(why, Boolean(opts.force), Boolean(opts.claim) && !opts.force));
    const p = run.finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private async doCheck(why: string, force: boolean, claim: boolean): Promise<LicenceReport> {
    if (!this.state) await this.init();
    // Another process (another instance, the CLI) may have changed the stored state.
    const stored = await this.load();
    let s: LicenceStateRecord & { serverTimeAt?: string } = { ...(stored ?? this.state!) };
    const key = this.opts.key().value?.trim();
    const now = this.now();
    if (!key) {
      this.state = s;
      this.pending = false;
      this.announce();
      return this.report();
    }
    const hash = licenceKeyHash(key, s.instanceId);
    // The next check that was planned before this one (lease and backoff across instances).
    const plannedAt = s.nextCheckAt ? Date.parse(s.nextCheckAt) : undefined;
    if (claim && !(s.keyHash === hash && s.deactivatedAt)) {
      // Single flight per deployment (D-098): due, or nothing usable is stored for this key and no other instance is
      // about to check (a check planned within the lease window is a lease held by another instance, or a retry).
      const usable = s.keyHash === hash && !this.untrusted && Boolean(s.answer || s.lastError);
      const due = plannedAt === undefined || plannedAt <= now;
      // Another instance checked a different key since this one got its key: instances disagree on the key. Taking the
      // check would alternate activations between the keys on every refresh, so wait for the operator to fix it.
      const conflict = Boolean(s.keyHash && s.keyHash !== hash && s.lastCheckedAt && Date.parse(s.lastCheckedAt) >= this.keySeenAt);
      if (conflict && !this.conflictLogged) {
        this.conflictLogged = true;
        this.log('error', `licence: another instance of this deployment checked a different licence key at ${s.lastCheckedAt}; every instance must use the same key (licence.key). This instance does not check its own key, so that the two keys do not take turns.`);
      }
      const take = due || (!usable && !conflict && plannedAt > now + 2 * CHECK_LEASE_MS);
      // orLaterThan only for "nothing usable stored": a due check is taken only while it is still due.
      const won =
        take && (await this.opts.repo.claimCheck({ now: this.iso(now), leaseUntil: this.iso(now + CHECK_LEASE_MS), ...(due ? {} : { orLaterThan: this.iso(now + 2 * CHECK_LEASE_MS) }) }));
      if (!won) {
        // Another instance checks (or already did): use what it stores; "checking" while its first check for this key runs.
        this.state = stored ?? this.state;
        this.pending = !conflict && !this.hasOutcome(this.state!);
        this.schedule(take || !usable ? now + CHECK_LEASE_MS + Math.round(Math.random() * 5_000) : plannedAt! + Math.round(Math.random() * 5_000));
        this.announce();
        return this.report();
      }
    }
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
      s.answer = { ...sanitize(answer), checkedBy: this.name };
      s.lastCheckedAt = this.iso(at);
      delete s.lastError;
      // The licence server's clock: a local clock behind it gets no grace (clock_skew).
      const serverTime = answer.serverTime ? Date.parse(answer.serverTime) : NaN;
      if (Number.isFinite(serverTime)) s.serverTimeAt = this.iso(serverTime);
      this.untrusted = false;
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
      // The check may move between instances (D-098): double the wait the stored state planned after its last failure, too.
      const planned = claim && s.lastError && plannedAt !== undefined ? plannedAt - Date.parse(s.lastError.at) : 0;
      const backoff = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_BASE_MS * 2 ** (this.failures - 1), planned > 0 ? planned * 2 : 0));
      const wait = Math.max(backoff, (err.retryAfterSeconds ?? 0) * 1000);
      s.lastCheckedAt = this.iso(at);
      s.lastError = { kind: err.kind, message: err.message, ...(err.status ? { status: err.status } : {}), ...(err.code ? { code: err.code } : {}), at: this.iso(at), by: this.name };
      s.highWaterAt = this.iso(Math.max(at, s.highWaterAt ? Date.parse(s.highWaterAt) : 0));
      // Jitter (up to 10 %) so many servers behind one outage do not retry together.
      s.nextCheckAt = this.iso(at + Math.round(wait * (1 + Math.random() * 0.1)));
    }
    s.updatedAt = this.iso(this.now());
    try {
      await this.save(s);
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
    const level = r.status === 'valid' ? 'info' : r.status === 'grace' || r.renderAllowed || r.reason === 'deactivated' || r.reason === 'waiting_for_api' ? 'warn' : 'error';
    const suffix = this.readOnly ? ' [worker: read from the shared database; workers never call the licence server]' : why && why !== 'scheduled' && r.status === 'valid' ? ` [${why}]` : '';
    this.log(level, `${line}${suffix}`);
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
    // A worker applies whatever the api instances checked and stored (it may not know the key itself, D-098).
    const forKey = this.readOnly ? Boolean(s.keyHash) : Boolean(key) && s.keyHash === licenceKeyHash(key!, s.instanceId);
    const answer = forKey ? (s.answer as LicenceAnswer | undefined) : undefined;
    const lastSuccess = forKey && s.lastSuccessAt ? Date.parse(s.lastSuccessAt) : undefined;
    const lastError = forKey ? (s.lastError ?? null) : null;
    const highWater = s.highWaterAt ? Date.parse(s.highWaterAt) : undefined;
    const serverTime = forKey && s.serverTimeAt ? Date.parse(s.serverTimeAt) : undefined;
    const clockOk =
      (lastSuccess === undefined || lastSuccess <= now + CLOCK_TOLERANCE_MS) &&
      (highWater === undefined || now >= highWater - CLOCK_TOLERANCE_MS) &&
      (serverTime === undefined || now >= serverTime - CLOCK_TOLERANCE_MS);

    let status: LicenceStatus;
    let reason: string | null = null;
    let graceUntil: number | undefined;
    if (this.readOnly && !forKey) {
      status = 'checking';
      reason = this.untrusted ? 'state_untrusted' : 'waiting_for_api';
      if (this.untrusted) status = 'invalid';
    } else if (!key && !this.readOnly) {
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
        reason = this.untrusted ? 'state_untrusted' : 'unreachable';
      } else if (this.untrusted) {
        status = this.pending ? 'checking' : 'invalid';
        reason = this.pending ? null : 'state_untrusted';
      } else {
        status = this.pending ? 'checking' : 'invalid';
        reason = this.pending ? null : this.readOnly ? 'waiting_for_api' : 'not_checked';
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
      checkedBy: forKey ? (s.lastError?.by ?? (typeof s.answer?.checkedBy === 'string' ? s.answer.checkedBy : null)) : null,
      checksLicenceServer: !this.readOnly,
      lastSuccessAt: forKey ? (s.lastSuccessAt ?? null) : null,
      graceUntil: graceUntil !== undefined ? new Date(graceUntil).toISOString() : null,
      nextCheckAt: (key || this.readOnly) && !s.deactivatedAt ? (s.nextCheckAt ?? null) : null,
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
    let r = this.report();
    // Another instance of the deployment may have checked since this one last read the state (D-098).
    if (!r.renderAllowed && !this.inflight) r = await this.refresh().catch(() => r);
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
    if (this.readOnly) throw new ApiError('licence_read_only', 409, 'This worker never calls the licence server; deactivate the licence on an api instance.');
    if (this.inflight) await this.inflight.catch(() => undefined);
    if (!this.state) await this.init();
    const key = this.opts.key().value?.trim();
    if (!key) throw new ApiError('licence_key_missing', 409, 'No licence key is set, so there is no activation to give back.');
    const stored = (await this.load()) ?? this.state!;
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
    const s: LicenceStateRecord & { serverTimeAt?: string } = {
      ...(stored.keyHash === hash ? stored : { instanceId: stored.instanceId, keyHash: hash }),
      answer: sanitize(answer),
      lastCheckedAt: at,
      deactivatedAt: at,
      updatedAt: at,
    };
    delete s.activatedAt;
    delete s.lastError;
    delete s.nextCheckAt;
    s.answer = { ...s.answer, checkedBy: this.name };
    await this.save(s);
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
  opts: Pick<LicenceManagerOptions, 'now' | 'checkIntervalMs' | 'timers' | 'log' | 'readOnly' | 'instanceName' | 'refreshMs'> & {
    api?: LicenceApi;
    fetch?: typeof fetch;
    /** The data directory: where a dev build without REELFORGE_SECRET_KEY keeps its seal secret (licenceSealSecret). */
    dataDir?: string;
  } = {}
): LicenceManager {
  const lc = settings.config.licence;
  return new LicenceManager({
    repo: repos.licence,
    // A release build fixes serverUrl (source "build"); its calls also refuse redirects, so they only reach that host.
    api: opts.api ?? new BuildBaseLicenceClient({ serverUrl: lc.serverUrl, orgId: lc.orgId, fetch: opts.fetch, noRedirects: settings.current.build.edition === 'release' }),
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
    sealSecret: licenceSealSecret(settings, opts.dataDir),
    readOnly: opts.readOnly,
    instanceName: opts.instanceName,
    refreshMs: opts.refreshMs,
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
