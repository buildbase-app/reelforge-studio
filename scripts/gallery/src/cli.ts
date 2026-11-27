#!/usr/bin/env tsx
/**
 * The gallery pipeline (docs/GALLERY.md):
 *
 *   pnpm gallery build                 catalog -> examples/gallery/*.json (validated)
 *   pnpm gallery sketch [slug...]      quick PNG look at agent-written scenes (no render)
 *   pnpm gallery render [slug...]      render over MCP -> <out>/<slug>/{final.mp4,meta.json}
 *   pnpm gallery check [slug...]       quality gate: ffprobe, black/freeze/silence, contact sheets
 *   pnpm gallery transcode [slug...]   web MP4 + VP9 WebM + AVIF/JPEG posters, hashed names
 *   pnpm gallery upload [--dry-run]    upload web files to R2 (immutable cache headers)
 *   pnpm gallery publish [--dry-run]   upsert BuildBase Collection records
 *   pnpm gallery report                examples/gallery/QUALITY.md from the last run
 *   pnpm gallery serve [--port 8787]   serve <out>/web locally for a store preview
 *
 * Common flags: --out <dir> (default $RENDERWELD_GALLERY_OUT or ./gallery-out,
 * outside git), --concurrency N (default 2), --server URL --key-file F (use a
 * running studio instead of starting one), --force.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildAll } from './catalog/index';
import { readEntries, writeEntries } from './manifests';
import { REPO } from './studio';

const DEFAULT_CHROMIUM = '/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    concurrency: { type: 'string', default: '2' },
    server: { type: 'string' },
    'key-file': { type: 'string' },
    force: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'base-url': { type: 'string' },
    bucket: { type: 'string' },
    port: { type: 'string', default: '8787' },
  },
});

const [cmd, ...slugs] = positionals;
const EXAMPLES = join(REPO, 'examples/gallery');
const OUT = resolve(flags.out ?? process.env.RENDERWELD_GALLERY_OUT ?? join(REPO, 'gallery-out'));
const chromium = process.env.RENDERWELD_CHROMIUM_PATH ?? DEFAULT_CHROMIUM;
const concurrency = Math.max(1, Number(flags.concurrency) || 2);

function entries() {
  return readEntries(EXAMPLES, slugs);
}

async function main() {
  switch (cmd) {
    case 'build': {
      const r = writeEntries(buildAll(), EXAMPLES);
      console.log(`gallery build: ${r.written} written, ${r.unchanged} unchanged, ${r.removed.length} removed (${EXAMPLES})`);
      return;
    }
    case 'sketch': {
      const { sketch } = await import('./sketch');
      const files = await sketch(entries(), join(OUT, 'sketch'), { browser: chromium });
      console.log(files.join('\n'));
      return;
    }
    case 'render': {
      const { renderAll } = await import('./render');
      const { connectMcp, startLocalStudio } = await import('./studio');
      mkdirSync(OUT, { recursive: true });
      let url = flags.server;
      let key = flags['key-file'] ? readFileSync(flags['key-file'], 'utf8').trim() : process.env.RENDERWELD_API_KEY;
      let stop = async () => undefined as void;
      if (!url) {
        const studio = await startLocalStudio({
          dataDir: join(OUT, '.studio/data'),
          cacheDir: join(OUT, '.studio/cache'),
          chromium,
          concurrency,
          noSandbox: process.env.RENDERWELD_CHROMIUM_NO_SANDBOX === '1',
        });
        url = studio.url;
        key = studio.key;
        stop = async () => {
          await studio.stop();
          writeFileSync(join(OUT, '.studio/server.log'), studio.output());
        };
        console.log(`gallery: started a local studio at ${url} (licence mode off, render concurrency ${concurrency})`);
      }
      if (!key) throw new Error('give --key-file or RENDERWELD_API_KEY with --server');
      const caller = await connectMcp(url, key);
      try {
        const caps = await caller.call('get_capabilities', {});
        const missing = (caps.engines as any[]).filter((e) => !e.available).map((e) => `${e.id}: ${e.reason}`);
        if (missing.length) throw new Error(`engines unavailable: ${missing.join('; ')}`);
        const res = await renderAll(caller, entries(), { outDir: OUT, studioUrl: url, key, concurrency, force: flags.force });
        writeFileSync(join(OUT, 'render-report.json'), JSON.stringify({ at: new Date().toISOString(), ...res }, null, 2));
        console.log(`gallery render: ${res.rendered.length} rendered, ${res.skipped.length} skipped, ${res.failed.length} failed`);
        if (res.failed.length) process.exitCode = 1;
      } finally {
        await caller.close().catch(() => undefined);
        await stop();
      }
      return;
    }
    case 'check': {
      const { checkAll } = await import('./quality');
      const r = await checkAll(OUT, entries());
      console.log(`gallery check: ${r.passed.length} passed, ${r.failed.length} failed; report ${join(OUT, 'quality.json')}`);
      return;
    }
    case 'transcode': {
      const { transcodeAll } = await import('./transcode');
      const r = await transcodeAll(OUT, entries(), { concurrency, force: flags.force });
      console.log(`gallery transcode: ${r.done} done, ${r.skipped} skipped; ${join(OUT, 'web/media.json')}`);
      return;
    }
    case 'upload': {
      const { uploadAll } = await import('./r2');
      await uploadAll(OUT, { dryRun: flags['dry-run'], bucket: flags.bucket ?? 'reelforge-media', baseUrl: flags['base-url'] });
      return;
    }
    case 'publish': {
      const { publishAll } = await import('./publish');
      await publishAll(OUT, { dryRun: flags['dry-run'], baseUrl: flags['base-url'] });
      return;
    }
    case 'report': {
      const { writeReport } = await import('./report');
      const file = join(EXAMPLES, 'QUALITY.md');
      writeReport(OUT, readEntries(EXAMPLES), file);
      console.log(`gallery report: ${file}`);
      return;
    }
    case 'serve': {
      const { serveMedia } = await import('./serve');
      const port = Number(flags.port) || 8787;
      await serveMedia(join(OUT, 'web'), port);
      console.log(`gallery serve: http://127.0.0.1:${port}/gallery/<slug>/<file> from ${join(OUT, 'web')} (Ctrl-C to stop)`);
      return;
    }
    case 'clean': {
      for (const d of ['.studio', 'sketch']) if (existsSync(join(OUT, d))) rmSync(join(OUT, d), { recursive: true, force: true });
      console.log('gallery clean: removed the local studio data and sketches');
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
