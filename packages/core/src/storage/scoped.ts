import type { StorageDriver } from '../plugins';

/**
 * A view of a driver with every key under `prefix` (a workspace's files, #304). Keys passed in and keys listed out
 * are relative to the prefix, so the code using it never sees, and cannot name, another workspace's objects.
 * An empty prefix returns the driver itself (the default workspace keeps the layout of earlier versions).
 */
export function scopeDriver(driver: StorageDriver, prefix: string): StorageDriver {
  if (!prefix) return driver;
  const k = (key: string) => prefix + key;
  return {
    get id() {
      return driver.id;
    },
    describe: () => driver.describe(),
    put: (key, data, opts) => driver.put(k(key), data, opts),
    putFile: (key, file, opts) => driver.putFile(k(key), file, opts),
    get: (key, range) => driver.get(k(key), range),
    stat: (key) => driver.stat(k(key)),
    list: async (p) => (await driver.list(k(p))).map((o) => ({ ...o, key: o.key.slice(prefix.length) })),
    copy: (from, to) => driver.copy(k(from), k(to)),
    delete: (key) => driver.delete(k(key)),
    signedUrl: (key, ttl, opts) => driver.signedUrl(k(key), ttl, opts),
    localPath: (key) => driver.localPath(k(key)),
    health: () => driver.health(),
  };
}
