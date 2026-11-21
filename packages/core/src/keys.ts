import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { ApiError, notFound } from './errors';
import { KeyedMutex, newId, readJson, writeJsonAtomic } from './fsutil';

export const SCOPES = ['read', 'write', 'render', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

export interface ApiKeyRecord {
  id: string;
  name: string;
  scopes: Scope[];
  /** First characters of the key, for recognising it in lists. Not secret on its own. */
  prefix: string;
  salt: string;
  /** sha256(salt + key), hex. The key itself is never stored. */
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
}

export type PublicKey = Omit<ApiKeyRecord, 'salt' | 'hash'>;

export interface AuthContext {
  keyId: string;
  name: string;
  scopes: Scope[];
}

const KEY_FORMAT = /^rf_[A-Za-z0-9_-]{20,128}$/;

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

/**
 * API keys in <dataDir>/keys.json, stored as salted SHA-256 hashes. Keys are
 * 256-bit random values, so a fast salted hash is enough (no password
 * stretching needed); comparison is constant-time.
 */
export class KeyStore {
  readonly file: string;
  private mutex = new KeyedMutex();
  private cache: ApiKeyRecord[] | null = null;
  private lastUsedWrites = new Map<string, number>();

  constructor(dataDir: string) {
    this.file = resolve(dataDir, 'keys.json');
  }

  private async load(): Promise<ApiKeyRecord[]> {
    if (!this.cache) this.cache = (await readJson<ApiKeyRecord[]>(this.file)) ?? [];
    return this.cache;
  }

  private async save(keys: ApiKeyRecord[]) {
    this.cache = keys;
    await writeJsonAtomic(this.file, keys);
  }

  async list(): Promise<PublicKey[]> {
    return (await this.load()).map(({ salt: _s, hash: _h, ...pub }) => pub);
  }

  async count(): Promise<number> {
    return (await this.load()).length;
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
    return this.mutex.run('keys', async () => {
      const keys = await this.load();
      const salt = randomBytes(16).toString('hex');
      const record: ApiKeyRecord = {
        id: newId('key'),
        name,
        scopes: [...new Set(scopes)],
        prefix: key.slice(0, 7),
        salt,
        hash: hashKey(salt, key),
        createdAt: new Date().toISOString(),
      };
      await this.save([...keys, record]);
      const { salt: _s, hash: _h, ...pub } = record;
      return { key, record: pub };
    });
  }

  async delete(id: string): Promise<void> {
    await this.mutex.run('keys', async () => {
      const keys = await this.load();
      if (!keys.some((k) => k.id === id)) throw notFound('key', id);
      await this.save(keys.filter((k) => k.id !== id));
    });
  }

  /** Check a presented key. Returns null if unknown. */
  async verify(presented: string): Promise<AuthContext | null> {
    if (!KEY_FORMAT.test(presented)) return null;
    const keys = await this.load();
    for (const k of keys) {
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
    k.lastUsedAt = new Date(now).toISOString();
    void this.mutex.run('keys', async () => this.save(await this.load())).catch(() => undefined);
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
