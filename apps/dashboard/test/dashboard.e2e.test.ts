import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { fakeEngine } from '../../../packages/core/test/helpers';
import { BUDGET_GZIP_BYTES } from '../build';
import { htmlReel, startStudio } from './harness';

/**
 * The dashboard in a real browser against a real studio (fake engines, real
 * FFmpeg output): sign in with a key, see jobs and renders, cancel as a render
 * key, read-only as a read key, axe-core with 0 violations in light and dark,
 * no CSP violation and no request to another origin.
 */
const executablePath = process.env.REELFORGE_CHROMIUM_PATH;
const hasBrowser = Boolean(executablePath && existsSync(executablePath));
const requireBrowser = process.env.REELFORGE_REQUIRE_BROWSER === '1';
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

it.runIf(requireBrowser)('REELFORGE_REQUIRE_BROWSER=1: a browser must be configured', () => expect(hasBrowser).toBe(true));

describe.runIf(hasBrowser)('dashboard in a browser', () => {
  let studio: Awaited<ReturnType<typeof startStudio>>;
  let browser: Browser;
  const ids = { done: '', failed: '', running: '', render: '' };

  beforeAll(async () => {
    studio = await startStudio([fakeEngine('html'), fakeEngine('hyperframes', { delayPerFrameMs: 400 }), fakeEngine('remotion', { fail: true })]);
    const { call, waitFor } = studio;
    expect((await call('POST', '/v1/projects', htmlReel('spring-launch', 'Spring launch teaser'))).status).toBe(201);
    expect((await call('POST', '/v1/projects', htmlReel('long-cut', 'Long cut for the lobby screen', 8, 'hyperframes'))).status).toBe(201);
    const broken = {
      schemaVersion: '0.2',
      projectId: 'broken-intro',
      title: 'Intro that fails',
      output: { width: 1080, height: 1920, fps: 30, format: 'mp4' },
      scenes: [{ id: 'hook', engine: 'remotion', template: 'kinetic-title', durationSeconds: 2, props: { headline: 'Fails on purpose' } }],
    };
    expect((await call('POST', '/v1/projects', broken)).status).toBe(201);

    ids.done = (await call('POST', '/v1/projects/spring-launch/renders', {})).json.job.id;
    const done = await waitFor(ids.done);
    expect(done.status).toBe('succeeded');
    ids.render = done.result.renderId;
    ids.failed = (await call('POST', '/v1/projects/broken-intro/renders', {})).json.job.id;
    expect((await waitFor(ids.failed)).status).toBe('failed');
    ids.running = (await call('POST', '/v1/projects/long-cut/renders', {})).json.job.id;
    await waitFor(ids.running, ['running']);

    browser = await chromium.launch({ executablePath });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    if (ids.running) await studio?.call('POST', `/v1/jobs/${ids.running}/cancel`).catch(() => undefined);
    await studio?.stop();
  });

  /** A context that records CSP violations and every request the page makes. */
  async function open(colorScheme: 'light' | 'dark' = 'light', viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({ colorScheme, viewport });
    await context.addInitScript(() => {
      const w = window as unknown as { __csp: string[] };
      w.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const page = await context.newPage();
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    return { context, page, requests };
  }

  async function signIn(page: Page, key: string, keep = false) {
    await page.goto(`${studio.url}/dashboard`);
    await page.getByLabel('API key').fill(key);
    if (keep) await page.getByLabel('Keep me signed in until this tab closes').check();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { level: 1, name: 'Jobs' }).waitFor();
  }

  async function axe(page: Page) {
    await page.evaluate(axeSource);
    const violations = await page.evaluate(async () => {
      const r = await (window as unknown as { axe: { run(ctx: Document, o: object): Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run(document, {
        resultTypes: ['violations'],
      });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.map((n) => n.target) }));
    });
    return violations;
  }

  async function checkClean(page: Page, context: BrowserContext, requests: string[]) {
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    const foreign = requests.filter((u) => !u.startsWith(studio.url) && !u.startsWith('blob:') && !u.startsWith('data:'));
    expect(foreign).toEqual([]);
    expect(await context.cookies()).toEqual([]);
    for (const u of requests) expect(u).not.toContain('rf_');
  }

  it('the built JS and CSS fit the budget', () => {
    expect(studio.built.totalGzip).toBeLessThan(BUDGET_GZIP_BYTES);
  });

  it('signs in with a render key, shows jobs and renders, plays a render, and has no axe violations', async () => {
    const { context, page, requests } = await open('light');
    await page.goto(`${studio.url}/dashboard`);
    expect(page.url()).toBe(`${studio.url}/dashboard/`);
    expect(await axe(page), 'login page').toEqual([]);
    await signIn(page, studio.keys.render);

    // Jobs: the three jobs with their status, and the header names the key.
    const row = (id: string) => page.locator(`tr[data-job="${id}"]`);
    await row(ids.done).locator('.status-succeeded').waitFor();
    await row(ids.failed).locator('.status-failed').waitFor();
    await row(ids.running).locator('.status-running').waitFor();
    await expect(page.locator('.who-name').textContent()).resolves.toBe('render-agent');
    expect(await axe(page), 'jobs').toEqual([]);

    // One job: its output links to the render.
    await row(ids.done).getByRole('link', { name: ids.done }).click();
    await page.getByRole('heading', { level: 1, name: 'Render job' }).waitFor();
    await page.getByRole('link', { name: ids.render }).waitFor();
    expect(await axe(page), 'job').toEqual([]);

    // The failed job shows its error.
    await page.goto(`${studio.url}/dashboard/#/jobs/${ids.failed}`);
    await page.getByRole('alert').getByText('fake engine failure').waitFor();
    await page.getByRole('button', { name: 'Retry' }).waitFor();

    // Library: the project, its render card with a poster loaded through the API.
    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('heading', { level: 1, name: 'Library' }).waitFor();
    await page.getByRole('link', { name: /Spring launch teaser/ }).click();
    const card = page.locator(`a[href="#/renders/${ids.render}"]`);
    await card.waitFor();
    await page.waitForFunction((id) => {
      const img = document.querySelector<HTMLImageElement>(`a[href="#/renders/${id}"] img`);
      return Boolean(img && img.complete && img.naturalWidth > 0);
    }, ids.render);
    expect(await axe(page), 'library').toEqual([]);

    // One render: player, format, checks, scenes, storage, download.
    await card.click();
    await page.getByRole('heading', { level: 1, name: 'Spring launch teaser' }).waitFor();
    await page.getByText('Decodes from start to end').waitFor();
    await page.getByText('1080 × 1920').waitFor();
    const download = page.getByRole('link', { name: 'Download MP4' });
    expect(await download.getAttribute('href')).toMatch(new RegExp(`^/v1/renders/${ids.render}/output\\?expires=\\d+&sig=`));
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return Boolean(v && v.readyState >= 1 && v.videoWidth === 1080);
    });
    await page.getByText(`projects/spring-launch/renders/${ids.render}/`).waitFor();
    expect(await axe(page), 'render').toEqual([]);

    // The key is nowhere but in memory: not in the URL, no cookie, not in sessionStorage (not asked to keep it).
    expect(page.url()).not.toContain('rf_');
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    await checkClean(page, context, requests);

    // Sign out ends the session.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByLabel('API key').waitFor();
    await context.close();
  }, 120_000);

  it('a render key can cancel a running job from its page', async () => {
    const { context, page, requests } = await open('light');
    await signIn(page, studio.keys.render);
    await page.goto(`${studio.url}/dashboard/#/jobs/${ids.running}`);
    await page.locator('.status-running').first().waitFor();
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Cancel job' }).click();
    await page.locator('.job-head').getByText('Cancelled').waitFor();
    expect((await studio.call('GET', `/v1/jobs/${ids.running}`)).json.status).toBe('cancelled');
    await checkClean(page, context, requests);
    await context.close();
  }, 60_000);

  it('a read key sees everything but cannot cancel or retry (dark mode, no axe violations)', async () => {
    const { context, page, requests } = await open('dark');
    await signIn(page, studio.keys.read, true);
    expect(await page.evaluate(() => sessionStorage.length)).toBe(1);
    await expect(page.locator('.who-scope').textContent()).resolves.toBe('read only');
    expect(await axe(page), 'jobs, dark').toEqual([]);
    await page.goto(`${studio.url}/dashboard/#/jobs/${ids.failed}`);
    const retry = page.getByRole('button', { name: 'Retry' });
    await retry.waitFor();
    expect(await retry.isDisabled()).toBe(true);
    await page.getByText('This key is read only: cancel and retry need the render scope.').waitFor();
    expect(await axe(page), 'job, dark').toEqual([]);
    // The server refuses it too, whatever the page shows.
    expect((await studio.call('POST', `/v1/jobs/${ids.failed}/retry`, {}, studio.keys.read)).status).toBe(403);
    await page.goto(`${studio.url}/dashboard/#/renders/${ids.render}`);
    await page.getByText('Decodes from start to end').waitFor();
    expect(await axe(page), 'render, dark').toEqual([]);
    // A reload keeps the session (sessionStorage, asked for), with no prompt.
    await page.reload();
    await page.getByText('Decodes from start to end').waitFor();
    await checkClean(page, context, requests);
    await context.close();
  }, 60_000);

  it('a wrong key is refused with a message, and a 360 px screen has no axe violations', async () => {
    const { context, page } = await open('light', { width: 360, height: 740 });
    await page.goto(`${studio.url}/dashboard/`);
    await page.getByLabel('API key').fill('rf_not_a_real_key_0123456789abcdef');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').getByText(/This key was not accepted/).waitFor();
    await signIn(page, studio.keys.admin);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await axe(page), 'jobs, 360 px').toEqual([]);
    await context.close();
  }, 60_000);
});
