// Studio "screenshots": the studio has no GUI, so this step runs real
// sessions against a local studio started from this checkout and renders
// what they printed as terminal views: creating an API key, starting the
// server, `claude mcp add`, /readyz and /metrics, a render job with its
// progress, and `docker compose up` when a studio image is available. The
// render of fixtures/contact-sheet-reel.json (one scene per built-in
// template) gives a contact sheet per template and engine. Keys and tokens
// never leave the process: commands show `$REELFORGE_KEY`, and every view
// is masked before it is saved.

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { launch, newContext, assertMasked } from '../browser.mjs';
import { contactSheet } from '../encode.mjs';
import { REPO_ROOT } from '../run.mjs';
import { cleanOutput, terminalPage } from '../terminal.mjs';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const PAGE = 'docs/public/screenshots/studio.md';
const PORT = Number(process.env.CAPTURE_STUDIO_PORT ?? 4391);

/** Runs one shell command as shown (bash), with the session's variables; returns { cmd, output }. */
async function sh(cmd, env, { timeout = 300_000, cwd } = {}) {
  try {
    const { stdout, stderr } = await exec('bash', ['-c', `${cmd} 2>&1`], { env, cwd, timeout, maxBuffer: 16 * 1024 * 1024 });
    return { cmd, output: cleanOutput(stdout + stderr) };
  } catch (e) {
    return { cmd, output: cleanOutput(`${e.stdout ?? ''}${e.stderr ?? ''}`) || `(exit ${e.code})`, failed: true };
  }
}

