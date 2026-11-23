/**
 * Builds the dashboard into static files (D-115):
 *
 *   dist/index.html
 *   dist/assets/app-<hash>.js, app-<hash>.css, mark-<hash>.svg
 *
 * One minified ES module and one stylesheet, no source maps, no external URL.
 * Fails when the JS and CSS together exceed the budget (gzip).
 *
 *   pnpm --filter @reelforge/dashboard build
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = join(here, 'dist');
/** JS + CSS, gzip, first load (#292). */
export const BUDGET_GZIP_BYTES = 150 * 1024;

export interface BuiltFile {
  name: string;
  bytes: number;
  gzip: number;
}

const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 10);

export async function buildDashboard(outDir = DEFAULT_OUT): Promise<{ files: BuiltFile[]; totalGzip: number }> {
  const result = await build({
    entryPoints: [join(here, 'src', 'main.ts'), join(here, 'src', 'styles.css')],
    bundle: true,
    minify: true,
    format: 'esm',
    target: ['es2022', 'chrome111', 'firefox113', 'safari16.4'],
    write: false,
    outdir: 'out',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'));
  const css = result.outputFiles.find((f) => f.path.endsWith('.css'));
  if (!js || !css) throw new Error('esbuild did not produce one JS and one CSS file');
  const icon = await readFile(join(here, 'src', 'mark.svg'));
  const assets: Array<[string, Uint8Array]> = [
    [`app-${hash(js.contents)}.js`, js.contents],
    [`app-${hash(css.contents)}.css`, css.contents],
    [`mark-${hash(icon)}.svg`, icon],
  ];
  const html = (await readFile(join(here, 'src', 'index.html'), 'utf8'))
    .replace('%JS%', `assets/${assets[0]![0]}`)
    .replace('%CSS%', `assets/${assets[1]![0]}`)
    .replace('%ICON%', `assets/${assets[2]![0]}`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, 'assets'), { recursive: true });
  for (const [name, body] of assets) await writeFile(join(outDir, 'assets', name), body);
  await writeFile(join(outDir, 'index.html'), html);

  const files = [...assets.slice(0, 2), ['index.html', Buffer.from(html)] as [string, Uint8Array]].map(([name, body]) => ({
    name,
    bytes: body.byteLength,
    gzip: gzipSync(body, { level: 9 }).byteLength,
  }));
  const totalGzip = files.filter((f) => /\.(js|css)$/.test(f.name)).reduce((n, f) => n + f.gzip, 0);
  if (totalGzip > BUDGET_GZIP_BYTES) throw new Error(`dashboard JS + CSS is ${totalGzip} bytes gzipped, over the ${BUDGET_GZIP_BYTES} byte budget`);
  return { files, totalGzip };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { files, totalGzip } = await buildDashboard(process.argv[2] ?? DEFAULT_OUT);
  for (const f of files) console.log(`${f.name.padEnd(28)} ${String(f.bytes).padStart(7)} B  ${String(f.gzip).padStart(6)} B gzip`);
  console.log(`JS + CSS: ${(totalGzip / 1024).toFixed(1)} KB gzip (budget ${BUDGET_GZIP_BYTES / 1024} KB)`);
}
