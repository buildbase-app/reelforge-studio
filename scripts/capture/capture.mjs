#!/usr/bin/env node
// Visual proof for the docs (#78): screenshots of every store page, signed-in
// flows, walkthrough videos, studio terminal views and the BuildBase console
// configuration, in one reproducible command.
//
//   pnpm capture                                  # everything, default sites
//   pnpm capture --only pages --site https://reelforge-dev.buildbase.app
//   pnpm capture --only pages,studio --upload     # + upload to BuildBase Assets
//   pnpm capture --dry-run                        # plan only: nothing captured, written or uploaded
//
// Options: --site <url> (repeatable), --only pages|flows|videos|studio|console
// (comma list), --upload, --dry-run, --out <dir> (default out/capture),
// --store-dir <store repo> (copies walkthrough videos to public/walkthroughs),
// --reel <final.mp4> and --transcript-fixture for the agent-session video,
// --blueprint <file> for the console page, --routes, --widths, --themes.
// Credentials only from the environment (BUILDBASE_API_TOKEN[_FILE]); see
// docs/CAPTURE.md.

import { resolve } from 'node:path';
import { assetToken, createAssetsApi, localFromManifest, syncAssets } from './assets.mjs';
import { redactToken } from '../docs/sync-buildbase.mjs';
import { writeDocsPages } from './docs.mjs';
import { STEPS, mergeCaptured, parseArgs } from './lib.mjs';
import { createRun, loadManifest, saveManifest } from './run.mjs';
import { DEV_SITE, PROD_SITE } from './targets.mjs';

export const ASSET_ENV = 'fsyqdskf';

const USAGE = `Usage: pnpm capture [--only ${STEPS.join('|')}] [--site <url>]... [--upload] [--dry-run]
       [--out out/capture] [--store-dir <store repo>] [--reel <final.mp4>] [--blueprint <file>]
       [--routes /,/pricing] [--widths 390,1440] [--themes light,dark]`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const run = createRun(args);
  const sites = args.sites.length ? args.sites : [DEV_SITE, PROD_SITE];
  const devSites = sites.filter((s) => /reelforge-dev\.|127\.0\.0\.1|localhost/.test(s));
  if (args.upload) assetToken(ASSET_ENV); // fail before capturing when the token is wrong

  for (const step of args.only) {
    run.log(`\n== ${step}`);
    if (step === 'pages') await (await import('./steps/pages.mjs')).capturePages(run, sites);
    else if (step === 'flows') await (await import('./steps/flows.mjs')).captureFlows(run, devSites.length ? devSites[0] : DEV_SITE);
    else if (step === 'videos') await (await import('./steps/videos.mjs')).captureVideos(run, devSites.length ? devSites[0] : DEV_SITE);
    else if (step === 'studio') await (await import('./steps/studio.mjs')).captureStudio(run);
    else if (step === 'console') await (await import('./steps/console.mjs')).captureConsole(run);
  }
  if (args.dryRun) {
    if (args.upload) {
      const manifest = loadManifest();
      const api = createAssetsApi({ token: assetToken(ASSET_ENV), serverUrl: process.env.BUILDBASE_SERVER_URL });
      await syncAssets({ api, local: localFromManifest(manifest, run.out), manifest, dryRun: true });
    }
    run.log('\nDry run: nothing was captured, written or uploaded.');
    return 0;
  }
  run.writeResults();
  let manifest = mergeCaptured(loadManifest(), run.results.images, run.results.videos);
  saveManifest(manifest);
  if (args.upload) {
    const api = createAssetsApi({ token: assetToken(ASSET_ENV), serverUrl: process.env.BUILDBASE_SERVER_URL });
    ({ manifest } = await syncAssets({ api, local: localFromManifest(manifest, run.out), manifest }));
    saveManifest(manifest);
  }
  const written = writeDocsPages(manifest);
  run.log(`\ndocs pages: ${written.join(', ')}`);
  const pending = Object.values(manifest.images).filter((e) => e.pending).length;
  run.log(`${run.results.images.length} images, ${run.results.videos.length} videos this run; ${pending} images waiting for --upload; ${run.results.notes.length} notes, ${run.results.skipped.length} skipped (see ${resolve(run.out, 'results.json')})`);
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`capture failed: ${redactToken(e instanceof Error ? e.stack ?? e.message : String(e))}`);
      process.exit(1);
    }
  );
}