async function waitReady(url, ms = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Renders a terminal view to PNG (full height, 2x) and saves it. */
async function saveView(run, page, work, slug, view) {
  const file = join(work, `${slug}.html`);
  writeFileSync(file, terminalPage(view));
  await page.goto(`file://${file}`);
  await assertMasked(page);
  const full = await page.screenshot({ type: 'png', fullPage: true });
  await run.saveShots({ group: 'studio', site: 'local', slug, width: 1280, theme: 'dark' }, { fold: full }, { page: PAGE, title: view.title, caption: view.caption ?? null });
  run.log(`  view ${slug}`);
}

function chromiumPath() {
  if (process.env.REELFORGE_CHROMIUM_PATH) return process.env.REELFORGE_CHROMIUM_PATH;
  try {
    return require('playwright').chromium.executablePath();
  } catch {
    return '';
  }
}

export async function captureStudio(run) {
  if (run.args.dryRun) {
    run.log('studio: would start a local studio from this checkout (licence mode off), run keys create, pnpm start, claude mcp add/list, /readyz, /metrics, a render with progress, docker compose up (if an image is there), and make contact sheets of every template');
    return;
  }
  const work = join(run.out, 'work', 'studio');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'home'), { recursive: true });
  const dataDir = join(work, 'data');
  const api = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    REELFORGE_DATA_DIR: dataDir,
    REELFORGE_PORT: String(PORT),
    REELFORGE_LICENCE_MODE: 'off',
    REELFORGE_LOGS_EXPORTER: 'pretty',
    REELFORGE_METRICS_EXPORTER: 'prometheus',
    REELFORGE_METRICS_TOKEN: randomBytes(18).toString('base64url'),
    REELFORGE_CHROMIUM_PATH: chromiumPath(),
    API: api,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
  const meta = `ReelForge Studio from source · licence mode off (local development) · ${new Date().toISOString().slice(0, 10)}`;

  // 1. An API key (printed once; it stays in this process).
  const created = await sh('pnpm --silent reelforge keys create --name docs-capture --scopes read,write,render,admin', env, { cwd: REPO_ROOT });
  const key = /rf_[A-Za-z0-9_]+/.exec(created.output)?.[0];
  if (!key) throw new Error(`keys create printed no key: ${cleanOutput(created.output).slice(0, 200).replace(/rf_\S+/g, 'rf_…')}`);
  env.REELFORGE_KEY = key;
  const listed = await sh('pnpm --silent reelforge keys list', env, { cwd: REPO_ROOT });

  // 2. The server.
  const server = spawn('pnpm', ['--silent', 'start'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  const browser = await launch();
  try {
    if (!(await waitReady(`${api}/readyz`))) throw new Error(`the studio did not become ready on ${api}: ${cleanOutput(serverLog).slice(-400)}`);
    await new Promise((r) => setTimeout(r, 1500));
    const ctx = await newContext(browser, { width: 1280, height: 720, theme: 'dark' });
    const page = await ctx.newPage();
    await saveView(run, page, work, 'keys-create', {
      title: 'Create an API key',
      meta,
      blocks: [created, listed],
      caption: 'The key is printed once; it is masked here. `keys list` never shows it again.',
    });
    await saveView(run, page, work, 'server-start', {
      title: 'Start the studio',
      meta,
      blocks: [{ cmd: 'pnpm start', output: cleanOutput(serverLog).split('\n').slice(0, 30).join('\n') }],
      caption: 'Database migrations, plugin registry and the REST and MCP endpoints on 127.0.0.1.',
    });

    // 3. Claude Code: add the MCP server and list it (in a throwaway HOME, so no real config changes).
    const claudeEnv = { ...env, HOME: join(work, 'home') };
    const add = await sh(`claude mcp add --transport http reelforge ${api}/mcp --header "Authorization: Bearer $REELFORGE_KEY"`, claudeEnv, { timeout: 60_000 });
    const list = await sh('claude mcp list', claudeEnv, { timeout: 90_000 });
    if (add.failed || list.failed) run.note('claude mcp add/list failed: the view shows the error as printed');
    await saveView(run, page, work, 'claude-mcp-add', {
      title: 'Connect Claude Code over MCP',
      meta,
      blocks: [add, list],
      caption: '`claude mcp list` connects to the studio to check it: "Connected" means the key and the /mcp endpoint work.',
    });

    // 4. Health and metrics.
    const ready = await sh('curl -s "$API/readyz" | jq .', env);
    const metrics = await sh(`curl -s -H "Authorization: Bearer $REELFORGE_METRICS_TOKEN" "$API/metrics" | grep -E '^(# HELP|# TYPE)? ?(reelforge|process_resident|nodejs_version)' | head -32`, env);
    await saveView(run, page, work, 'readyz', { title: 'Readiness: /readyz', meta, blocks: [ready], caption: 'What a load balancer or Docker health check reads.' });
    await saveView(run, page, work, 'metrics', { title: 'Prometheus metrics: /metrics', meta, blocks: [metrics], caption: 'Served when observability.metrics.exporter is prometheus; the bearer token is optional (REELFORGE_METRICS_TOKEN).' });

    // 5. A render job with its progress (REST, long-poll), one scene per built-in template.
    copyFileSync(join(REPO_ROOT, 'scripts/capture/fixtures/contact-sheet-reel.json'), join(work, 'templates-reel.json'));
    const renderEnv = { ...env };
    const steps = [
      await sh(`curl -s "$API/v1/projects" -H "Authorization: Bearer $REELFORGE_KEY" -H 'content-type: application/json' -d @templates-reel.json | jq -c '{project: .meta.id, version: .meta.version, scenes: (.manifest.scenes | length)}'`, renderEnv, { cwd: work }),
      await sh(`curl -s -X POST "$API/v1/projects/docs-capture-templates/validate" -H "Authorization: Bearer $REELFORGE_KEY" | jq -c '{ok, summary}'`, renderEnv),
    ];
    const start = await sh(`curl -s -X POST "$API/v1/projects/docs-capture-templates/renders" -H "Authorization: Bearer $REELFORGE_KEY" -H 'content-type: application/json' -d '{}' | jq -r .job.id`, renderEnv);
    const job = start.output.trim();
    renderEnv.JOB = job;
    steps.push({ cmd: `JOB=$(curl -s -X POST "$API/v1/projects/docs-capture-templates/renders" -H "Authorization: Bearer $REELFORGE_KEY" -d '{}' | jq -r .job.id); echo $JOB`, output: job });
    const poll = await sh(
      `while :; do J=$(curl -s "$API/v1/jobs/$JOB?wait=8" -H "Authorization: Bearer $REELFORGE_KEY"); echo "$J" | jq -r '"\\(.status)  \\((.progress.fraction // 0) * 100 | floor)%  \\(.progress.stage // "")  \\(.progress.detail // "")"'; case $(echo "$J" | jq -r .status) in succeeded|failed|cancelled) break;; esac; done`,
      renderEnv,
      { timeout: 900_000 }
    );
    steps.push(poll);
    const done = await sh(`curl -s "$API/v1/jobs/$JOB" -H "Authorization: Bearer $REELFORGE_KEY" | jq -c '.result | {renderId, durationSeconds, frames, width, height, fps}'`, renderEnv);
    steps.push(done);
    await saveView(run, page, work, 'render-progress', { title: 'A render job and its progress', meta, blocks: steps, caption: 'POST /v1/projects, validate, render, then GET /v1/jobs/{id}?wait= (long-poll) until it succeeds: every scene is rendered by its engine, then assembled and checked.' });
    if (!/succeeded/.test(poll.output)) run.note('the studio render did not succeed: no contact sheets');
    else await templateSheets(run, dataDir, done.output);

    // 6. docker compose up, when an image is there (the release image needs a build or registry access).
    const image = process.env.REELFORGE_IMAGE ?? 'reelforge-studio:latest';
    const have = await sh(`docker image inspect ${image} --format '{{.Id}}'`, env);
    if (have.failed) run.skip('studio view docker-compose-up', `no ${image} image here (build it with docker compose build, or set REELFORGE_IMAGE)`);
    else await composeView(run, page, work, env, image, meta);
    await ctx.close();
  } finally {
    server.kill('SIGTERM');
    await browser.close();
    rmSync(join(work, 'home'), { recursive: true, force: true }); // the throwaway Claude config holds the key
  }
}

/** One contact sheet per scene (= per template and engine), from the render's clips, plus the whole reel. */
async function templateSheets(run, dataDir, resultLine) {
  const renderId = /"renderId":"([^"]+)"/.exec(resultLine)?.[1];
  const dir = join(dataDir, 'projects', 'docs-capture-templates', 'renders', renderId ?? '');
  if (!renderId || !existsSync(dir)) {
    run.note(`render output not found under ${dir}`);
    return;
  }
  const manifest = JSON.parse((await import('node:fs')).readFileSync(join(REPO_ROOT, 'scripts/capture/fixtures/contact-sheet-reel.json'), 'utf8'));
  const clips = readdirSync(join(dir, 'clips')).filter((f) => f.endsWith('.mp4')).sort();
  for (const [i, scene] of manifest.scenes.entries()) {
    const clip = clips[i];
    if (!clip) continue;
    const sheet = await contactSheet(join(dir, 'clips', clip), { count: 6, thumbHeight: 420 });
    await run.saveShots(
      { group: 'studio', site: 'local', slug: `template-${scene.template}`, width: 1280, theme: 'dark' },
      { fold: sheet.png },
      { page: PAGE, title: `${scene.template} (${scene.engine})`, caption: `${scene.durationSeconds} s scene, frames at ${sheet.times.join(', ')} s`, engine: scene.engine, template: scene.template }
    );
    run.log(`  contact sheet ${scene.template}`);
  }
  const sheet = await contactSheet(join(dir, 'final.mp4'), { count: 8, thumbHeight: 420 });
  await run.saveShots({ group: 'studio', site: 'local', slug: 'template-reel-final', width: 1280, theme: 'dark' }, { fold: sheet.png }, { page: PAGE, title: 'The assembled reel (all four engines)', caption: `final.mp4, ${Math.round(sheet.duration * 10) / 10} s, frames at ${sheet.times.join(', ')} s` });
}

async function composeView(run, page, work, env, image, meta) {
  const composeEnv = { ...env, REELFORGE_IMAGE: image, REELFORGE_BOOTSTRAP_KEY: env.REELFORGE_KEY, COMPOSE_PROJECT_NAME: 'rfcapture' };
  const up = await sh('docker compose up -d --no-build', composeEnv, { cwd: REPO_ROOT, timeout: 300_000 });
  await new Promise((r) => setTimeout(r, 8000));
  const ps = await sh('docker compose ps --format "table {{.Service}}\\t{{.State}}\\t{{.Status}}\\t{{.Ports}}"', composeEnv, { cwd: REPO_ROOT });
  const logs = await sh('docker compose logs reelforge --no-log-prefix | head -20', composeEnv, { cwd: REPO_ROOT });
  await sh('docker compose down -v', composeEnv, { cwd: REPO_ROOT, timeout: 120_000 });
  await saveView(run, page, work, 'docker-compose-up', { title: 'docker compose up', meta: `${image} · ${meta}`, blocks: [up, ps, logs], caption: 'The hardened compose file: read-only root, no capabilities, non-root user, seccomp profile.' });
}
