import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { publishDirAtomically, stampMatches } from '../src/fsutil';
import { tempDir } from './helpers';

const { dir, cleanup } = tempDir('reelforge-fsutil-');
afterAll(cleanup);

/** A fake bundle build: some files, then the stamp. */
const writeBundle = async (out: string, hash: string, content: string, delayMs = 0) => {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'runtime.js'), content);
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  writeFileSync(join(out, '.source-hash'), hash);
};

describe('publishDirAtomically (engine bundle cache)', () => {
  it('concurrent builds of one directory in a process share a single build', async () => {
    const out = join(dir, 'a', 'bundle');
    let builds = 0;
    const build = async (d: string) => {
      builds++;
      await writeBundle(d, 'h1', 'one', 50);
    };
    const [x, y] = await Promise.all([publishDirAtomically(out, 'h1', build), publishDirAtomically(out, 'h1', build)]);
    expect(x).toBe(out);
    expect(y).toBe(out);
    expect(builds).toBe(1);
    expect(stampMatches(out, 'h1')).toBe(true);
    expect(readdirSync(join(dir, 'a'))).toEqual(['bundle']); // no temporary directories left
  });

  it('a rebuild never empties the published directory while it runs (renders keep their files)', async () => {
    const out = join(dir, 'b', 'bundle');
    await publishDirAtomically(out, 'h1', (d) => writeBundle(d, 'h1', 'old'));
    // Poll only while the new build runs: that is the window in which the old code emptied
    // the directory (Vite emptyOutDir). The swap afterwards is two renames (see fsutil.ts).
    let missing = 0;
    let checks = 0;
    let building = true;
    const timer = setInterval(() => {
      if (!building) return;
      checks++;
      if (readFileSync(join(out, 'runtime.js'), 'utf8') !== 'old') missing++;
    }, 2);
    await publishDirAtomically(out, 'h2', async (d) => {
      await writeBundle(d, 'h2', 'new', 150);
      building = false;
    });
    clearInterval(timer);
    expect(checks).toBeGreaterThan(10);
    expect(missing).toBe(0);
    expect(readFileSync(join(out, 'runtime.js'), 'utf8')).toBe('new');
    expect(readdirSync(join(dir, 'b'))).toEqual(['bundle']);
  });

  it('a build of the sources already published never replaces the directory', async () => {
    const out = join(dir, 'c', 'bundle');
    await publishDirAtomically(out, 'h1', (d) => writeBundle(d, 'h1', 'first'));
    const before = statSync(out).ino;
    let missing = 0;
    const timer = setInterval(() => {
      if (!existsSync(join(out, 'runtime.js'))) missing++;
    }, 1);
    // A second process's build of the same sources, finishing after ours was published.
    await publishDirAtomically(out, 'h1', (d) => writeBundle(d, 'h1', 'second', 50));
    clearInterval(timer);
    expect(missing).toBe(0);
    expect(statSync(out).ino).toBe(before);
    expect(readFileSync(join(out, 'runtime.js'), 'utf8')).toBe('first');
    expect(readdirSync(join(dir, 'c'))).toEqual(['bundle']);
  });

  it('when another process published the same sources first, its directory is kept and ours dropped', async () => {
    const out = join(dir, 'c', 'bundle');
    const result = await publishDirAtomically(out, 'h1', async (d) => {
      await writeBundle(out, 'h1', 'theirs'); // the other process finished first
      await writeBundle(d, 'h1', 'ours');
    });
    expect(result).toBe(out);
    expect(readFileSync(join(out, 'runtime.js'), 'utf8')).toBe('theirs');
    expect(readdirSync(join(dir, 'c'))).toEqual(['bundle']);
  });

  it('a failed or unstamped build leaves the published directory as it was', async () => {
    const out = join(dir, 'd', 'bundle');
    await publishDirAtomically(out, 'h1', (d) => writeBundle(d, 'h1', 'good'));
    await expect(
      publishDirAtomically(out, 'h2', async (d) => {
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'runtime.js'), 'half');
        throw new Error('build broke');
      })
    ).rejects.toThrow('build broke');
    await expect(publishDirAtomically(out, 'h3', async (d) => void mkdirSync(d, { recursive: true }))).rejects.toThrow(/did not write its .source-hash stamp/);
    expect(readFileSync(join(out, 'runtime.js'), 'utf8')).toBe('good');
    expect(stampMatches(out, 'h1')).toBe(true);
    expect(readdirSync(join(dir, 'd'))).toEqual(['bundle']);
  });
});
