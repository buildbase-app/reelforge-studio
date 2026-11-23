// Walkthrough videos of full processes (Playwright recordVideo), transcoded
// to H.264 MP4 + VP9 WebM at 1280x720 with posters. (a) and (b) are recorded
// by the flows step; this step records (c) the agents page, (d) docs and
// gallery browsing when they have content, and (e) the replay of a recorded
// agent session that renders a reel (also as a 9:16 variant).

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { assertMasked, glideClick, launch, newContext, settle, smoothScroll } from '../browser.mjs';
import { toPlayableWebm, transcodeWalkthrough } from '../encode.mjs';
import { sha256 } from '../lib.mjs';
import { REPO_ROOT } from '../run.mjs';
import { replayPage } from '../terminal.mjs';

const VIDEO = { width: 1280, height: 720 };
export const FIXTURE = 'scripts/capture/fixtures/agent-session-multi-engine.json';
/** Where the store serves the files (store repo: public/walkthroughs/). */
export const STORE_PATH = '/walkthroughs';

/**
 * Transcodes a raw recording, records the walkthrough (steps, what it
 * proves, files and sizes), adds its poster to the images to upload, and
 * copies the files into the store when --store-dir is given. Deletes nothing
 * but the transcode's temp files; the caller removes the raw recording.
 */
export async function finishRecording(run, raw, { slug, title, proves, steps, site, width = VIDEO.width, height = VIDEO.height, posterAt = 3, trimStart = 0.4 }) {
  const t = await transcodeWalkthrough(raw, join(run.out, 'videos'), slug, { width, height, posterAt, trimStart });
  const posterKey = `walkthrough--${slug}--poster`;
  const posterFile = join(run.out, 'images', `${posterKey}.webp`);
  copyFileSync(t.files.posterWebp.file, posterFile);
  const posterSha = sha256(readFileSync(posterFile));
  run.results.images.push({ key: posterKey, group: 'walkthrough', slug, crop: 'poster', capturedOn: new Date().toISOString().slice(0, 10), page: 'docs/public/walkthroughs.md', title: `${title} (poster)`, sha256: posterSha, bytes: t.files.posterWebp.bytes, width, height });
  const files = Object.fromEntries(['mp4', 'webm', 'jpg'].map((k) => [k, { name: basename(t.files[k].file), bytes: t.files[k].bytes }]));
  const video = { slug, title, proves, steps, site: site ?? null, recordedOn: new Date().toISOString().slice(0, 10), duration: t.duration, width: t.width, height: t.height, hash8: t.hash8, files, storePath: STORE_PATH, posterKey };
  run.results.videos.push(video);
  if (run.args.storeDir) {
    const dest = resolve(run.args.storeDir, 'public', 'walkthroughs');
    mkdirSync(dest, { recursive: true });
    // Hashed names: drop this walkthrough's older files, copy the new ones.
    for (const f of readdirSync(dest)) if (f.startsWith(`${slug}.`) && !f.startsWith(`${slug}.${t.hash8}.`)) rmSync(join(dest, f));
    for (const k of ['mp4', 'webm', 'jpg']) copyFileSync(t.files[k].file, join(dest, files[k].name));
  }
  rmSync(t.files.posterWebp.file, { force: true });
  run.log(`  video ${slug}: ${t.duration} s, mp4 ${Math.round(files.mp4.bytes / 1024)} KB, webm ${Math.round(files.webm.bytes / 1024)} KB`);
  return video;
}

/** Records `body` in a fresh recorded context and finishes the walkthrough. */
async function record(run, browser, { slug, title, proves, site, size = VIDEO, permissions, body }) {
  const rawDir = join(run.out, 'raw', slug);
  rmSync(rawDir, { recursive: true, force: true });
  const ctx = await newContext(browser, { ...size, site, recordDir: rawDir, permissions });
  const page = await ctx.newPage();
  const steps = [];
  const t0 = Date.now();
  const step = (text) => {
    steps.push({ at: Math.round((Date.now() - t0) / 100) / 10, text });
    run.log(`  ${slug}: ${text}`);
  };
  try {
    const skipped = await body({ page, step });
    if (skipped) {
      await ctx.close();
      rmSync(rawDir, { recursive: true, force: true });
      run.skip(`walkthrough ${slug}`, skipped);
      return null;
    }
    await assertMasked(page);
  } catch (e) {
    await ctx.close().catch(() => {});
    rmSync(rawDir, { recursive: true, force: true });
    throw new Error(`${slug}: ${e.message.split('\n')[0]}`);
  }
  await ctx.close();
  const raw = readdirSync(rawDir).filter((f) => f.endsWith('.webm')).map((f) => join(rawDir, f))[0];
  const video = await finishRecording(run, raw, { slug, title, proves, steps, site, width: size.width, height: size.height });
  rmSync(rawDir, { recursive: true, force: true });
  return video;
}

