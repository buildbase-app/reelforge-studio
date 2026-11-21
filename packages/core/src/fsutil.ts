import { randomBytes } from 'node:crypto';
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
