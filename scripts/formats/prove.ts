/**
 * `pnpm formats:prove`: render every built-in template on its engine at real
 * sizes (16:9, 1:1, 4:5, 9:16 and a 4K smoke render), run the overflow check
 * on each clip and write one contact sheet per format plus report.json to
 * docs/proofs/formats/ (#287). Needs REELFORGE_CHROMIUM_PATH and FFmpeg.
 *
 *   pnpm formats:prove [--out docs/proofs/formats] [--only html-title]
 *
 * Clips go to a temporary directory; only the sheets and the report are kept.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FORMATS, FORMAT_4K, SAMPLES, checkOverflow, contactRow, engines, renderSample, stackRows, type OverflowReport } from '../../apps/server/test/formats/matrix';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = resolve(import.meta.dirname, '../..');
const outDir = resolve(flag('--out') ?? join(root, 'docs/proofs/formats'));
const only = flag('--only');
const cacheDir = join(root, '.render-cache');
const work = mkdtempSync(join(tmpdir(), 'reelforge-formats-'));
mkdirSync(outDir, { recursive: true });

const plugins = engines();
const samples = SAMPLES.filter((s) => !only || s.template === only);
const results: Array<{ format: string; width: number; height: number; template: string; engine: string; seconds: number; renderMillis: number } & OverflowReport> = [];

try {
  for (const f of [...FORMATS, FORMAT_4K]) {
    const rows: string[] = [];
    for (const s of samples) {
      const started = Date.now();
      // The 4K run is a smoke render: a short clip proves the size works end to end.
      const sample = f === FORMAT_4K ? { ...s, seconds: Math.max(2, s.seconds / 2) } : s;
      const r = await renderSample(plugins[s.engine]!, sample, f, work, cacheDir);
      const renderMillis = Date.now() - started;
      const check = await checkOverflow(r, sample);
      results.push({ format: f.id, width: f.width, height: f.height, template: s.template, engine: s.engine, seconds: sample.seconds, renderMillis, ...check });
      console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${f.id.padEnd(5)} ${s.engine}/${s.template} ${(renderMillis / 1000).toFixed(1)}s${check.problems.length ? ': ' + check.problems.join('; ') : ''}`);
      const row = join(work, `${f.id}-${s.template}.png`);
      await contactRow(r, sample, f.width > f.height ? 384 : f.width === f.height ? 288 : 216, row);
      rows.push(row);
      rmSync(r.file, { force: true });
    }
    await stackRows(rows, join(outDir, `${f.id}.png`));
  }
  writeFileSync(
    join(outDir, 'report.json'),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), command: 'pnpm formats:prove', templates: samples.map((s) => s.template), results },
      null,
      2
    ) + '\n'
  );
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed; sheets in ${outDir}`);
  if (failed.length) process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
