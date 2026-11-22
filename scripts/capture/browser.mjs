// One Chromium at a time (the machine is shared): launch, contexts with the
// masking script, waiting until a page has settled, and masked screenshots.

import { createRequire } from 'node:module';
import { DEFAULT_ALLOWED_EMAILS, STILL_CSS, findSecrets, maskingInitScript } from './lib.mjs';

const require = createRequire(import.meta.url);

/**
 * Playwright's bundled Chromium, or CAPTURE_CHROMIUM_PATH; when the bundled
 * one is not installed, the studio's REELFORGE_CHROMIUM_PATH. Uses
 * HTTPS_PROXY when set (never for 127.0.0.1).
 */
export async function launch() {
  const { chromium } = require('playwright');
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const opts = proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {};
  if (process.env.CAPTURE_CHROMIUM_PATH) return chromium.launch({ ...opts, executablePath: process.env.CAPTURE_CHROMIUM_PATH });
  try {
    return await chromium.launch(opts);
  } catch (e) {
    if (!process.env.REELFORGE_CHROMIUM_PATH) throw e;
    return chromium.launch({ ...opts, executablePath: process.env.REELFORGE_CHROMIUM_PATH });
  }
}

/**
 * A context with the given viewport and theme. Stills: deviceScaleFactor 2,
 * reduced motion. Videos (`recordDir`): 1x and motion on, recorded to WebM.
 * Every page and frame gets the masking script; the consent cookie is set so
 * the banner does not cover the page.
 */
export async function newContext(browser, { width, height, theme = 'light', site, recordDir, storageState, permissions, allowEmails = DEFAULT_ALLOWED_EMAILS, scale = 2 }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: recordDir ? 1 : scale,
    colorScheme: theme === 'dark' ? 'dark' : 'light',
    reducedMotion: recordDir ? 'no-preference' : 'reduce',
    isMobile: !recordDir && width < 600,
    hasTouch: !recordDir && width < 600,
    locale: 'en-US',
    timezoneId: 'UTC',
    ...(recordDir ? { recordVideo: { dir: recordDir, size: { width, height } } } : {}),
    ...(storageState ? { storageState } : {}),
    ...(permissions ? { permissions } : {}),
  });
  if (recordDir) await ctx.addInitScript({ content: CURSOR_SCRIPT });
  await ctx.addInitScript({ content: maskingInitScript({ allowEmails }) });
  // next-themes reads localStorage first; keep it in line with the colour scheme.
  await ctx.addInitScript({ content: `try{localStorage.setItem('theme',${JSON.stringify(theme)})}catch{}` });
  if (site) {
    const host = new URL(site).hostname;
    // "Reject all" (the SDK's v1 format): no banner over the page, no analytics during capture.
    await ctx.addCookies([{ name: 'bb_consent', value: 'v1.a0.m0', domain: host, path: '/' }]);
  }
  return ctx;
}

/** Waits for network idle (bounded), web fonts, images in view and two animation frames. */
export async function settle(page, { idleMs = 15_000 } = {}) {
  await page.waitForLoadState('networkidle', { timeout: idleMs }).catch(() => {});
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await Promise.all(
      [...document.images].filter((i) => !i.complete && i.loading !== 'lazy').map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 5000); }))
    );
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/** Scrolls to the bottom in viewport steps so lazy images and reveal content load, then back to the top. */
export async function scrollThrough(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 4000); }))));
}

/** Everything a viewer could read: visible text plus input values. */
export async function readableText(page) {
  return page.evaluate(() => {
    const values = [...document.querySelectorAll('input, textarea')]
      .filter((el) => getComputedStyle(el).getPropertyValue('-webkit-text-security') !== 'disc')
      .map((el) => el.value);
    return `${document.body?.innerText ?? ''}\n${values.join('\n')}`;
  });
}

/** Throws when the page still shows a licence key, an email or a token (after masking). */
export async function assertMasked(page, { allowEmails = DEFAULT_ALLOWED_EMAILS, where = page.url() } = {}) {
  const leaks = [];
  for (const frame of page.frames()) {
    const text = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    leaks.push(...findSecrets(text, { allowEmails }));
  }
  leaks.push(...findSecrets(await readableText(page), { allowEmails }));
  if (leaks.length) throw new Error(`unmasked ${[...new Set(leaks.map((l) => l.kind))].join(', ')} on ${new URL(where).pathname}: refusing to save the image`);
}

/**
 * Takes a full-page and an above-the-fold PNG of a settled page, with motion
 * frozen (stills only) and the masking checked first. Returns PNG buffers.
 */
export async function shoot(page, { full = true, fold = true, allowEmails } = {}) {
  const style = await page.addStyleTag({ content: STILL_CSS });
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await assertMasked(page, { allowEmails });
    const out = {};
    if (fold) out.fold = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
    if (full) out.full = await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled', caret: 'hide' });
    return out;
  } finally {
    await style.evaluate((el) => el.remove()).catch(() => {});
  }
}

/**
 * Videos only: Playwright records no mouse pointer, so draw one that follows
 * the real mouse events, with a ring on each click.
 */
export const CURSOR_SCRIPT = `(() => {
  if (window.top !== window) return;
  const add = () => {
    const c = document.createElement('div');
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(20,20,20,.55);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px)';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'; }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;left:' + e.clientX + 'px;top:' + e.clientY + 'px;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:2px solid rgba(255,64,110,.9);z-index:2147483646;pointer-events:none;transition:transform .45s ease-out,opacity .45s ease-out';
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = 'scale(1.8)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 600);
    }, true);
  };
  if (document.documentElement) add(); else addEventListener('DOMContentLoaded', add);
})();`;

/** Moves the visible pointer to an element over ~0.4 s, then clicks it. */
export async function glideClick(page, locator, { timeout = 30_000 } = {}) {
  await locator.waitFor({ state: 'visible', timeout });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await locator.click({ timeout });
}

/** Scrolls smoothly (eased, ~ms long) to an absolute y or by `by` pixels. */
export async function smoothScroll(page, { to, by, ms = 900 }) {
  await page.evaluate(
    ({ to, by, ms }) =>
      new Promise((done) => {
        const from = window.scrollY;
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const target = Math.max(0, Math.min(max, to ?? from + by));
        const t0 = performance.now();
        const tick = (now) => {
          const p = Math.min(1, (now - t0) / ms);
          const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
          window.scrollTo(0, from + (target - from) * e);
          if (p < 1) requestAnimationFrame(tick);
          else done(undefined);
        };
        requestAnimationFrame(tick);
      }),
    { to, by, ms }
  );
}
