import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@reelforge/project-schema';
import { ApiError, ProjectStore, applyMergePatch, KeyedMutex } from '../src/index';
import { tempDir } from './helpers';

const { dir, cleanup } = tempDir();
afterAll(cleanup);

const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
function manifest(id = 'sample-reel'): Project {
  const r = parseProject({ ...sample, projectId: id });
  if (!r.ok) throw new Error('sample invalid');
  return r.project;
}

describe('ProjectStore', () => {
  const store = new ProjectStore(dir);

  it('creates, reads and lists projects with version 1', async () => {
    const created = await store.create(manifest('one'));
    expect(created.meta.version).toBe(1);
    const got = await store.get('one');
    expect(got.manifest.title).toBe(sample.title);
    expect((await store.list()).map((m) => m.id)).toContain('one');
    expect(readdirSync(join(dir, 'projects/one'))).toEqual(expect.arrayContaining(['project.json', 'meta.json', 'versions', 'assets']));
  });

  it('refuses duplicates', async () => {
    await expect(store.create(manifest('one'))).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });

  it('keeps every version and enforces expectedVersion', async () => {
    const v2 = await store.update('one', (m) => ({ ...m, title: 'Second' }));
    expect(v2.meta.version).toBe(2);
    await expect(store.update('one', (m) => ({ ...m, title: 'Stale' }), 1)).rejects.toMatchObject({ code: 'version_conflict' });
    expect(await store.listVersions('one')).toEqual([1, 2]);
    expect((await store.getVersion('one', 1)).title).toBe(sample.title);
    expect((await store.getVersion('one', 2)).title).toBe('Second');
  });

  it('serialises concurrent updates (no lost writes)', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.update('one', (m) => ({ ...m, title: `${m.title}.${i}` })))
    );
    const { meta, manifest: m } = await store.get('one');
    expect(meta.version).toBe(12);
    expect(m.title.split('.').length).toBe(11);
  });

  it('refuses to change projectId and rejects unsafe ids', async () => {
    await expect(store.update('one', (m) => ({ ...m, projectId: 'two' }))).rejects.toBeInstanceOf(ApiError);
    expect(() => store.dir('../etc')).toThrow(ApiError);
    await expect(store.get('missing')).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('deletes', async () => {
    await store.delete('one');
    await expect(store.get('one')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('applyMergePatch (RFC 7396)', () => {
  it('merges objects, deletes with null, replaces arrays', () => {
    expect(applyMergePatch({ a: 1, b: { c: 2, d: 3 }, e: [1, 2] }, { b: { c: null, x: 1 }, e: [3], f: 'y' })).toEqual({
      a: 1,
      b: { d: 3, x: 1 },
      e: [3],
      f: 'y',
    });
    expect(applyMergePatch({ a: 1 }, 'x')).toBe('x');
  });
});

describe('KeyedMutex', () => {
  it('runs work for one key in order', async () => {
    const m = new KeyedMutex();
    const order: number[] = [];
    await Promise.all([3, 1, 2].map((d, i) => m.run('k', async () => {
      await new Promise((r) => setTimeout(r, d * 5));
      order.push(i);
    })));
    expect(order).toEqual([0, 1, 2]);
  });
});
