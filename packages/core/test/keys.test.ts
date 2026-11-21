import { describe, expect, it } from 'vitest';
import { KeyStore, createMemoryRepositories, generateKey, hasScope } from '../src/index';

describe('KeyStore', () => {
  const repo = createMemoryRepositories().keys;
  const keys = new KeyStore(repo);

  it('generates rf_ keys with 256 bits of randomness', () => {
    const k = generateKey();
    expect(k).toMatch(/^rf_[A-Za-z0-9_-]{43}$/);
    expect(generateKey()).not.toBe(k);
  });

  it('stores only salted hashes and verifies keys', async () => {
    const { key, record } = await keys.create('agent', ['read', 'render']);
    expect(record.scopes).toEqual(['read', 'render']);
    const stored = JSON.stringify(await repo.list());
    expect(stored).not.toContain(key);
    expect(stored).toContain('"hash"');
    const auth = await keys.verify(key);
    expect(auth?.name).toBe('agent');
    expect(hasScope(auth!, 'read')).toBe(true);
    expect(hasScope(auth!, 'write')).toBe(false);
    expect(await keys.verify(key + 'x')).toBeNull();
    expect(await keys.verify('not-a-key')).toBeNull();
    expect(JSON.stringify(await keys.list())).not.toContain('hash');
  });

  it('admin implies every scope', async () => {
    const { key } = await keys.create('ops', ['admin']);
    const auth = (await keys.verify(key))!;
    for (const s of ['read', 'write', 'render', 'admin'] as const) expect(hasScope(auth, s)).toBe(true);
  });

  it('rejects bad scopes and names', async () => {
    await expect(keys.create('x', [] as never)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(keys.create('x', ['root' as never])).rejects.toMatchObject({ code: 'bad_request' });
    await expect(keys.create('', ['read'])).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('sees keys created by another instance (the CLI) without a restart', async () => {
    const other = new KeyStore(repo);
    await keys.list(); // warm this instance's cache
    const { key } = await other.create('from-cli', ['read']);
    expect((await keys.verify(key))?.name).toBe('from-cli');
  });

  it('deletes keys so they stop working', async () => {
    const { key, record } = await keys.create('temp', ['read']);
    await keys.delete(record.id);
    expect(await keys.verify(key)).toBeNull();
  });

  it('bootstraps an admin key only when no key exists', async () => {
    const freshRepo = createMemoryRepositories().keys;
    {
      const store = new KeyStore(freshRepo);
      const boot = 'rf_bootstrap_key_for_tests_0123456789';
      expect(await store.bootstrap(boot)).toBe(true);
      expect((await store.verify(boot))?.scopes).toEqual(['admin']);
      expect(await store.bootstrap('rf_another_bootstrap_key_0123456789')).toBe(false);
      expect(await store.bootstrap(undefined)).toBe(false);
      // A fresh instance reads the same repository.
      expect((await new KeyStore(freshRepo).verify(boot))?.name).toBe('bootstrap');
    }
  });
});
