import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { ApiError, badRequest, notFound } from './errors';
import { newId } from './fsutil';
import { weakKeyReason } from './keyStrength';
import { PRIORITIES, isPriority, type JobPriority } from './priority';
import {
  SCOPES,
  type ApiKeyPatch,
  type ApiKeyRecord,
  type ApiKeyRepository,
  type ApiKeySecret,
  type AuditEntryInput,
  type Scope,
} from './repositories';

export { SCOPES, type ApiKeyRecord, type Scope } from './repositories';

export type KeyStatus = 'active' | 'expired' | 'revoked';

/** A key as the API shows it: never the salt, hash or previous secret. */
export type PublicKey = Omit<ApiKeyRecord, 'salt' | 'hash' | 'prev'> & {
  status: KeyStatus;
  /** After a rotation: the previous secret keeps working until then. */
  previousSecretExpiresAt?: string;
};

export interface AuthContext {
  keyId: string;
  name: string;
  scopes: Scope[];
  /** Per-key limits (unset: the server-wide setting / unlimited). */
  rateLimitPerMinute?: number;
  rendersPerDay?: number;
  rendersPerMonth?: number;
  /** Highest job priority this key may ask for (unset: each job type's default class; D-103). */
  maxPriority?: JobPriority;
  /** The request used the previous secret of a rotated key (inside the grace window). */
  previousSecret?: boolean;
}

/** Why a presented key was refused. `key` is set when the secret matched a known key. */
export type AuthFailure = { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'ip_not_allowed'; key?: { id: string; name: string }; message: string };
export type AuthResult = { ok: true; auth: AuthContext } | AuthFailure;

/** Lifecycle options of a key (create and update_key). null clears one. */
export interface KeyOptions {
  /** ISO time in the future, or null for no expiry. */
  expiresAt?: string | null;
  /** Requests per minute for this key; null: limits.rateLimitPerMinute. 0 disables the limit for it. */
  rateLimitPerMinute?: number | null;
  /** Render and preview jobs per UTC day / calendar month; null: unlimited. */
  rendersPerDay?: number | null;
  rendersPerMonth?: number | null;
  /** CIDR blocks ("10.0.0.0/8", "2001:db8::/32", or a single address); null or []: anywhere. */
  ipAllowlist?: string[] | null;
  /**
   * Highest job priority the key may use (`interactive`, `standard`, `batch`); null: each job type's default
   * (previews `interactive`, renders `standard`), so the key can lower a job's class but not raise it (D-103).
   */
  maxPriority?: JobPriority | null;
}

/** Who did something (audit log). */
export interface KeyActor {
  actorType: 'api_key' | 'cli' | 'system';
  actorId?: string;
}

export interface KeyStoreOptions {
  /** Writes an audit entry for every lifecycle change (create, update, rotate, revoke, delete). */
  audit?: (entry: AuditEntryInput) => Promise<unknown>;
  /** keys.rotationGraceHours (read at each rotation; default 24). */
  rotationGraceHours?: () => number;
  now?: () => number;
}

const KEY_FORMAT = /^rf_[A-Za-z0-9_-]{20,128}$/;
/** Characters of the key stored in clear as `prefix` (lookup index). */
const PREFIX_LENGTH = 7;
const MAX_ALLOWLIST = 50;
export const MAX_ROTATION_GRACE_HOURS = 720;

function hashKey(salt: string, key: string): string {
  return createHash('sha256').update(salt).update(key).digest('hex');
}

function secretFor(key: string): ApiKeySecret {
  const salt = randomBytes(16).toString('hex');
  return { prefix: key.slice(0, PREFIX_LENGTH), salt, hash: hashKey(salt, key) };
}

function matches(secret: ApiKeySecret, presented: string): boolean {
  if (secret.prefix !== presented.slice(0, PREFIX_LENGTH)) return false;
  const a = Buffer.from(hashKey(secret.salt, presented), 'hex');
  const b = Buffer.from(secret.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A new key: "rf_" + 32 random bytes, base64url. */
export function generateKey(): string {
  return `rf_${randomBytes(32).toString('base64url')}`;
}

export function hasScope(auth: AuthContext, scope: Scope): boolean {
  return auth.scopes.includes('admin') || auth.scopes.includes(scope);
}

// ---- IP allowlists ------------------------------------------------------------

/** "::ffff:10.1.2.3" (IPv4-mapped, as Node reports IPv4 clients on a dual-stack socket) -> "10.1.2.3". */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip.trim());
  return m ? m[1]! : ip.trim();
}

