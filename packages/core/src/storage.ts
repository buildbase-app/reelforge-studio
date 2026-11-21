import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { isSafeRelativePath } from '@reelforge/project-schema';
import { writeFileAtomic } from './fsutil';
import type { StorageDriver } from './plugins';

/** Files under one root directory. Keys are safe relative paths. */
export class LocalStorageDriver implements StorageDriver {
  readonly id = 'local';
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  localPath(key: string): string {
    if (!isSafeRelativePath(key)) throw new Error(`unsafe storage key "${key}"`);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error(`storage key escapes the root: "${key}"`);
    return p;
  }

  async put(key: string, data: Buffer): Promise<{ bytes: number }> {
    await writeFileAtomic(this.localPath(key), data);
    return { bytes: data.length };
  }

  async get(key: string): Promise<Readable> {
    const p = this.localPath(key);
    await stat(p);
    return createReadStream(p);
  }

  async stat(key: string): Promise<{ bytes: number } | null> {
    try {
      const s = await stat(this.localPath(key));
      return s.isFile() ? { bytes: s.size } : null;
    } catch {
      return null;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const base = prefix ? this.localPath(prefix) : this.root;
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(relative(this.root, full).split(sep).join('/'));
      }
    };
    await walk(base);
    return out.sort();
  }

  async delete(key: string): Promise<void> {
    await rm(this.localPath(key), { recursive: true, force: true });
  }

  async signedUrl(): Promise<string | null> {
    return null;
  }

  async ensureDir(key: string): Promise<string> {
    const p = this.localPath(key);
    await mkdir(p, { recursive: true });
    return p;
  }
}
