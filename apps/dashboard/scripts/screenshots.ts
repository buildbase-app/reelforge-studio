/**
 * Screenshots of the dashboard for docs/proofs/dashboard/ (#292): a real
 * studio with the real html engine (needs REELFORGE_CHROMIUM_PATH), real
 * renders, one render running while the shots are taken. Desktop 1440 px and
 * mobile 390 px, light and dark, device scale factor 2.
 *
 *   REELFORGE_CHROMIUM_PATH=... pnpm --filter @reelforge/dashboard screenshots [outDir]
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { htmlEngine } from '@reelforge/engine-html';
import { chromium, type Page } from 'playwright';
import { htmlReel, startStudio } from '../test/harness';

const executablePath = process.env.REELFORGE_CHROMIUM_PATH;
if (!executablePath) throw new Error('set REELFORGE_CHROMIUM_PATH');
const out = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..', 'docs', 'proofs', 'dashboard'));
mkdirSync(out, { recursive: true });

const studio = await startStudio([htmlEngine()]);
const { call, waitFor } = studio;
const projects: Array<[string, string, number]> = [
  ['spring-launch', 'Spring launch teaser', 3],
  ['backend-hiring', 'We are hiring a backend engineer', 2.5],
  ['weekly-changelog', 'What changed this week', 2],
  ['lobby-loop', 'Lobby screen loop', 12],
];
for (const [id, title, seconds] of projects) await call('POST', '/v1/projects', htmlReel(id, title, seconds));
const start = async (projectId: string): Promise<string> => {
  const r = await call('POST', `/v1/projects/${projectId}/renders`, {});
  if (!r.json?.job) throw new Error(`render of ${projectId}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.job.id;
};
const rendered: Record<string, string> = {};
for (const id of ['spring-launch', 'backend-hiring']) {
  const job = await waitFor(await start(id));
  if (job.status !== 'succeeded') throw new Error(`${id}: ${JSON.stringify(job.error)}`);
  rendered[id] = job.result.renderId;
}
// A second render of the launch teaser, and a cancelled one.
await waitFor(await start('spring-launch'));
const cancelled = await start('weekly-changelog');
await call('POST', `/v1/jobs/${cancelled}/cancel`);
const running = await start('lobby-loop');
await waitFor(running, ['running']);
// Let it get somewhere visible.
for (let i = 0; i < 200; i++) {
  const j = (await call('GET', `/v1/jobs/${running}`)).json;
  if (j.progress.fraction > 0.2) break;
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ executablePath });
const variants = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
] as const;
const schemes = ['light', 'dark'] as const;

async function session(viewport: { width: number; height: number }, colorScheme: 'light' | 'dark'): Promise<Page> {
  const context = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(`${studio.url}/dashboard/`);
  return page;
}
async function signIn(page: Page) {
  await page.getByLabel('API key').fill(studio.keys.render);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { level: 1, name: 'Jobs' }).waitFor();
  await page.locator('tr[data-job]').first().waitFor();
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(out, `${name}.png`) });

const pages: Page[] = [];
for (const v of variants) {
  for (const scheme of schemes) {
    const page = await session(v.viewport, scheme);
    pages.push(page);
    if (scheme === 'light' || v.name === 'mobile') await shot(page, `login-${v.name}-${scheme}`);
    await signIn(page);
    await shot(page, `jobs-${v.name}-${scheme}`);
    await page.goto(`${studio.url}/dashboard/#/jobs/${running}`);
    await page.locator('.big-progress .figure').waitFor();
    await page.waitForFunction(() => document.querySelector('.log')?.textContent !== 'No log lines yet.');
    await shot(page, `job-running-${v.name}-${scheme}`);
  }
}
let i = 0;
for (const v of variants) {
  for (const scheme of schemes) {
    const page = pages[i++]!;
    await page.goto(`${studio.url}/dashboard/#/library/spring-launch`);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.render-grid img')].every((img) => img.complete && img.naturalWidth > 0) && document.querySelectorAll('.render-grid img').length > 0);
    await shot(page, `library-${v.name}-${scheme}`);
    await page.goto(`${studio.url}/dashboard/#/renders/${rendered['spring-launch']}`);
    await page.getByText('Decodes from start to end').waitFor();
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return Boolean(v && v.poster && v.readyState >= 1);
    });
    await page.waitForTimeout(1500);
    await shot(page, `render-${v.name}-${scheme}`);
  }
}
await browser.close();
await call('POST', `/v1/jobs/${running}/cancel`);
await studio.stop();
console.log(`screenshots in ${out}`);