/** (c) /agents: pick Claude Code and copy its snippet. */
async function agentsBody(site) {
  return async ({ page, step }) => {
    await page.goto(`${site}/agents`, { waitUntil: 'load' });
    await settle(page);
    await page.waitForTimeout(1800);
    step('Open /agents, the page that explains how an agent connects');
    const tab = page.locator('button, [role=tab]').filter({ hasText: /^\s*Claude Code\s*$/ }).filter({ visible: true }).first();
    await tab.scrollIntoViewIfNeeded();
    await smoothScroll(page, { by: -120, ms: 400 });
    await page.waitForTimeout(800);
    await glideClick(page, tab);
    step('Choose the Claude Code tab');
    await page.waitForTimeout(1200);
    const copy = page.getByRole('button', { name: /Copy the Claude Code snippet/ }).filter({ visible: true }).first();
    await glideClick(page, copy);
    await page.waitForTimeout(1500);
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    if (!/claude mcp add/.test(copied)) throw new Error('the copied snippet does not contain "claude mcp add"');
    step('Copy the snippet: the clipboard now holds the `claude mcp add --transport http reelforge …` command (the key stays a placeholder)');
    await page.waitForTimeout(1200);
    await smoothScroll(page, { by: 900, ms: 1600 });
    await page.waitForTimeout(1200);
    await smoothScroll(page, { by: 900, ms: 1600 });
    await page.waitForTimeout(1500);
    step('Scroll on to the per-agent keys and the example prompts');
  };
}

/** (d) Docs: index → pages through the sidebar, when the docs have content. */
async function docsBody(site) {
  return async ({ page, step }) => {
    await page.goto(`${site}/docs`, { waitUntil: 'load' });
    await settle(page);
    if (/could not be loaded on this server/i.test(await page.innerText('main').catch(() => ''))) return 'the docs are empty on this site (no content-reader key on the Worker, #93)';
    const links = await page.locator('nav a[href^="/docs/"], aside a[href^="/docs/"]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href')))].slice(0, 3));
    if (!links.length) return 'no doc pages linked from /docs';
    step('Open /docs');
    await page.waitForTimeout(1500);
    for (const href of links) {
      await glideClick(page, page.locator(`a[href="${href}"]`).first());
      await page.waitForURL(`**${href}`);
      await settle(page);
      await page.waitForTimeout(1200);
      await smoothScroll(page, { by: 700, ms: 1500 });
      await page.waitForTimeout(800);
      step(`Read ${href}`);
    }
    return null;
  };
}

/** (d) Gallery: browse reels, when the gallery is deployed. */
async function galleryBody(site) {
  return async ({ page, step }) => {
    const res = await page.goto(`${site}/gallery`, { waitUntil: 'load' });
    await settle(page);
    const notFound = /page not found|couldn't find the page/i.test(await page.innerText('main').catch(() => ''));
    if (!res || res.status() === 404 || notFound) return 'the gallery is not deployed on this site yet';
    if (/gallery is being rendered/i.test(await page.innerText('main').catch(() => ''))) return 'the gallery has no reels yet (served from R2, #89)';
    step('Open /gallery');
    await page.waitForTimeout(1500);
    await smoothScroll(page, { by: 800, ms: 1600 });
    await page.waitForTimeout(1000);
    const first = page.locator('main a[href^="/gallery/"]').first();
    if (await first.count()) {
      await glideClick(page, first);
      await settle(page);
      await page.waitForTimeout(3000);
      step('Open a reel: its prompt, tool calls and render facts');
    }
    return null;
  };
}

