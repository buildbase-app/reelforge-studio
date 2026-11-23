import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '@reelforge/media-pipeline';
import { TEMPLATES, type RenderScene } from '@reelforge/project-schema';
import { checkKey, type EnginePlugin, type EngineRenderContext, type ClipResult } from '../src/index';

export function tempDir(prefix = 'reelforge-core-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The fake frame-range engine's luma at frame n of a scene: every frame differs from its neighbours. */
export const fakeFrameLuma = (n: number) => 16 + (n % 40) * 5;

/**
 * A fake engine for fast tests: FFmpeg's colour source in the theme's
 * background colour (no browser). Uses the real template catalog so manifest
 * validation behaves as in production. `frameRanges`: it declares frame
 * ranges and draws frame n of a scene as a flat picture of luma
 * fakeFrameLuma(n), so a chunked render can be checked frame by frame.
 */
export function fakeEngine(
  id: string,
  opts: { delayPerFrameMs?: number; fail?: boolean; frameRanges?: boolean } = {}
): EnginePlugin & { renders: RenderScene[]; ranges: Array<readonly [number, number] | null> } {
  const renders: RenderScene[] = [];
  const ranges: Array<readonly [number, number] | null> = [];
  return {
    id,
    displayName: `fake ${id}`,
    acceptsSource: id === 'html' || id === 'hyperframes',
    renders,
    ranges,
    ...(opts.frameRanges ? { capabilities: () => ({ frameRanges: true }) } : {}),
    version: () => '0.0.0-test',
    availability: () => ({ ok: true }),
    templates: () =>
      Object.entries(TEMPLATES)
        .filter(([, t]) => t.engine === id)
        .map(([tid, t]) => ({ ...t, id: tid })),
    async render(scene: RenderScene, ctx: EngineRenderContext): Promise<ClipResult> {
      renders.push(scene);
      ranges.push(ctx.frameRange ?? null);
      const started = Date.now();
      if (opts.fail) throw new Error('fake engine failure');
      if (ctx.frameRange && !opts.frameRanges) throw new Error('fake engine without frame ranges was given one');
      const [first, last] = ctx.frameRange ?? [0, scene.durationFrames - 1];
      const frames = last - first + 1;
      for (let f = 1; f <= frames; f++) {
        if (ctx.signal.aborted) throw new Error('cancelled');
        if (opts.delayPerFrameMs) await new Promise((r) => setTimeout(r, opts.delayPerFrameMs));
        if (f % 10 === 0 || f === frames) ctx.progress(f, frames);
      }
      const size = `size=${ctx.output.width}x${ctx.output.height}:rate=${ctx.output.fps}`;
      const source = opts.frameRanges
        ? `nullsrc=${size},format=yuv420p,geq=lum='16+mod(N+${first}\\,40)*5':cb=128:cr=128`
        : `color=c=${ctx.theme.colors.background.replace('#', '0x')}:${size}`;
      await run(
        ctx.tools.ffmpeg,
        ['-hide_banner', '-y', '-f', 'lavfi', '-i', source, '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ctx.out],
        'fake-render',
        { signal: ctx.signal }
      );
      return { file: ctx.out, frames, engineVersion: '0.0.0-test', millis: Date.now() - started };
    },
  };
}

export async function makeTone(file: string, seconds: number) {
  const { resolveTools } = await import('@reelforge/media-pipeline');
  await run(resolveTools().ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'libmp3lame', file], 'fixture');
}

/**
 * An in-memory "remote" storage driver for fast tests of the remote code paths
 * (no local paths, signed URLs). `failOn` makes chosen operations throw.
 */
export function memoryStorage(opts: { sign?: boolean; failOn?: (op: string, key: string) => boolean } = {}) {
  const objects = new Map<string, { data: Buffer; modifiedAt: string }>();
  const fail = (op: string, key: string) => {
    if (opts.failOn?.(op, key)) throw new Error(`injected ${op} failure for ${key}`);
  };
  const driver = {
    id: 'memory',
    objects,
    describe: () => ({ kind: 'memory' }),
    async put(key: string, data: Buffer) {
      checkKey(key);
      fail('put', key);
      objects.set(key, { data: Buffer.from(data), modifiedAt: new Date().toISOString() });
      return { bytes: data.length };
    },
    async putFile(key: string, file: string) {
      const { readFile } = await import('node:fs/promises');
      return driver.put(key, await readFile(file));
    },
    async get(key: string, range?: { start: number; end: number }) {
      fail('get', key);
      const o = objects.get(checkKey(key));
      if (!o) throw Object.assign(new Error(`no such key ${key}`), { code: 404 });
      const { Readable } = await import('node:stream');
      return Readable.from([range ? o.data.subarray(range.start, range.end + 1) : o.data]);
    },
    async stat(key: string) {
      const o = objects.get(checkKey(key));
      return o ? { bytes: o.data.length, modifiedAt: o.modifiedAt } : null;
    },
    async list(prefix: string) {
      return [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, o]) => ({ key, bytes: o.data.length, modifiedAt: o.modifiedAt }))
        .sort((a, b) => (a.key < b.key ? -1 : 1));
    },
    async copy(from: string, to: string) {
      fail('copy', to);
      const o = objects.get(checkKey(from));
      if (!o) throw new Error(`no such key ${from}`);
      objects.set(checkKey(to), { data: o.data, modifiedAt: new Date().toISOString() });
    },
    async delete(key: string) {
      fail('delete', key);
      objects.delete(checkKey(key));
    },
    async signedUrl(key: string, ttl: number) {
      return opts.sign === false ? null : `https://bucket.example/${key}?sig=test&ttl=${ttl}`;
    },
    localPath: () => null,
    health: async () => ({ ok: true }),
    /** Set an object's modification time (retention tests). */
    age(key: string, iso: string) {
      const o = objects.get(key);
      if (o) o.modifiedAt = iso;
    },
  };
  return driver;
}
