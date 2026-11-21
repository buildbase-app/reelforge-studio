import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';

/** Write a file atomically: write a temp file next to it, then rename over it. */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Serialises async work per key (e.g. writes to one project). */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** Sortable, URL-safe id: <prefix>_<base36 time><random hex>. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}

let seqTime = 0;
let seq = 0;
/**
 * Like newId, but strictly increasing within this process even inside one
 * millisecond (audit entries: "newest first" stays exact for entries written
 * in the same millisecond). Format: <prefix>_<base36 time, 9><base36 counter, 4><random hex, 6>.
 */
export function newSequentialId(prefix: string): string {
  const now = Date.now();
  if (now > seqTime) {
    seqTime = now;
    seq = 0;
  } else seq++;
  return `${prefix}_${seqTime.toString(36).padStart(9, '0')}${seq.toString(36).padStart(4, '0')}${randomBytes(3).toString('hex')}`;
}

/** Whether a build directory carries this source hash in its `.source-hash` stamp. */
export function stampMatches(dir: string, hash: string): boolean {
  const stamp = join(dir, '.source-hash');
  try {
    return existsSync(stamp) && readFileSync(stamp, 'utf8') === hash;
  } catch {
    return false;
  }
}

const publishing = new Map<string, Promise<string>>();

/**
 * Build a cache directory (an engine's browser bundle) without ever exposing
 * a half-built or emptied directory at `outDir`: `build` writes into a fresh
 * temporary directory next to it, which must end with the `.source-hash`
 * stamp, and that directory is renamed into place. Concurrent builds of the
 * same `outDir` in this process share one build; another process that
 * finished first wins and our copy is dropped. Renders that are serving
 * `outDir` therefore keep finding their files (before this, a second build
 * emptied the directory under a running render: 404s and a timeout).
 *
 * Guarantee: the published directory is never emptied or half-written, and a
 * build of sources that are already published never replaces it. Replacing it
 * with *different* sources (a source change in development, or `force`) is two
 * renames, so `outDir` is absent for that instant; production images ship the
 * bundles prebuilt with matching stamps and never take that path.
 */
export function publishDirAtomically(outDir: string, hash: string, build: (dir: string) => Promise<void>, opts: { force?: boolean } = {}): Promise<string> {
  const key = `${outDir}\0${hash}`;
  const running = publishing.get(key);
  if (running) return running;
  const p = (async () => {
    await mkdir(dirname(outDir), { recursive: true });
    const tag = `${process.pid}-${randomBytes(4).toString('hex')}`;
    const tmp = `${outDir}.tmp-${tag}`;
    try {
      await build(tmp);
      if (!stampMatches(tmp, hash)) throw new Error(`build of ${basename(outDir)} did not write its .source-hash stamp`);
      // Another process published the same sources meanwhile: use that one, leave it alone.
      if (!opts.force && stampMatches(outDir, hash)) return outDir;
      const old = `${outDir}.old-${tag}`;
      let moved = false;
      try {
        await rename(outDir, old);
        moved = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      try {
        await rename(tmp, outDir);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if ((code === 'ENOTEMPTY' || code === 'EEXIST') && stampMatches(outDir, hash)) return outDir;
        throw e;
      }
      if (moved) await rm(old, { recursive: true, force: true });
      return outDir;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  })().finally(() => publishing.delete(key));
  publishing.set(key, p);
  return p;
}