/** Validate and normalise one CIDR block; a bare address becomes /32 or /128. Throws bad_request. */
export function parseCidr(input: string): { address: string; prefix: number; family: 4 | 6; text: string } {
  const [addr = '', len, extra] = String(input).trim().split('/');
  const address = normalizeIp(addr);
  const family = isIP(address);
  if (!family || extra !== undefined) throw badRequest(`"${input}" is not an IP address or CIDR block (e.g. "203.0.113.0/24", "2001:db8::/32")`);
  const max = family === 4 ? 32 : 128;
  const prefix = len === undefined ? max : Number(len);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (len !== undefined && !/^\d+$/.test(len))) {
    throw badRequest(`"${input}": the prefix length must be 0-${max}`);
  }
  return { address, prefix, family: family as 4 | 6, text: `${address}/${prefix}` };
}

/** Whether `ip` is inside one of the CIDR blocks. An unknown address is never allowed. */
export function ipAllowed(ip: string | undefined, cidrs: string[]): boolean {
  if (!ip) return false;
  const addr = normalizeIp(ip);
  const family = isIP(addr);
  if (!family) return false;
  const list = new BlockList();
  for (const c of cidrs) {
    const p = parseCidr(c);
    list.addSubnet(p.address, p.prefix, p.family === 4 ? 'ipv4' : 'ipv6');
  }
  return list.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

// ---- validation -----------------------------------------------------------------

function optionalCount(name: string, v: unknown, max: number): number | null | undefined {
  if (v === undefined || v === null) return v as null | undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw badRequest(`${name} must be an integer from 0 to ${max}, or null`);
  return v;
}

/** Check KeyOptions; returns the normalised patch fields. */
export function validateKeyOptions(o: KeyOptions, now: number): Omit<ApiKeyPatch, 'name' | 'secret' | 'prev' | 'rotatedAt' | 'revokedAt'> {
  const out: ReturnType<typeof validateKeyOptions> = {};
  if (o.expiresAt !== undefined) {
    if (o.expiresAt === null) out.expiresAt = null;
    else {
      const t = typeof o.expiresAt === 'string' ? Date.parse(o.expiresAt) : NaN;
      if (!Number.isFinite(t)) throw badRequest('expiresAt must be an ISO-8601 time, e.g. "2027-01-31T00:00:00Z", or null');
      if (t <= now) throw badRequest('expiresAt must be in the future');
      out.expiresAt = new Date(t).toISOString();
    }
  }
  const rl = optionalCount('rateLimitPerMinute', o.rateLimitPerMinute, 1_000_000);
  if (rl !== undefined) out.rateLimitPerMinute = rl;
  const d = optionalCount('rendersPerDay', o.rendersPerDay, 1_000_000);
  if (d !== undefined) out.rendersPerDay = d;
  const m = optionalCount('rendersPerMonth', o.rendersPerMonth, 10_000_000);
  if (m !== undefined) out.rendersPerMonth = m;
  if (o.maxPriority !== undefined) {
    if (o.maxPriority !== null && !isPriority(o.maxPriority)) throw badRequest(`maxPriority must be one of ${PRIORITIES.join(', ')}, or null`);
    out.maxPriority = o.maxPriority;
  }
  if (o.ipAllowlist !== undefined) {
    if (o.ipAllowlist === null || (Array.isArray(o.ipAllowlist) && o.ipAllowlist.length === 0)) out.ipAllowlist = null;
    else {
      if (!Array.isArray(o.ipAllowlist) || o.ipAllowlist.length > MAX_ALLOWLIST || o.ipAllowlist.some((c) => typeof c !== 'string')) {
        throw badRequest(`ipAllowlist must be a list of up to ${MAX_ALLOWLIST} CIDR blocks, or null`);
      }
      out.ipAllowlist = [...new Set(o.ipAllowlist.map((c) => parseCidr(c).text))];
    }
  }
  return out;
}

/** Days are UTC days, months calendar months in UTC. */
export function quotaWindows(now: number): { dayStart: string; dayEnd: string; monthStart: string; monthEnd: string } {
  const d = new Date(now);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  return {
    dayStart: new Date(Date.UTC(y, m, day)).toISOString(),
    dayEnd: new Date(Date.UTC(y, m, day + 1)).toISOString(),
    monthStart: new Date(Date.UTC(y, m, 1)).toISOString(),
    monthEnd: new Date(Date.UTC(y, m + 1, 1)).toISOString(),
  };
}

/**
 * API keys, stored as salted SHA-256 hashes (ApiKeyRepository). Keys are
 * 256-bit random values, so a fast salted hash is enough (no password
 * stretching needed); comparison is constant-time. Every check reads the
 * database, so keys created, rotated or revoked by the CLI (another process)
 * take effect at once.
 *
 * Lifecycle (D-056): optional expiry, rotation (a new secret; the previous one
 * keeps working for keys.rotationGraceHours), revocation (the row stays, so
 * the audit trail can still name the key), per-key rate limit, render quotas
 * and IP allowlist. Every change is audit-logged without the secret.
 */
export class KeyStore {
  private lastUsedWrites = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly repo: ApiKeyRepository,
    private readonly opts: KeyStoreOptions = {}
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** The public view of a stored key. */
  toPublic(k: ApiKeyRecord): PublicKey {
    const { salt: _s, hash: _h, prev, ...pub } = k;
    const now = this.now();
    const status: KeyStatus = k.revokedAt ? 'revoked' : k.expiresAt && Date.parse(k.expiresAt) <= now ? 'expired' : 'active';
    return { ...pub, status, ...(prev && status === 'active' && Date.parse(prev.expiresAt) > now ? { previousSecretExpiresAt: prev.expiresAt } : {}) };
  }

  async list(): Promise<PublicKey[]> {
    return (await this.repo.list()).map((k) => this.toPublic(k));
  }

  async get(id: string): Promise<PublicKey> {
    const k = await this.repo.get(id);
    if (!k) throw notFound('key', id);
    return this.toPublic(k);
  }

  async count(): Promise<number> {
    return this.repo.count();
  }

  private async audit(actor: KeyActor | undefined, action: string, targetId: string, data?: Record<string, unknown>) {
    if (!this.opts.audit) return;
    await this.opts.audit({
      actorType: actor?.actorType ?? 'system',
      ...(actor?.actorId ? { actorId: actor.actorId } : {}),
      action,
      targetType: 'key',
      targetId,
      ...(data ? { data } : {}),
    });
  }

  /** Create a key. The plain key is returned once and never stored. */
  async create(name: string, scopes: Scope[], opts: KeyOptions & { plainKey?: string } = {}, actor?: KeyActor): Promise<{ key: string; record: PublicKey }> {
    if (typeof name !== 'string' || !name || name.length > 80) throw new ApiError('bad_request', 400, 'name must be 1-80 characters');
    const bad = (Array.isArray(scopes) ? scopes : []).filter((s) => !SCOPES.includes(s));
    if (!Array.isArray(scopes) || bad.length || scopes.length === 0) {
      throw new ApiError('bad_request', 400, `scopes must be a non-empty subset of ${SCOPES.join(', ')}`);
    }
    const { plainKey, ...options } = opts;
    const fields = validateKeyOptions(options, this.now());
    const key = plainKey ?? generateKey();
    if (!KEY_FORMAT.test(key)) throw new ApiError('bad_request', 400, 'keys must look like rf_<at least 20 url-safe characters>');
    const record: ApiKeyRecord = {
      id: newId('key'),
      name,
      scopes: [...new Set(scopes)],
      ...secretFor(key),
      createdAt: new Date(this.now()).toISOString(),
    };
    for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined) (record as unknown as Record<string, unknown>)[k] = v;
    await this.repo.insert(record);
    await this.audit(actor, 'key.create', record.id, { name, scopes: record.scopes, ...fields });
    return { key, record: this.toPublic(record) };
  }

  /** Change a key's name, expiry, limits, quotas or IP allowlist. */
  async update(id: string, patch: KeyOptions & { name?: string }, actor?: KeyActor): Promise<PublicKey> {
    const current = await this.repo.get(id);
    if (!current) throw notFound('key', id);
    const { name, ...options } = patch;
    if (name !== undefined && (typeof name !== 'string' || !name || name.length > 80)) throw badRequest('name must be 1-80 characters');
    const fields = validateKeyOptions(options, this.now());
    const change: ApiKeyPatch = { ...fields, ...(name !== undefined ? { name } : {}) };
    if (Object.keys(change).length === 0) throw badRequest('nothing to change: send name, expiresAt, rateLimitPerMinute, rendersPerDay, rendersPerMonth, ipAllowlist or maxPriority');
    const updated = await this.repo.update(id, change);
    if (!updated) throw notFound('key', id);
    await this.audit(actor, 'key.update', id, { changed: change });
    return this.toPublic(updated);
  }

  /**
   * Rotate: a new secret, returned once. The previous secret keeps working for
   * `graceHours` (default keys.rotationGraceHours; 0 ends it at once). Rotating
   * again inside the window ends the older secret.
   */
  async rotate(id: string, opts: { graceHours?: number } = {}, actor?: KeyActor): Promise<{ key: string; record: PublicKey }> {
    const current = await this.repo.get(id);
    if (!current) throw notFound('key', id);
    if (current.revokedAt) throw new ApiError('key_revoked', 409, `key ${id} is revoked; create a new key instead`);
    const graceHours = opts.graceHours ?? this.opts.rotationGraceHours?.() ?? 24;
    if (typeof graceHours !== 'number' || !Number.isFinite(graceHours) || graceHours < 0 || graceHours > MAX_ROTATION_GRACE_HOURS) {
      throw badRequest(`graceHours must be a number from 0 to ${MAX_ROTATION_GRACE_HOURS}`);
    }
    const now = this.now();
    const key = generateKey();
    const prevExpiresAt = new Date(now + graceHours * 3_600_000).toISOString();
    const updated = await this.repo.update(id, {
      secret: secretFor(key),
      prev: graceHours > 0 ? { prefix: current.prefix, salt: current.salt, hash: current.hash, expiresAt: prevExpiresAt } : null,
      rotatedAt: new Date(now).toISOString(),
    });
    if (!updated) throw notFound('key', id);
    await this.audit(actor, 'key.rotate', id, { graceHours, graceUntil: graceHours > 0 ? prevExpiresAt : null });
    return { key, record: this.toPublic(updated) };
  }

  /** Revoke: the key (and any previous secret) stops working at once; the row stays for the audit trail. */
  async revoke(id: string, actor?: KeyActor): Promise<PublicKey> {
    const current = await this.repo.get(id);
    if (!current) throw notFound('key', id);
    if (current.revokedAt) return this.toPublic(current);
    const updated = await this.repo.update(id, { revokedAt: new Date(this.now()).toISOString(), prev: null });
    if (!updated) throw notFound('key', id);
    await this.audit(actor, 'key.revoke', id, { name: current.name });
    return this.toPublic(updated);
  }

  async delete(id: string, actor?: KeyActor): Promise<void> {
    const current = await this.repo.get(id);
    if (!current || !(await this.repo.delete(id))) throw notFound('key', id);
    await this.audit(actor, 'key.delete', id, { name: current.name });
  }

  /** Check a presented key. Returns null if it is unknown, expired, revoked or not allowed from `ip`. */
  async verify(presented: string, ip?: string): Promise<AuthContext | null> {
    const r = await this.authenticate(presented, { ip });
    return r.ok ? r.auth : null;
  }

  /** Check a presented key and say why it is refused. A key with an IP allowlist needs `ip`. */
  async authenticate(presented: string, ctx: { ip?: string } = {}): Promise<AuthResult> {
    const unknown: AuthFailure = { ok: false, reason: 'unknown', message: 'missing or invalid API key: send "Authorization: Bearer rf_..."' };
    if (!KEY_FORMAT.test(presented)) return unknown;
    const now = this.now();
    for (const k of await this.repo.findByPrefix(presented.slice(0, PREFIX_LENGTH))) {
      const current = matches(k, presented);
      const previous = !current && !!k.prev && matches(k.prev, presented);
      if (!current && !previous) continue;
      const key = { id: k.id, name: k.name };
      if (k.revokedAt) return { ok: false, reason: 'revoked', key, message: `this API key was revoked at ${k.revokedAt}` };
      if (k.expiresAt && Date.parse(k.expiresAt) <= now) return { ok: false, reason: 'expired', key, message: `this API key expired at ${k.expiresAt}` };
      if (previous && Date.parse(k.prev!.expiresAt) <= now) {
        // The rotation grace window is over: the old secret is just an unknown key now.
        return { ...unknown, key };
      }
      if (k.ipAllowlist?.length && !ipAllowed(ctx.ip, k.ipAllowlist)) {
        return { ok: false, reason: 'ip_not_allowed', key, message: `this API key may not be used from ${ctx.ip ?? 'an unknown address'}` };
      }
      this.touch(k);
      return {
        ok: true,
        auth: {
          keyId: k.id,
          name: k.name,
          scopes: k.scopes,
          ...(k.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: k.rateLimitPerMinute } : {}),
          ...(k.rendersPerDay !== undefined ? { rendersPerDay: k.rendersPerDay } : {}),
          ...(k.rendersPerMonth !== undefined ? { rendersPerMonth: k.rendersPerMonth } : {}),
          ...(k.maxPriority !== undefined ? { maxPriority: k.maxPriority } : {}),
          ...(previous ? { previousSecret: true } : {}),
        },
      };
    }
    return unknown;
  }

  /** Record lastUsedAt at most once a minute per key. */
  private touch(k: ApiKeyRecord) {
    const now = this.now();
    if (now - (this.lastUsedWrites.get(k.id) ?? 0) < 60_000) return;
    this.lastUsedWrites.set(k.id, now);
    void this.repo.touch(k.id, new Date(now).toISOString()).catch(() => undefined);
  }

  /**
   * Bootstrap: when no key exists and REELFORGE_BOOTSTRAP_KEY is set, store it
   * as an admin key named "bootstrap". Does nothing once any key exists.
   */
  async bootstrap(plainKey: string | undefined): Promise<boolean> {
    if (!plainKey) return false;
    const weak = weakKeyReason(plainKey);
    if (weak) throw new ApiError('bad_request', 400, `REELFORGE_BOOTSTRAP_KEY ${weak}`);
    if ((await this.count()) > 0) return false;
    await this.create('bootstrap', ['admin'], { plainKey }, { actorType: 'system' });
    return true;
  }
}
