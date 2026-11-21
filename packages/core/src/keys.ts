import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError, notFound } from './errors';
import { newId } from './fsutil';
import { SCOPES, type ApiKeyRecord, type ApiKeyRepository, type Scope } from './repositories';

export { SCOPES, type ApiKeyRecord, type Scope } from './repositories';

export type PublicKey = Omit<ApiKeyRecord, 'salt' | 'hash'>;

export interface AuthContext {
  keyId: string;
  name: string;
  scopes: Scope[];
}

const KEY_FORMAT = /^rf_[A-Za-z0-9_-]{20,128}$/;
/** Characters of the key stored in clear as `prefix` (lookup index). */
const PREFIX_LENGTH = 7;

function hashKey(salt: string, key: string): string {
  return createHash('sha256').update(salt).update(key).digest('hex');
}

/** A new key: "rf_" + 32 random bytes, base64url. */
export function generateKey(): string {
  return `rf_${randomBytes(32).toString('base64url')}`;
}

export function hasScope(auth: AuthContext, scope: Scope): boolean {
  return auth.scopes.includes('admin') || auth.scopes.includes(scope);
}

const toPublic = ({ salt: _s, hash: _h, ...pub }: ApiKeyRecord): PublicKey => pub;

/**
 * API keys, stored as salted SHA-256 hashes (ApiKeyRepository). Keys are
 * 256-bit random values, so a fast salted hash is enough (no password
 * stretching needed); comparison is constant-time. Every check reads the
 * database, so keys created or revoked by the CLI (another process) take
 * effect at once.
 */
export class KeyStore {
  private lastUsedWrites = new Map<string, number>();

  constructor(private readonly repo: ApiKeyRepository) {}

  async list(): Promise<PublicKey[]> {
    return (await this.repo.list()).map(toPublic);
  }

  async count(): Promise<number> {
    return this.repo.count();
  }

  /** Create a key. The plain key is returned once and never stored. */
  async create(name: string, scopes: Scope[], plainKey?: string): Promise<{ key: string; record: PublicKey }> {
    if (!name || name.length > 80) throw new ApiError('bad_request', 400, 'name must be 1-80 characters');
    const bad = scopes.filter((s) => !SCOPES.includes(s));
    if (bad.length || scopes.length === 0) {
      throw new ApiError('bad_request', 400, `scopes must be a non-empty subset of ${SCOPES.join(', ')}`);
    }
    const key = plainKey ?? generateKey();
    if (!KEY_FORMAT.test(key)) throw new ApiError('bad_request', 400, 'keys must look like rf_<at least 20 url-safe characters>');
    const salt = randomBytes(16).toString('hex');
    const record: ApiKeyRecord = {
      id: newId('key'),
      name,
      scopes: [...new Set(scopes)],
      prefix: key.slice(0, PREFIX_LENGTH),
      salt,
      hash: hashKey(salt, key),
      createdAt: new Date().toISOString(),
    };
    await this.repo.insert(record);
    return { key, record: toPublic(record) };
  }

  async delete(id: string): Promise<void> {
    if (!(await this.repo.delete(id))) throw notFound('key', id);
  }

  /** Check a presented key. Returns null if unknown. */
  async verify(presented: string): Promise<AuthContext | null> {
    if (!KEY_FORMAT.test(presented)) return null;
    for (const k of await this.repo.findByPrefix(presented.slice(0, PREFIX_LENGTH))) {
      const a = Buffer.from(hashKey(k.salt, presented), 'hex');
      const b = Buffer.from(k.hash, 'hex');
      if (a.length === b.length && timingSafeEqual(a, b)) {
        this.touch(k);
        return { keyId: k.id, name: k.name, scopes: k.scopes };
      }
    }
    return null;
  }

  /** Record lastUsedAt at most once a minute per key. */
  private touch(k: ApiKeyRecord) {
    const now = Date.now();
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
    if ((await this.count()) > 0) return false;
    await this.create('bootstrap', ['admin'], plainKey);
    return true;
  }
}
