/**
 * `pnpm formats:prove-layouts`: render every layout primitive (#287) on the
 * html, hyperframes, remotion and motion-canvas engines at 16:9, 1:1, 9:16
 * and 4K, and write one
 * contact sheet per primitive (a row per engine, the settled frame of each
 * size, the content safe area outlined) plus report.json to
 * docs/proofs/layouts/. Needs REELFORGE_CHROMIUM_PATH and FFmpeg.
 *
 *   pnpm formats:prove-layouts [--out docs/proofs/layouts] [--only split] [--engine html] [--format 16x9]
 *
 * Clips go to a temporary directory; only the sheets and the report are kept.
 *
 *   pnpm formats:prove-layouts --geometry [--out docs/proofs/layouts]
 *
 * writes geometry.json instead: every sample (and the longest-text samples)
 * with flat pane colours on html, remotion and motion-canvas at each size, each
 * pane and the lower third found by colour on the rendered frame, and how far
 * each is from the geometry and from the html engine's (the same check as
 * apps/server/test/layouts-engines.test.ts).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkExpectation, probe, resolveTools } from '@renderweld/media-pipeline';
import { engines } from '../../apps/server/test/formats/matrix';
import { LAYOUT_ENGINES, LAYOUT_FORMATS, LAYOUT_SAMPLES, LAYOUT_STRESS_SAMPLES, checkGeometry, layoutSheet, layoutThumb, makeLayoutMedia, renderGeometryFrame, renderLayout } from '../../apps/server/test/formats/layouts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = resolve(import.meta.dirname, '../..');
const outDir = resolve(flag('--out') ?? join(root, 'docs/proofs/layouts'));
const only = flag('--only');
const onlyEngine = flag('--engine');
const onlyFormat = flag('--format');
const cacheDir = join(root, '.render-cache');
const work = mkdtempSync(join(tmpdir(), 'reelforge-layouts-'));
mkdirSync(outDir, { recursive: true });

const plugins = engines();
const tools = resolveTools();
const results: Array<{ sample: string; engine: string; format: string; width: number; height: number; frames: number; renderMillis: number; problems: string[] }> = [];

async function proveGeometry(): Promise<void> {
  const rows: Array<Record<string, unknown>> = [];
  let failed = 0;
  for (const f of LAYOUT_FORMATS.filter((x) => !onlyFormat || x.id === onlyFormat)) {
    for (const s of [...LAYOUT_SAMPLES, ...LAYOUT_STRESS_SAMPLES].filter((x) => !only || x.id === only)) {
      const html = await renderGeometryFrame('html', s, f, work, cacheDir);
      for (const engine of ['html', 'remotion', 'motion-canvas'] as const) {
        const rgb = engine === 'html' ? html : await renderGeometryFrame(engine, s, f, work, cacheDir);
        const c = checkGeometry(s, f, engine, rgb, engine === 'html' ? null : html);
        const r1 = (n: number) => Math.round(n * 10) / 10;
        const row = {
          sample: s.id,
          format: f.id,
          engine,
          unitPx: r1(c.unit),
          panes: c.panes.map((p) => ({ index: p.index, found: p.found && { x: p.found.x, y: p.found.y, width: p.found.width, height: p.found.height }, pxFromGeometry: p.vsGeometry, pxFromHtml: p.vsHtml })),
          lowerThird: c.lowerThird && { found: c.lowerThird.found && { x: c.lowerThird.found.x, y: c.lowerThird.found.y, width: c.lowerThird.found.width, height: c.lowerThird.found.height }, pxFromHtml: c.lowerThird.vsHtml },
          maxPxFromHtml: Math.max(0, ...c.panes.map((p) => p.vsHtml), c.lowerThird?.vsHtml ?? 0),
          textPixelsOutsideTextBoxes: c.ink.reduce((a, k) => a + k.stray, 0),
          problems: c.problems,
        };
        rows.push(row);
        if (c.problems.length) failed++;
        console.log(`${c.problems.length ? 'FAIL' : 'ok  '} ${s.id.padEnd(18)} ${engine.padEnd(13)} ${f.id.padEnd(5)} max ${row.maxPxFromHtml}px from html (1 unit = ${row.unitPx}px)${c.problems.length ? ': ' + c.problems.join('; ') : ''}`);
      }
    }
  }
  writeFileSync(join(outDir, 'geometry.json'), JSON.stringify({ generatedAt: new Date().toISOString(), command: 'pnpm formats:prove-layouts --geometry', frame: 'frame 30 of a 1.5 s scene at 30 fps', rows }, null, 2) + '\n');
  console.log(`${rows.length - failed}/${rows.length} passed; ${join(outDir, 'geometry.json')}`);
  if (failed) process.exitCode = 1;
}

try {
  if (args.includes('--geometry')) {
    await proveGeometry();
  } else {
    const assets = await makeLayoutMedia(join(work, 'media'));
    for (const s of LAYOUT_SAMPLES.filter((x) => !only || x.id === only)) {
      const rows: string[][] = [];
      for (const e of LAYOUT_ENGINES.filter((x) => !onlyEngine || x.engine === onlyEngine)) {
        const row: string[] = [];
        for (const f of LAYOUT_FORMATS.filter((x) => !onlyFormat || x.id === onlyFormat)) {
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
  }
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
