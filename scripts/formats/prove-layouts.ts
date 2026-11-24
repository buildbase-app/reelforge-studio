/**
 * `pnpm formats:prove-layouts`: render every layout primitive (#287) on the
 * html and hyperframes engines at 16:9, 1:1, 9:16 and 4K, and write one
 * contact sheet per primitive (a row per engine, the settled frame of each
 * size, the content safe area outlined) plus report.json to
 * docs/proofs/layouts/. Needs REELFORGE_CHROMIUM_PATH and FFmpeg.
 *
 *   pnpm formats:prove-layouts [--out docs/proofs/layouts] [--only split] [--engine html]
 *
 * Clips go to a temporary directory; only the sheets and the report are kept.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkExpectation, probe, resolveTools } from '@reelforge/media-pipeline';
import { engines } from '../../apps/server/test/formats/matrix';
import { LAYOUT_ENGINES, LAYOUT_FORMATS, LAYOUT_SAMPLES, layoutSheet, layoutThumb, makeLayoutMedia, renderLayout } from '../../apps/server/test/formats/layouts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = resolve(import.meta.dirname, '../..');
const outDir = resolve(flag('--out') ?? join(root, 'docs/proofs/layouts'));
const only = flag('--only');
const onlyEngine = flag('--engine');
const cacheDir = join(root, '.render-cache');
const work = mkdtempSync(join(tmpdir(), 'reelforge-layouts-'));
mkdirSync(outDir, { recursive: true });

const plugins = engines();
const tools = resolveTools();
const results: Array<{ sample: string; engine: string; format: string; width: number; height: number; frames: number; renderMillis: number; problems: string[] }> = [];

try {
  const assets = await makeLayoutMedia(join(work, 'media'));
  for (const s of LAYOUT_SAMPLES.filter((x) => !only || x.id === only)) {
    const rows: string[][] = [];
    for (const e of LAYOUT_ENGINES.filter((x) => !onlyEngine || x.engine === onlyEngine)) {
      const row: string[] = [];
      for (const f of LAYOUT_FORMATS) {
        const started = Date.now();
        const r = await renderLayout(plugins[e.engine]!, e.template, s, f, assets, work, cacheDir);
        const renderMillis = Date.now() - started;
        const info = await probe(tools.ffprobe, r.file);
        const problems = checkExpectation(info, { width: f.width, height: f.height, fps: 30, frames: r.frames }).filter((p) => !p.startsWith('pixel format'));
        results.push({ sample: s.id, engine: e.engine, format: f.id, width: f.width, height: f.height, frames: r.frames, renderMillis, problems });
        console.log(`${problems.length ? 'FAIL' : 'ok  '} ${s.id.padEnd(12)} ${e.engine.padEnd(12)} ${f.id.padEnd(5)} ${(renderMillis / 1000).toFixed(1)}s${problems.length ? ': ' + problems.join('; ') : ''}`);
        const thumb = join(work, `${s.id}-${e.engine}-${f.id}.png`);
        await layoutThumb(r, s.settled, 360, thumb);
        row.push(thumb);
        rmSync(r.file, { force: true });
      }
      rows.push(row);
    }
    await layoutSheet(rows, join(outDir, `${s.id}.jpg`));
  }
  writeFileSync(
    join(outDir, 'report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), command: 'pnpm formats:prove-layouts', samples: LAYOUT_SAMPLES.map((s) => ({ id: s.id, title: s.title, props: s.props })), results }, null, 2) + '\n'
  );
  const failed = results.filter((r) => r.problems.length);
  console.log(`${results.length - failed.length}/${results.length} passed; sheets in ${outDir}`);
  if (failed.length) process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
