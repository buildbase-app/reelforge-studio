import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, constants, copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { writeFileAtomic } from '../fsutil';
import type { ByteRange, StorageDriver, StorageObject } from '../plugins';
import { checkKey, checkPrefix } from './keys';

/**
 * Files under one root directory (the data directory, D-065): the default
 * driver. Writes are atomic (temp file + rename); keys map to paths under the
 * root and can never escape it.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly id = 'local';
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  describe() {
    return { root: this.root, signedUrls: false };
  }

  localPath(key: string): string {
    checkKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error(`storage key escapes the root: "${key}"`);
    return p;
  }

  async put(key: string, data: Buffer): Promise<{ bytes: number }> {
    await writeFileAtomic(this.localPath(key), data);
    return { bytes: data.length };
  }

  async putFile(key: string, file: string): Promise<{ bytes: number }> {
    await this.copyAtomic(resolve(file), this.localPath(key));
    return { bytes: (await stat(file)).size };
  }

  async get(key: string, range?: ByteRange): Promise<Readable> {
    const p = this.localPath(key);
    if (!(await stat(p)).isFile()) throw new Error(`not a file: ${key}`);
    return createReadStream(p, range ? { start: range.start, end: range.end } : undefined);
  }

  async stat(key: string): Promise<{ bytes: number; modifiedAt: string } | null> {
    try {
      const s = await stat(this.localPath(key));
      return s.isFile() ? { bytes: s.size, modifiedAt: s.mtime.toISOString() } : null;
    } catch {
      return null;
    }
  }

  async list(prefix: string): Promise<StorageObject[]> {
    checkPrefix(prefix);
    const base = prefix ? this.localPath(prefix.slice(0, -1)) : this.root;
    const out: StorageObject[] = [];
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
        else if (e.isFile()) {
          const s = await stat(full).catch(() => null);
          if (s) out.push({ key: relative(this.root, full).split(sep).join('/'), bytes: s.size, modifiedAt: s.mtime.toISOString() });
        }
      }
    };
    await walk(base);
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async copy(from: string, to: string): Promise<void> {
    await this.copyAtomic(this.localPath(from), this.localPath(to));
  }

  async delete(key: string): Promise<void> {
    await rm(this.localPath(key), { force: true });
  }

  async signedUrl(): Promise<string | null> {
    return null;
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    try {
      await mkdir(this.root, { recursive: true });
      await access(this.root, constants.W_OK);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: `${this.root} is not writable: ${(e as Error).message}` };
    }
  }

  /** Create a directory for a key prefix (render staging) and return its path. */
  async ensureDir(key: string): Promise<string> {
    const p = this.localPath(key);
    await mkdir(p, { recursive: true });
    return p;
  }

  private async copyAtomic(src: string, dest: string) {
    await mkdir(dirname(dest), { recursive: true });
    const tmp = join(dirname(dest), `.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await copyFile(src, tmp);
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
}
