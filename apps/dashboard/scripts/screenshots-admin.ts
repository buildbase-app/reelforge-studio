/**
 * Screenshots of the analytics, settings and audit pages for
 * docs/proofs/dashboard/ (#292, part 2). Desktop 1440 px and mobile 390 px,
 * light and dark, device scale factor 2.
 *
 * What is real and what is seeded:
 *   - real: today's renders (the real html engine, needs RENDERWELD_CHROMIUM_PATH),
 *     one real failure (render.timeoutSeconds set to 2 s for a 12 s reel), scene
 *     timings from their manifests, storage used, webhook deliveries to two local
 *     receivers (one answers 204, one 500), API keys and the audit log;
 *   - seeded: the 29 days before today are job rows written straight into the
 *     database (params.seededHistory: true) so the chart has a history. They
 *     have no renders behind them, so they add nothing to the engine timings.
 *
 *   RENDERWELD_CHROMIUM_PATH=... pnpm --filter @renderweld/dashboard screenshots:admin [outDir]
 */
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { ElevenLabsTts } from '@renderweld/core';
import { htmlEngine } from '@renderweld/engine-html';
import { chromium, type Page } from 'playwright';
import { htmlReel, startStudio } from '../test/harness';

const executablePath = process.env.RENDERWELD_CHROMIUM_PATH;
if (!executablePath) throw new Error('set RENDERWELD_CHROMIUM_PATH');
const out = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..', 'docs', 'proofs', 'dashboard'));
mkdirSync(out, { recursive: true });

