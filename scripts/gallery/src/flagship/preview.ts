/**
 * Fast preview for a flagship reel, without the studio: loads the
 * composition in Chromium, seeks it to the given times, and writes one PNG
 * per time plus a contact sheet (ffmpeg tile) and the element count per frame.
 *
 *   tsx scripts/gallery/src/flagship/preview.ts <slug> <outDir> [t1 t2 ...]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { FLAGSHIP } from './index';

const [slugOrFile, outArg, ...times] = process.argv.slice(2);
// A slug from the index, or a path to a module whose exports include a FlagshipReel.
const reel = slugOrFile?.endsWith('.ts')
  ? (Object.values(await import(resolve(slugOrFile))).find((v: any) => v && typeof v === 'object' && 'html' in v && 'slug' in v) as (typeof FLAGSHIP)[number] | undefined)
  : FLAGSHIP.find((r) => r.slug === slugOrFile);
const slug = reel?.slug ?? slugOrFile;
if (!reel || !outArg) {
  console.error(`usage: preview <slug> <outDir> [times...]; slugs: ${FLAGSHIP.map((r) => r.slug).join(', ')}`);
  process.exit(2);
}
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const ts = times.length ? times.map(Number) : Array.from({ length: 16 }, (_, i) => +(i * (reel.duration / 16) + 0.9).toFixed(2));
const page = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:1080px;height:1920px;overflow:hidden;background:#000}</style></head><body><div style="position:relative;width:1080px;height:1920px">${reel.html}</div></body></html>`;
const file = join(out, `${slug}.html`);
writeFileSync(file, page);

const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const browser = await chromium.launch({ executablePath: process.env.REELFORGE_CHROMIUM_PATH || undefined });
const p = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
const errors: string[] = [];
p.on('pageerror', (e) => errors.push(String(e)));
await p.goto(`file://${file}`);
await p.waitForTimeout(300);
const counts: Record<string, number> = {};
const shots: string[] = [];
for (const t of ts) {
  await p.evaluate((tt) => (window as unknown as { __rfSeek: (t: number) => void }).__rfSeek(tt), t);
  counts[t] = await p.evaluate(() => (window as unknown as { __rfElements: number }).__rfElements);
  const f = join(out, `${slug}-${String(t).padStart(5, '0')}.png`);
  await p.screenshot({ path: f });
  shots.push(f);
}
await browser.close();
if (errors.length) console.error('page errors:', errors);
console.log('elements per frame:', JSON.stringify(counts));
const cols = 4;
const rows = Math.ceil(shots.length / cols);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...shots.flatMap((s) => ['-i', s]), '-filter_complex', `${shots.map((_, i) => `[${i}]scale=270:480[v${i}]`).join(';')};${shots.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${shots.length}:layout=${shots.map((_, i) => `${(i % cols) * 270}_${Math.floor(i / cols) * 480}`).join('|')}`, '-frames:v', '1', join(out, `${slug}-sheet.jpg`)]);
console.log(`sheet: ${join(out, `${slug}-sheet.jpg`)} (${rows}x${cols})`);
