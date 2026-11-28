import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { fakeEngine } from '../../../packages/core/test/helpers';
import { htmlReel, startStudio } from './harness';

/**
 * Part 2 of the dashboard (#292) in a real browser against a real studio:
 * analytics, settings (configuration, API keys, webhooks, providers and
 * licence) and the audit log. An admin key edits a runtime setting, creates,
 * rotates and revokes a key, tests a webhook and exports the audit log; a read
 * key sees analytics but no edit control anywhere, and the server refuses its
 * edits. axe-core 0 violations in light and dark and at 360 px; no CSP
 * violation, no request to another origin, the key never in a URL.
 */
const executablePath = process.env.RENDERWELD_CHROMIUM_PATH;
const hasBrowser = Boolean(executablePath && existsSync(executablePath));
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

describe.runIf(hasBrowser)('dashboard part 2 in a browser', () => {
  let studio: Awaited<ReturnType<typeof startStudio>>;
  let browser: Browser;
  let receiver: Server;
  let webhookId = '';
  let captioned = '';

  beforeAll(async () => {
    // A local webhook receiver, so deliveries really happen.
    receiver = createServer((req, res) => (req.resume(), req.on('end', () => res.writeHead(204).end())));
    await new Promise<void>((ok) => receiver.listen(0, '127.0.0.1', ok));
    const addr = receiver.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    studio = await startStudio([fakeEngine('html'), fakeEngine('remotion', { fail: true })], { env: { RENDERWELD_WEBHOOKS_ALLOW_HTTP: 'true', RENDERWELD_WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'true' } });
    const { call, waitFor } = studio;
    const hook = await call('POST', '/v1/webhooks', { name: 'Render alerts', url: `http://127.0.0.1:${port}/hook`, events: ['job.*'] });
    expect(hook.status).toBe(201);
    webhookId = hook.json.webhook?.id ?? hook.json.id;
    expect((await call('POST', '/v1/projects', htmlReel('spring-launch', 'Spring launch teaser'))).status).toBe(201);
    const broken = { schemaVersion: '0.2', projectId: 'broken-intro', title: 'Intro that fails', output: { width: 1080, height: 1920, fps: 30, format: 'mp4' }, scenes: [{ id: 'hook', engine: 'remotion', template: 'kinetic-title', durationSeconds: 2, props: { headline: 'Fails on purpose' } }] };
    expect((await call('POST', '/v1/projects', broken)).status).toBe(201);
    expect((await waitFor((await call('POST', '/v1/projects/spring-launch/renders', {})).json.job.id)).status).toBe('succeeded');
    expect((await waitFor((await call('POST', '/v1/projects/broken-intro/renders', {})).json.job.id)).status).toBe('failed');
    // A render with sidecar captions in two languages, for the render page's caption tracks.
    const reel = htmlReel('captioned', 'Captioned teaser') as Record<string, unknown>;
    reel.captions = {
      mode: 'sidecar',
      language: 'en',
      cues: [
        { start: 0.5, end: 1.8, text: 'Made on your own machine.' },
        { start: 2.2, end: 3.6, text: 'Two engines, one timeline.' },
      ],
    };
    const made = await call('POST', '/v1/projects', reel);
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const capJob = await waitFor((await call('POST', '/v1/projects/captioned/renders', {})).json.job.id);
    expect(capJob.status, JSON.stringify(capJob.error)).toBe('succeeded');
    captioned = capJob.result.renderId;
    browser = await chromium.launch({ executablePath });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await studio?.stop();
    receiver?.close();
  });

  async function open(colorScheme: 'light' | 'dark' = 'light', viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({ colorScheme, viewport, acceptDownloads: true });
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

  async function signIn(page: Page, key: string) {
    await page.goto(`${studio.url}/dashboard`);
    await page.getByLabel('API key').fill(key);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { level: 1, name: 'Jobs' }).waitFor();
  }

  async function axe(page: Page) {
    await page.evaluate(axeSource);
    return page.evaluate(async () => {
      const r = await (window as unknown as { axe: { run(ctx: Document, o: object): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run(document, { resultTypes: ['violations'] });
      return r.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) }));
    });
  }

  async function checkClean(page: Page, context: BrowserContext, requests: string[]) {
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    expect(requests.filter((u) => !u.startsWith(studio.url) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
    expect(await context.cookies()).toEqual([]);
    for (const u of requests) expect(u).not.toContain('rf_');
  }

  const go = async (page: Page, hash: string, h1: string | RegExp) => {
    await page.goto(`${studio.url}/dashboard/#/${hash}`);
    await page.getByRole('heading', { level: 1, name: h1 }).waitFor();
  };

  it('an admin reads analytics, edits a runtime setting, manages keys and webhooks, and exports the audit log', async () => {
    const { context, page, requests } = await open('light');
    await signIn(page, studio.keys.admin);

    // Analytics: totals from the real jobs, the chart with a keyboard tooltip, the table behind it.
    await page.getByRole('link', { name: 'Analytics' }).click();
    await page.getByRole('heading', { level: 1, name: 'Analytics' }).waitFor();
    const chart = page.locator('svg.chart');
    await chart.waitFor();
    const tile = (label: string) => page.locator('.stat', { has: page.locator('dt', { hasText: label }) }).locator('.stat-value');
    expect(await tile('Renders').textContent()).toBe('3');
    expect(await tile('Success rate').textContent()).toBe('66.7 %');
    expect(await chart.getAttribute('aria-label')).toContain('3 jobs, 2 succeeded, 1 failed');
    await chart.focus();
    await expect.poll(() => page.locator('.tip').getAttribute('visibility')).toBe('visible');
    expect(await page.locator('.tip-text').textContent()).toContain('Succeeded 2');
    await page.getByText('Show the numbers').click();
    await page.getByRole('region', { name: 'Jobs per day' }).locator('tbody tr').first().waitFor();
    expect(await page.getByRole('region', { name: 'Jobs per day' }).locator('tbody tr').count()).toBe(30);
    await page.getByRole('heading', { name: 'Top error codes' }).waitFor();
    await page.locator('.bars code').first().waitFor();
    await page.getByRole('link', { name: 'Render alerts' }).waitFor();
    await page.locator('.bar-name', { hasText: 'html' }).waitFor();
    expect(await axe(page), 'analytics').toEqual([]);
    await page.getByRole('button', { name: '24 hours' }).click();
    await page.getByRole('heading', { name: 'Renders per hour' }).waitFor();
    expect(await page.getByRole('button', { name: '24 hours' }).getAttribute('aria-pressed')).toBe('true');

    // Configuration: grouped, filtered, a runtime setting edited with type checks, then reset.
    await go(page, 'settings', 'Settings');
    await page.locator('details.group').first().waitFor();
    await page.getByLabel('Filter settings').fill('render.timeout');
    const row = page.locator('li[data-key="render.timeoutSeconds"]');
    await row.waitFor();
    expect(await page.locator('li[data-key="server.port"]').isVisible()).toBe(false);
    expect(await axe(page), 'settings').toEqual([]);
    await row.getByRole('button', { name: 'Edit' }).click();
    const input = row.getByLabel('render.timeoutSeconds');
    await input.fill('-5');
    await row.getByRole('button', { name: 'Save' }).click();
    await row.getByRole('alert').getByText('The lowest value is 0.').waitFor();
    expect(await input.getAttribute('aria-invalid')).toBe('true');
    expect(await axe(page), 'settings, editing').toEqual([]);
    await input.fill('900');
    await row.getByRole('button', { name: 'Save' }).click();
    await row.getByText('Set here', { exact: false }).waitFor();
    await row.locator('.value', { hasText: '900' }).waitFor();
    const cfg = (await studio.call('GET', '/v1/config')).json.settings.find((s: { key: string }) => s.key === 'render.timeoutSeconds');
    expect(cfg).toMatchObject({ value: 900, source: 'runtime' });
    await row.getByRole('button', { name: 'Edit' }).click();
    await row.getByRole('button', { name: 'Reset' }).click();
    await row.getByText('Default', { exact: false }).waitFor();
    // A start-up setting has no edit control.
    await page.getByLabel('Filter settings').fill('server.port');
    await page.locator('li[data-key="server.port"]').waitFor();
    expect(await page.locator('li[data-key="server.port"]').getByRole('button').count()).toBe(0);

    // API keys: create (secret shown once), rotate, revoke; the key in use cannot revoke itself.
    await page.getByRole('link', { name: 'API keys' }).click();
    await page.locator('tr[data-key]').first().waitFor();
    await page.getByLabel('Name').fill('e2e-reader');
    await page.getByRole('button', { name: 'Create key' }).click();
    const secret = page.getByRole('region', { name: 'Secret of e2e-reader' });
    await secret.waitFor();
    const created = await secret.locator('input').inputValue();
    expect(created).toMatch(/^rf_/);
    const newRow = page.locator('tr', { hasText: 'e2e-reader' });
    await newRow.waitFor();
    expect(await newRow.textContent()).toContain('read only');
    expect(await page.locator('tr', { hasText: '(this key)' }).getByRole('button', { name: /^Revoke/ }).isDisabled()).toBe(true);
    expect(await axe(page), 'keys').toEqual([]);
    await newRow.getByRole('button', { name: 'Rotate e2e-reader' }).click();
    const rotated = page.getByRole('region', { name: 'New secret for e2e-reader' });
    await rotated.waitFor();
    expect(await rotated.locator('input').inputValue()).not.toBe(created);
    page.once('dialog', (d) => void d.accept());
    await page.locator('tr', { hasText: 'e2e-reader' }).getByRole('button', { name: 'Revoke e2e-reader' }).click();
    await page.locator('tr', { hasText: 'e2e-reader' }).getByText('Revoked').waitFor();

    // Webhooks: the list, one endpoint's delivery log, a test event, a resend.
    await page.getByRole('link', { name: 'Webhooks' }).click();
    await page.getByRole('link', { name: 'Render alerts' }).click();
    await page.getByRole('heading', { level: 1, name: 'Render alerts' }).waitFor();
    await page.getByRole('heading', { name: 'Delivery log' }).waitFor();
    await page.getByRole('button', { name: 'Send test event' }).click();
    await page.getByText('Test event sent').waitFor();
    await page.locator('td', { hasText: 'webhook.test' }).first().waitFor();
    const resend = page.getByRole('button', { name: /^Resend / }).first();
    await resend.click();
    await page.getByText(/Queued again as|is due again now/).waitFor();
    expect(await axe(page), 'webhook').toEqual([]);

    // Providers and licence.
    await page.getByRole('link', { name: 'Providers and licence' }).click();
    await page.getByRole('heading', { name: 'Licence' }).waitFor();
    await page.getByRole('heading', { name: 'Media providers' }).waitFor();
    expect(await axe(page), 'providers').toEqual([]);

    // Audit log: filter by an action prefix, the denied and successful entries, a CSV export through the API.
    await page.getByRole('link', { name: 'Audit log' }).click();
    await page.getByRole('heading', { level: 1, name: 'Audit log' }).waitFor();
    await page.locator('.panel-table tbody tr').first().waitFor();
    expect(await axe(page), 'audit').toEqual([]);
    await page.getByLabel('Action starts with').fill('key.');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(async () => [...new Set(await page.locator('.panel-table tbody tr td:nth-child(3)').allTextContents())].every((a) => a.startsWith('key.'))).toBe(true);
    const actions = await page.locator('.panel-table tbody tr td:nth-child(3)').allTextContents();
    expect(actions).toEqual(expect.arrayContaining(['key.create', 'key.rotate', 'key.revoke']));
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^reelforge-audit-\d{8}T\d{6}Z\.csv$/);
    const csv = readFileSync((await download.path())!, 'utf8');
    expect(csv.split(/\r?\n/)[0]).toContain('action');
    expect(csv).toContain('key.revoke');
    expect(csv).not.toContain('config.update');
    expect(csv).not.toContain(created);

    await checkClean(page, context, requests);
    await context.close();
  }, 180_000);

  it('a read key sees analytics but cannot edit settings or read the audit log (dark, no axe violations)', async () => {
    const { context, page, requests } = await open('dark');
    await signIn(page, studio.keys.read);
    await go(page, 'analytics', 'Analytics');
    await page.locator('svg.chart').waitFor();
    expect(await axe(page), 'analytics, dark').toEqual([]);

    await go(page, 'settings', 'Settings');
    await page.getByText('The configuration needs a key with the owner scope.').waitFor();
    expect(await page.getByRole('button', { name: 'Edit' }).count()).toBe(0);
    expect(await axe(page), 'settings, dark').toEqual([]);
    await go(page, 'settings/keys', 'Settings');
    await page.getByText('Managing API keys needs a key with the admin scope.').waitFor();
    expect(await page.getByRole('button', { name: 'Create key' }).count()).toBe(0);
    // The delivery log is readable with the read scope; test, resend and rotation are not offered.
    await go(page, `settings/webhooks/${webhookId}`, 'Render alerts');
    await page.getByRole('heading', { name: 'Delivery log' }).waitFor();
    await page.getByText('Test, resend and secret rotation need the admin scope.').waitFor();
    expect(await page.getByRole('button', { name: /Resend|Send test event|Rotate secret/ }).count()).toBe(0);
    expect(await axe(page), 'webhook log, dark').toEqual([]);
    await go(page, 'audit', 'Audit log');
    await page.getByText('The audit log needs a key with the admin scope.').waitFor();
    expect(await axe(page), 'audit, dark').toEqual([]);

    // The server refuses every edit from this key, whatever the page shows.
    const k = studio.keys.read;
    expect((await studio.call('PATCH', '/v1/config', { settings: { 'render.timeoutSeconds': 5 } }, k)).status).toBe(403);
    expect((await studio.call('POST', '/v1/keys', { name: 'x', scopes: ['read'] }, k)).status).toBe(403);
    expect((await studio.call('POST', `/v1/webhooks/${webhookId}/test`, {}, k)).status).toBe(403);
    expect((await studio.call('GET', '/v1/audit', undefined, k)).status).toBe(403);
    await checkClean(page, context, requests);
    await context.close();
  }, 90_000);

  it('a key that can read the configuration but not change it gets values without edit controls', async () => {
    // get_config needs the owner scope (#304); a deployment could serve it to more keys than may change it.
    // The page decides from the key's scopes, so a read key that is served the configuration sees it read only.
    const report = (await studio.call('GET', '/v1/config')).json;
    const { context, page } = await open('light');
    await page.route('**/v1/config', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(report) }));
    await signIn(page, studio.keys.read);
    await go(page, 'settings', 'Settings');
    await page.getByText('This key can read the settings but not change them.').waitFor();
    await page.getByLabel('Filter settings').fill('render.timeout');
    await page.locator('li[data-key="render.timeoutSeconds"] .value').waitFor();
    expect(await page.getByRole('button', { name: 'Edit' }).count()).toBe(0);
    // Secrets stay masked.
    for (const v of await page.locator('li.setting .value').allTextContents()) expect(v).not.toMatch(/^rf_|whsec_/);
    expect(await axe(page), 'settings, read only').toEqual([]);
    await context.close();
  }, 60_000);

  it('the render page lists the caption tracks with their first cues (get_captions) and shows the render audio from get_render_output (#346)', async () => {
    const { context, page, requests } = await open('dark');
    await signIn(page, studio.keys.read);
    await go(page, `renders/${captioned}`, 'Captioned teaser');
    const panel = page.getByRole('region', { name: /^Captions \(1 track\)$/ });
    await panel.waitFor();
    expect(await panel.locator('.bar-name').textContent()).toBe('en · primary');
    await panel.getByText('Made on your own machine.').waitFor();
    expect(await panel.getByRole('list', { name: 'First cues, en' }).locator('li').count()).toBe(2);
    // Every render reports its audio since #346: the panel shows the track, the preset and the loudness check.
    const audio = page.getByRole('region', { name: 'Audio' });
    await audio.waitFor();
    expect(await audio.locator('dt').allTextContents()).toEqual(['Track', 'Loudness preset', 'Target', 'Measured', 'Normalisation']);
    expect(await audio.locator('ul.qa li').count()).toBeGreaterThan(0);
    expect(await axe(page), 'render with captions, dark').toEqual([]);
    await checkClean(page, context, requests);
    await context.close();
  }, 60_000);

  it('at 360 px analytics, settings and the audit log fit without sideways scrolling and have no axe violations', async () => {
    const { context, page } = await open('light', { width: 360, height: 740 });
    await signIn(page, studio.keys.admin);
    for (const [hash, h1, ready] of [
      ['analytics', 'Analytics', 'svg.chart'],
      ['settings', 'Settings', 'details.group'],
      ['settings/keys', 'Settings', 'tr[data-key]'],
      ['audit', 'Audit log', '.panel-table tbody tr'],
    ] as const) {
      await go(page, hash, h1);
      await page.locator(ready).first().waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), hash).toBe(true);
      expect(await axe(page), `${hash}, 360 px`).toEqual([]);
    }
    await context.close();
  }, 90_000);
});