// Two local webhook receivers: one healthy, one that answers 500.
const receiver = (code: number) =>
  new Promise<{ server: Server; url: string }>((ok) => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(code).end());
    });
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      ok({ server, url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/hooks/reelforge` });
    });
  });
const healthy = await receiver(204);
const broken = await receiver(500);

const studio = await startStudio([htmlEngine()], {
  // The provider the server ships with (apps/server/src/registry.ts), not configured: no key, no calls.
  register: (r) => r.registerProvider(new ElevenLabsTts({})),
  env: { RENDERWELD_WEBHOOKS_ALLOW_HTTP: 'true', RENDERWELD_WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'true', RENDERWELD_WEBHOOKS_MAX_ATTEMPTS: '2' },
});
const { call, waitFor, service } = studio;
const must = async (r: Promise<{ status: number; json: any }>, what: string) => {
  const x = await r;
  if (x.status >= 300) throw new Error(`${what}: ${x.status} ${JSON.stringify(x.json)}`);
  return x.json;
};

await must(call('POST', '/v1/webhooks', { name: 'Render alerts', url: healthy.url, events: ['job.*', 'render.*'] }), 'webhook');
const ops = await must(call('POST', '/v1/webhooks', { name: 'Ops chat relay', url: broken.url, events: ['job.failed', 'key.*', 'config.changed'] }), 'webhook');
await must(call('POST', '/v1/keys', { name: 'ci-renders', scopes: ['read', 'write', 'render'], expiresInDays: 90 }), 'key');
await must(call('POST', '/v1/keys', { name: 'grafana-reader', scopes: ['read'] }), 'key');

const projects: Array<[string, string, number]> = [
  ['spring-launch', 'Spring launch teaser', 3],
  ['backend-hiring', 'We are hiring a backend engineer', 2.5],
  ['weekly-changelog', 'What changed this week', 2],
  ['lobby-loop', 'Lobby screen loop', 12],
];
for (const [id, title, seconds] of projects) await must(call('POST', '/v1/projects', htmlReel(id, title, seconds)), id);
const render = async (projectId: string) => waitFor((await must(call('POST', `/v1/projects/${projectId}/renders`, {}), projectId)).job.id);
for (const id of ['spring-launch', 'backend-hiring', 'weekly-changelog', 'spring-launch']) {
  const j = await render(id);
  if (j.status !== 'succeeded') throw new Error(`${id}: ${JSON.stringify(j.error)}`);
}
// A render with sidecar captions, for the caption tracks on the render page.
const captionedReel = htmlReel('captioned-teaser', 'Spring launch, captioned', 3) as Record<string, unknown>;
captionedReel.captions = {
  mode: 'sidecar',
  language: 'en',
  cues: [
    { start: 0.4, end: 2.4, text: 'Spring launch: rendered on this studio.' },
    { start: 3.2, end: 5.4, text: 'Swap the props, render again.' },
  ],
};
await must(call('POST', '/v1/projects', captionedReel), 'captioned');
const captionedJob = await render('captioned-teaser');
if (captionedJob.status !== 'succeeded') throw new Error(`captioned: ${JSON.stringify(captionedJob.error)}`);
// A real failure: the render timeout set below the reel's render time.
await must(call('PATCH', '/v1/config', { settings: { 'render.timeoutSeconds': 2 } }), 'timeout');
const timedOut = await render('lobby-loop');
if (timedOut.status !== 'failed') throw new Error(`expected the lobby loop to time out: ${timedOut.status}`);
await must(call('PATCH', '/v1/config', { settings: { 'render.timeoutSeconds': null } }), 'timeout reset');
// A denied call for the audit log: a read key may not cancel.
await call('POST', `/v1/jobs/${timedOut.id}/cancel`, undefined, studio.keys.read);
await call('POST', `/v1/webhooks/${ops.webhook?.id ?? ops.id}/test`, { waitSeconds: 3 });

// Seeded history (see the header): 29 days of job rows before today.
const DAY = 86_400_000;
const today = Math.floor(Date.now() / DAY) * DAY;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const codes = ['render_failed', 'render_failed', 'render_timeout', 'interrupted'];
for (let d = 29; d >= 1; d--) {
  const weekday = new Date(today - d * DAY).getUTCDay();
  const n = Math.round((weekday === 0 || weekday === 6 ? 3 : 9) + rnd() * 6 + (29 - d) * 0.25);
  for (let i = 0; i < n; i++) {
    const created = today - d * DAY + Math.floor((8 + rnd() * 10) * 3_600_000);
    const wait = Math.floor(800 + rnd() ** 3 * 40_000);
    const run = Math.floor(18_000 + rnd() * 70_000);
    const r = rnd();
    const st = r < 0.06 ? 'failed' : r < 0.08 ? 'cancelled' : 'succeeded';
    const projectId = projects[Math.floor(rnd() * projects.length)]![0];
    await service.repos.jobs.insert(
      {
        id: `job_seed${String(d).padStart(2, '0')}${String(i).padStart(2, '0')}`,
        type: rnd() < 0.15 ? 'preview' : 'render',
        status: st,
        projectId,
        params: { projectId, seededHistory: true },
        createdAt: new Date(created).toISOString(),
        startedAt: new Date(created + wait).toISOString(),
        finishedAt: new Date(created + wait + run).toISOString(),
        progress: { stage: st === 'succeeded' ? 'done' : 'render', fraction: st === 'succeeded' ? 1 : 0.4 },
        ...(st === 'succeeded' ? { result: { durationSeconds: 6 + Math.round(rnd() * 40) } } : {}),
        ...(st === 'failed' ? { error: { code: codes[Math.floor(rnd() * codes.length)]!, message: 'seeded history row', stage: 'render' } } : {}),
      },
      new Date(created).toISOString()
    );
  }
}
// Let the webhook worker deliver and retry.
await new Promise((r) => setTimeout(r, 4000));

const browser = await chromium.launch({ executablePath });
const variants = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
] as const;

async function session(viewport: { width: number; height: number }, colorScheme: 'light' | 'dark'): Promise<Page> {
  const context = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(`${studio.url}/dashboard/`);
  await page.getByLabel('API key').fill(studio.keys.admin);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { level: 1, name: 'Jobs' }).waitFor();
  return page;
}
const shot = (page: Page, name: string, fullPage = true) => page.screenshot({ path: join(out, `${name}.png`), fullPage });

for (const v of variants) {
  for (const scheme of ['light', 'dark'] as const) {
    const page = await session(v.viewport, scheme);
    const tag = `${v.name}-${scheme}`;
    await page.goto(`${studio.url}/dashboard/#/analytics`);
    await page.locator('.chart').waitFor();
    await shot(page, `analytics-${tag}`);

    await page.goto(`${studio.url}/dashboard/#/settings`);
    await page.locator('details.group').first().waitFor();
    await page.getByLabel('Filter settings').fill('render.');
    await page.locator('details[data-group="render"][open]').waitFor();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await shot(page, `settings-config-${tag}`, false);
    // Editing a runtime setting: the typed input with its bounds.
    await page.locator('li[data-key="render.timeoutSeconds"]').getByRole('button', { name: 'Edit' }).click();
    await page.locator('li[data-key="render.timeoutSeconds"] input').waitFor();
    await shot(page, `settings-config-edit-${tag}`, false);

    await page.goto(`${studio.url}/dashboard/#/settings/keys`);
    await page.locator('tr[data-key]').first().waitFor();
    await shot(page, `settings-keys-${tag}`);

    await page.goto(`${studio.url}/dashboard/#/settings/webhooks/${ops.webhook?.id ?? ops.id}`);
    await page.locator('#log-h').waitFor();
    await page.locator('#log-h ~ .table-wrap tbody tr').first().waitFor();
    await shot(page, `settings-webhook-${tag}`);

    await page.goto(`${studio.url}/dashboard/#/settings/providers`);
    await page.locator('#lic-h').waitFor();
    await shot(page, `settings-providers-${tag}`, false);

    await page.goto(`${studio.url}/dashboard/#/renders/${captionedJob.result.renderId}`);
    await page.locator('#captions-h').waitFor();
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return Boolean(v && v.poster && v.readyState >= 1);
    });
    await page.waitForTimeout(1000);
    await shot(page, `render-captions-${tag}`);

    await page.goto(`${studio.url}/dashboard/#/audit`);
    await page.locator('.panel-table tbody tr').first().waitFor();
    await shot(page, `audit-${tag}`, false);
    await page.context().close();
  }
}
await browser.close();
await studio.stop();
healthy.server.close();
broken.server.close();
console.log(`screenshots in ${out}`);
