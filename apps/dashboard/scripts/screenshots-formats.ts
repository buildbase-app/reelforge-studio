/**
 * Screenshots of output formats in the dashboard (#302) for docs/proofs/dashboard/:
 * one project rendered as a transparent ProRes MOV (output) and as WebM with
 * alpha, GIF and MP4 (variants) by the real html engine; the library cards and
 * the render pages of the MOV and the GIF. Desktop 1440 px and mobile 390 px,
 * light and dark, device scale factor 2.
 *
 *   REELFORGE_CHROMIUM_PATH=... pnpm --filter @reelforge/dashboard screenshots:formats [outDir]
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { htmlEngine } from '@reelforge/engine-html';
import { chromium, type Page } from 'playwright';
import { startStudio } from '../test/harness';

const executablePath = process.env.REELFORGE_CHROMIUM_PATH;
if (!executablePath) throw new Error('set REELFORGE_CHROMIUM_PATH');
const out = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..', 'docs', 'proofs', 'dashboard'));
mkdirSync(out, { recursive: true });

/** A lower third: a name card that slides in over a transparent page (what an editor overlays on footage). Variants: MOV with alpha, WebM with alpha, GIF, MP4. */
const lowerThird = {
  schemaVersion: '0.2',
  projectId: 'lower-third',
  title: 'Speaker lower third',
  output: { width: 1920, height: 1080, fps: 30, format: 'mov', alpha: true },
  // One render_project call renders every variant (each its own render).
  variants: [
    { id: 'overlay', width: 1920, height: 1080 },
    { id: 'web', width: 1920, height: 1080, format: 'webm', alpha: true },
    { id: 'gif', width: 1920, height: 1080, format: 'gif' },
    { id: 'mp4', width: 1920, height: 1080, format: 'mp4' },
  ],
  theme: 'midnight',
  scenes: [
    {
      id: 'name',
      engine: 'html',
      durationSeconds: 3,
      html: '<div class="card"><div class="bar"></div><div><p class="name">Ana Moreno</p><p class="role">Head of post-production, Northlight Films</p></div></div>',
      css:
        '.card{position:absolute;left:var(--rf-safe-left);bottom:var(--rf-safe-bottom);display:flex;gap:calc(var(--rf-unit)*2.4);align-items:stretch;padding:calc(var(--rf-unit)*2.4) calc(var(--rf-unit)*3.2);background:var(--rf-surface);border-radius:calc(var(--rf-unit)*1.2);animation:in .6s cubic-bezier(.22,1,.36,1) both}' +
        '.bar{width:calc(var(--rf-unit)*.8);border-radius:999px;background:var(--rf-accent);transform-origin:bottom;animation:grow .5s .2s cubic-bezier(.22,1,.36,1) both}' +
        '.name{margin:0;color:var(--rf-text);font-size:calc(var(--rf-unit)*5.2);font-weight:600;line-height:1.1}' +
        '.role{margin:calc(var(--rf-unit)*.8) 0 0;color:var(--rf-muted);font-size:calc(var(--rf-unit)*2.8)}' +
        '@keyframes in{from{opacity:0;transform:translateY(calc(var(--rf-unit)*3))}to{opacity:1;transform:none}}@keyframes grow{from{transform:scaleY(0)}}',
    },
  ],
};

const studio = await startStudio([htmlEngine()]);
const { call, waitFor } = studio;
const created = await call('POST', '/v1/projects', lowerThird);
if (created.status !== 201) throw new Error(`create: ${created.status} ${JSON.stringify(created.json)}`);
const renders: Record<string, string> = {};
const batch = await call('POST', '/v1/projects/lower-third/renders', {});
for (const queued of batch.json.jobs as Array<{ id: string; params: { variant: string } }>) {
  const job = await waitFor(queued.id);
  if (job.status !== 'succeeded') throw new Error(`${queued.params.variant}: ${JSON.stringify(job.error)}`);
  renders[queued.params.variant] = job.result.renderId;
}

const browser = await chromium.launch({ executablePath });
const variants = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
] as const;
const shot = (page: Page, name: string) => page.screenshot({ path: join(out, `${name}.png`) });
for (const v of variants) {
  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: v.viewport, colorScheme: scheme, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(`${studio.url}/dashboard/`);
    await page.getByLabel('API key').fill(studio.keys.render);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { level: 1, name: 'Jobs' }).waitFor();
    await page.goto(`${studio.url}/dashboard/#/library/lower-third`);
    await page.waitForFunction(() => {
      const imgs = [...document.querySelectorAll<HTMLImageElement>('.render-grid img')];
      return imgs.length === 4 && imgs.every((img) => img.complete && img.naturalWidth > 0);
    });
    await shot(page, `library-formats-${v.name}-${scheme}`);
    for (const [key, name] of [['overlay', 'render-mov-alpha'], ['gif', 'render-gif']] as const) {
      await page.goto(`${studio.url}/dashboard/#/renders/${renders[key]}`);
      await page.getByText('Decodes from start to end').waitFor();
      await page.waitForFunction(() => {
        const img = document.querySelector<HTMLImageElement>('.player img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      });
      await page.waitForTimeout(800);
      await shot(page, `${name}-${v.name}-${scheme}`);
    }
    await context.close();
  }
}
await browser.close();
await studio.stop();
console.log(`screenshots in ${out}`);