/** (e) The replay of a recorded agent session, then the reel it rendered. */
async function agentSession(run, browser) {
  const fixture = JSON.parse(readFileSync(join(REPO_ROOT, FIXTURE), 'utf8'));
  const reel = run.args.reel ? resolve(run.args.reel) : join(run.out, 'inputs', 'agent-session.mp4');
  if (!existsSync(reel)) {
    run.skip('walkthrough agent-session', `the reel of the recorded session is missing (pass --reel <final.mp4> of render ${fixture.render.id})`);
    return;
  }
  const work = join(run.out, 'work', 'agent-session');
  mkdirSync(work, { recursive: true });
  await toPlayableWebm(reel, join(work, 'reel.webm'));
  const proves = `An agent (Claude Code, ${fixture.model}) drives the studio over MCP from one prompt: list_templates, create_project, validate_project, render_project, get_job until done, get_render_output, and the studio renders a ${fixture.render.durationSeconds} s reel with ${fixture.render.engines.length} engines (${fixture.render.engines.join(', ')}).`;
  const steps = [
    { text: 'Claude Code starts with only the reelforge MCP tools allowed and the prompt' },
    ...fixture.tools.filter((t) => t.name).map((t) => ({ text: `${t.name}${t.input ? ` (${t.input.slice(0, 80)}${t.input.length > 80 ? '…' : ''})` : ''} → ${t.result}` })),
    { text: `The reel plays: ${fixture.render.width}x${fixture.render.height}, ${fixture.render.frames} frames, rendered in ${fixture.render.renderSeconds} s` },
  ];
  for (const variant of [{ slug: 'agent-session', size: VIDEO, vertical: false }, { slug: 'agent-session-vertical', size: { width: 720, height: 1280 }, vertical: true }]) {
    writeFileSync(join(work, `${variant.slug}.html`), replayPage(fixture, { reelSrc: 'reel.webm', vertical: variant.vertical }));
    const rawDir = join(run.out, 'raw', variant.slug);
    rmSync(rawDir, { recursive: true, force: true });
    const ctx = await newContext(browser, { ...variant.size, recordDir: rawDir });
    const page = await ctx.newPage();
    await page.goto(`file://${join(work, `${variant.slug}.html`)}`);
    await page.waitForFunction(() => /** @type {any} */ (window).__replayDone === true, null, { timeout: 120_000, polling: 250 });
    await assertMasked(page);
    if (!variant.vertical) {
      const png = await page.screenshot({ type: 'png' });
      await run.saveShots({ group: 'studio', site: 'local', slug: 'agent-session-replay', width: variant.size.width, theme: 'dark' }, { fold: png }, { page: 'docs/public/screenshots/studio.md', title: 'Agent session over MCP (last frame of the replay)' });
    }
    await ctx.close();
    const raw = readdirSync(rawDir).filter((f) => f.endsWith('.webm')).map((f) => join(rawDir, f))[0];
    await finishRecording(run, raw, {
      slug: variant.slug,
      title: variant.vertical ? 'An agent makes a reel (9:16)' : 'An agent makes a reel over MCP',
      proves,
      steps,
      width: variant.size.width,
      height: variant.size.height,
      posterAt: 30,
    });
    rmSync(rawDir, { recursive: true, force: true });
  }
}

export const WALKTHROUGHS = {
  'agents-copy-snippet': { title: 'Connect Claude Code from /agents', proves: 'The /agents page gives a working Claude Code snippet: one click copies the `claude mcp add` command for the studio.', body: agentsBody, permissions: ['clipboard-read', 'clipboard-write'] },
  'docs-navigation': { title: 'Find your way in the docs', proves: 'The published docs load on the store and link to each other.', body: docsBody },
  'gallery-browsing': { title: 'Browse the reel gallery', proves: 'The gallery lists reels rendered by the studio with their prompts and render facts.', body: galleryBody },
};

export async function captureVideos(run, site) {
  if (run.args.dryRun) {
    for (const [slug, w] of Object.entries(WALKTHROUGHS)) run.log(`videos: would record ${slug} ("${w.title}") on ${site}`);
    run.log(`videos: would record agent-session and agent-session-vertical from ${FIXTURE}`);
    return;
  }
  const browser = await launch();
  try {
    const failed = [];
    const attempt = async (slug, fn) => {
      try {
        await fn();
      } catch (e) {
        failed.push(slug);
        run.note(`walkthrough ${slug} failed: ${e.message.split('\n')[0]}`);
      }
    };
    for (const [slug, w] of Object.entries(WALKTHROUGHS)) {
      run.log(`videos: ${w.title}`);
      await attempt(slug, async () => record(run, browser, { slug, title: w.title, proves: w.proves, site, permissions: w.permissions, body: await w.body(site) }));
    }
    run.log('videos: agent session replay');
    await attempt('agent-session', () => agentSession(run, browser));
    if (failed.length) run.results.failed = [...(run.results.failed ?? []), ...failed];
    await run.flush();
  } finally {
    await browser.close();
  }
}
