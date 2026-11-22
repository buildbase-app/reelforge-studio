// Signed-in flows on the TEST site only (BuildBase development environment in
// test mode: the sign-up code is always 424242, no mail is sent; Stripe test
// keys: card 4242 4242 4242 4242). Same steps as the store's
// scripts/e2e-personal-claim.cjs and scripts/e2e-buyer-journey.cjs, with
// condition waits instead of fixed sleeps, a visible pointer, and every
// licence key and email masked before anything is recorded or saved.
//
// Each flow is recorded (walkthrough videos a and b) and leaves a signed-in
// session; the signed-in pages are then captured at every width and theme.

import { randomBytes } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertMasked, glideClick, launch, newContext, scrollThrough, settle, shoot, smoothScroll } from '../browser.mjs';
import { MASK, routeSlug, siteLabel } from '../lib.mjs';
import { SIGNED_IN_ROUTES, VIEWPORTS, THEMES } from '../targets.mjs';
import { finishRecording } from './videos.mjs';

const VIDEO = { width: 1280, height: 720 };

export function assertTestSite(site) {
  if (!/\/\/reelforge-dev\.buildbase\.app$|\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(site)) {
    throw new Error(`flows run on the test site only (https://reelforge-dev.buildbase.app), not ${site}: they sign up accounts and pay with a Stripe test card`);
  }
}

/** A fresh +test account, like the store's e2e scripts (never printed). */
export function testAccount(kind) {
  return {
    name: kind === 'personal' ? 'Docs Capture Free' : 'Docs Capture Buyer',
    email: `docs-${kind}-${Date.now().toString(36)}+test@reelforge.dev`,
    password: `${randomBytes(12).toString('base64url')}A1!`,
  };
}

/** Polls until the masked licence key (text or a hidden input) is on the page. */
async function waitForKey(page, timeout = 90_000) {
  await page.waitForFunction(
    (mask) =>
      (document.querySelector('main')?.innerText ?? '').includes(mask) ||
      [...document.querySelectorAll('main input')].some((i) => getComputedStyle(i).getPropertyValue('-webkit-text-security') === 'disc' && i.value),
    MASK.key,
    { timeout, polling: 500 }
  );
}

/** Sign up on the hosted BuildBase page (test mode) and come back to the site. */
async function signUp(page, site, account, step, snap) {
  await page.waitForURL(/auth\.buildbase\.app/, { timeout: 45_000 });
  await settle(page);
  await page.waitForTimeout(800);
  await snap('auth-sign-in', 'BuildBase hosted sign-in page');
  step('Signed out, so the button opens the hosted BuildBase sign-in page');
  await glideClick(page, page.getByText('Create account').first());
  await page.locator('input[name=name]').waitFor({ timeout: 20_000 });
  await page.locator('input[name=name]').pressSequentially(account.name, { delay: 35 });
  await page.locator('input[type=email]').pressSequentially(account.email, { delay: 20 });
  await page.locator('input[type=password]').pressSequentially(account.password, { delay: 15 });
  await page.waitForTimeout(500);
  await snap('auth-create-account', 'Create an account (email and password hidden)');
  await glideClick(page, page.getByRole('button', { name: /Create account/ }).last());
  step('Create a fresh test account (a +test address on the development environment)');
  const codes = page.locator('input[autocomplete=one-time-code], input[name*=code i], input[inputmode=numeric]');
  await Promise.race([codes.first().waitFor({ timeout: 30_000 }), page.waitForURL(new RegExp(new URL(site).host.replace(/\./g, '\\.')), { timeout: 30_000 })]).catch(() => {});
  const n = await codes.count();
  if (n) {
    if (n === 1) await codes.first().pressSequentially('424242', { delay: 80 });
    else for (let i = 0; i < 6; i++) await codes.nth(i).pressSequentially('424242'[i], { delay: 80 });
    await page.waitForTimeout(400);
    await snap('auth-verify-code', 'Email verification with the test-mode code');
    await page.getByRole('button', { name: /Verify|Continue|Confirm/ }).first().click({ timeout: 3000 }).catch(() => page.keyboard.press('Enter'));
    step('Enter the verification code (test mode always accepts 424242)');
  }
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(2500);
    if (!/auth\.buildbase\.app/.test(page.url())) break;
    const skip = page.getByRole('button', { name: /^(Not now|Skip|Maybe later|Continue)$/ }).first();
    if (!(await skip.count())) continue;
    if (i === 0) await snap('auth-optional-prompt', 'Optional sign-in prompt (dismissed)');
    await glideClick(page, skip);
    step('Dismiss the optional prompt (passkey or two-factor offer)');
  }
  await page.waitForURL(new RegExp(new URL(site).host.replace(/\./g, '\\.')), { timeout: 60_000 });
  await settle(page);
  step('Back on the store, signed in');
}

async function toPricing(page, site) {
  if (!/\/pricing/.test(page.url())) await page.goto(`${site}/pricing`, { waitUntil: 'load' });
  await settle(page);
  await page.locator('[data-edition]').first().waitFor({ timeout: 30_000 });
}

/** (a) Visitor → pricing → claim the free Personal licence → key. */
async function personalFlow({ page, site, step, snap }) {
  const account = testAccount('personal');
  await page.goto(`${site}/pricing`, { waitUntil: 'load' });
  await settle(page);
  await page.waitForTimeout(1500);
  step('Open the pricing page as a visitor: Personal is free, Commercial is a one-time licence');
  const card = page.locator('[data-edition="personal"]').first();
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await glideClick(page, card.getByRole('button', { name: 'Get it free' }));
  step('Choose "Get it free" on the Personal card');
  await signUp(page, site, account, step, snap);
  await toPricing(page, site);
  await page.waitForTimeout(1200);
  await glideClick(page, page.locator('[data-edition="personal"]').first().getByRole('button', { name: 'Get it free' }));
  step('Choose "Get it free" again: the claim needs no payment page');
  await page.waitForURL(/\/order\?id=/, { timeout: 60_000 });
  if (/checkout\.stripe\.com/.test(page.url())) throw new Error('a payment page opened for a free claim');
  await waitForKey(page);
  await settle(page);
  await page.waitForTimeout(1500);
  await snap('order', 'Order page: the Personal licence key (masked)');
  step('The order page shows the Personal licence key (masked here) with the noncommercial reminder');
  const orderUrl = page.url();
  await smoothScroll(page, { by: 500, ms: 1200 });
  await page.waitForTimeout(1500);
  await page.goto(`${site}/dashboard/licences`, { waitUntil: 'load' });
  await waitForKey(page);
  await settle(page);
  await page.waitForTimeout(2000);
  await snap('licences', 'Dashboard > Licences');
  step('Dashboard > Licences lists the same key, labelled Personal');
  return { orderUrl };
}

/** Finds the frame holding Stripe's card number field, opening the Card option first when needed. */
async function cardFrame(page) {
  const find = async () => {
    for (const fr of page.frames()) if (await fr.$('#payment-numberInput').catch(() => null)) return fr;
    if (await page.$('#cardNumber').catch(() => null)) return page.mainFrame();
    return null;
  };
  for (let i = 0; i < 20; i++) {
    const f = await find();
    if (f) return f;
    if (i === 4 || i === 10) {
      const card = page.locator('[data-testid="card-accordion-item-button"], button:has-text("Card")').first();
      if (await card.count()) await glideClick(page, card).catch(() => {});
    }
    await page.waitForTimeout(1500);
  }
  throw new Error('Stripe card field not found');
}

/** (b) Commercial purchase with the Stripe test card → order → key. */
async function commercialFlow({ page, site, step, snap }) {
  const account = testAccount('buyer');
  await page.goto(`${site}/pricing`, { waitUntil: 'load' });
  await settle(page);
  await page.waitForTimeout(1200);
  step('Open the pricing page as a visitor');
  const studio = page.locator('[data-edition="commercial"]').filter({ hasText: 'Studio' });
  await studio.first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  await glideClick(page, page.getByText('Sign in to buy').first());
  step('Choose "Sign in to buy"');
  await signUp(page, site, account, step, snap);
  await toPricing(page, site);
  await page.locator('[data-edition="commercial"]').filter({ hasText: 'Studio' }).first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await glideClick(page, page.locator('[data-edition="commercial"]').filter({ hasText: 'Studio' }).getByRole('button', { name: /^Buy/ }));
  step('Buy the Studio tier of the Commercial licence');
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
  await settle(page);
  step('Stripe Checkout opens (test mode)');
  const f = await cardFrame(page);
  const num = f === page.mainFrame() ? '#cardNumber' : '#payment-numberInput';
  const exp = f === page.mainFrame() ? '#cardExpiry' : '#payment-expiryInput';
  const cvc = f === page.mainFrame() ? '#cardCvc' : '#payment-cvcInput';
  await f.locator(num).pressSequentially('4242424242424242', { delay: 40 });
  await f.locator(exp).pressSequentially('1234', { delay: 60 });
  await f.locator(cvc).pressSequentially('123', { delay: 60 });
  await f.fill(f === page.mainFrame() ? '#billingName' : '#payment-nameInput', 'Docs Capture Buyer').catch(() => {});
  await f.selectOption(f === page.mainFrame() ? '#billingCountry' : '#payment-countryInput', 'US').catch(() => {});
  await f.fill(f === page.mainFrame() ? '#billingPostalCode' : '#payment-postalCodeInput', '10001').catch(() => {});
  const opt = await f.$('#payment-linkOptInInput, #enableStripePass');
  if (opt && (await opt.isChecked().catch(() => false))) await opt.click({ force: true }).catch(() => {});
  await page.waitForTimeout(1000);
  await snap('stripe-checkout', 'Stripe Checkout with the test card 4242 4242 4242 4242 (email hidden)');
  step('Pay with the Stripe test card 4242 4242 4242 4242 (any future date, any CVC)');
  const pay = page.locator('button.SubmitButton, button[data-testid=hosted-payment-submit-button]').first();
  if (await pay.count()) await glideClick(page, pay);
  else await glideClick(page, page.getByText('Pay', { exact: true }).last());
  await page.waitForURL(new RegExp(new URL(site).host.replace(/\./g, '\\.')), { timeout: 120_000 });
  step('Paid: Stripe returns to the order page');
  await waitForKey(page);
  await settle(page);
  await page.waitForTimeout(1500);
  if (!(await page.locator('main [data-edition="commercial"]').count())) throw new Error('order page does not label the key Commercial');
  await snap('order', 'Order page: the Commercial licence key (masked)');
  step('The order page shows the Commercial licence key (masked here)');
  const orderUrl = page.url();
  await smoothScroll(page, { by: 500, ms: 1200 });
  await page.waitForTimeout(1500);
  await page.goto(`${site}/dashboard/licences`, { waitUntil: 'load' });
  await waitForKey(page);
  await settle(page);
  await page.waitForTimeout(2000);
  await snap('licences', 'Dashboard > Licences');
  step('Dashboard > Licences lists the key, labelled Commercial');
  return { orderUrl };
}

export const FLOWS = {
  'personal-claim': {
    title: 'Claim a free Personal licence',
    proves: 'A visitor can sign up and claim the free Personal licence with no payment page, and the key shows on the order page and in Dashboard > Licences.',
    run: personalFlow,
    stills: ['{order}', '/dashboard/licences'],
  },
  'commercial-purchase': {
    title: 'Buy a Commercial licence',
    proves: 'A buyer can pay for the Studio tier with Stripe (test mode), comes back to the order page with a Commercial licence key, and finds it in Dashboard > Licences.',
    run: commercialFlow,
    stills: SIGNED_IN_ROUTES.map((r) => r.route),
  },
};

/** Runs one flow in a recorded context; returns its session and walkthrough. */
async function recordFlow(run, browser, site, slug) {
  const flow = FLOWS[slug];
  const rawDir = join(run.out, 'raw', slug);
  rmSync(rawDir, { recursive: true, force: true });
  const ctx = await newContext(browser, { ...VIDEO, site, recordDir: rawDir });
  const page = await ctx.newPage();
  const steps = [];
  const t0 = Date.now();
  const step = (text) => {
    steps.push({ at: Math.round((Date.now() - t0) / 100) / 10, text });
    run.log(`  ${slug}: ${text}`);
  };
  const snap = async (name, title) => {
    await assertMasked(page);
    const png = await page.screenshot({ type: 'png', caret: 'hide' });
    await run.queueShots({ group: 'flow', site: siteLabel(site), slug: `${slug}-${name}`, width: VIDEO.width, theme: 'light' }, { fold: png }, { page: 'docs/public/screenshots/store.md', siteUrl: site, flow: slug, title, route: new URL(page.url()).host === new URL(site).host ? new URL(page.url()).pathname : new URL(page.url()).host });
  };
  let result;
  try {
    result = await flow.run({ page, site, step, snap });
    await page.waitForTimeout(1500);
  } catch (e) {
    await ctx.close().catch(() => {});
    rmSync(rawDir, { recursive: true, force: true }); // never keep a recording of a failed (possibly unmasked) state
    throw new Error(`${slug}: ${e.message.split('\n')[0]}`);
  }
  const storageState = await ctx.storageState();
  await ctx.close();
  const raw = readdirSync(rawDir).filter((f) => f.endsWith('.webm')).map((f) => join(rawDir, f))[0];
  const video = await finishRecording(run, raw, { slug, title: flow.title, proves: flow.proves, steps, site });
  rmSync(rawDir, { recursive: true, force: true });
  return { ...result, storageState, video };
}

/** The signed-in pages of a flow's session at every width and theme. */
async function signedInStills(run, browser, site, slug, session) {
  const label = siteLabel(site);
  const routes = SIGNED_IN_ROUTES.filter((r) => FLOWS[slug].stills.includes(r.route));
  for (const theme of run.args.themes ?? THEMES) {
    for (const width of run.args.widths ?? [390, 1440]) {
      const ctx = await newContext(browser, { ...VIEWPORTS[width], theme, site, storageState: session.storageState });
      const page = await ctx.newPage();
      for (const r of routes) {
        const url = r.route === '{order}' ? session.orderUrl : site + r.route;
        const res = await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
        await settle(page);
        if (/order|licences/.test(r.route)) await waitForKey(page).catch(() => run.note(`${slug} ${r.route}: no licence key appeared`));
        await page.waitForTimeout(1500);
        await scrollThrough(page);
        const signedOut = /auth\.buildbase\.app/.test(page.url());
        if (signedOut) {
          run.note(`${slug} ${r.route}: the saved session was not accepted (sent to sign-in); skipped`);
          continue;
        }
        const pngs = await shoot(page);
        await run.queueShots(
          { group: 'signed-in', site: label, slug: `${slug}-${r.slug ?? routeSlug(r.route)}`, width, theme },
          pngs,
          { page: 'docs/public/screenshots/store.md', siteUrl: site, flow: slug, route: r.route === '{order}' ? '/order?id=…' : r.route, title: r.title, status: res?.status() ?? 0 }
        );
        run.log(`  ${slug} ${theme} ${width} ${r.route} → ${res?.status()}`);
      }
      await ctx.close();
      await run.flush();
    }
  }
}

export async function captureFlows(run, site) {
  assertTestSite(site);
  if (run.args.dryRun) {
    for (const [slug, f] of Object.entries(FLOWS)) run.log(`flows: would record "${f.title}" on ${site} (fresh +test account${slug === 'commercial-purchase' ? ', Stripe test card' : ''}) and capture ${f.stills.length} signed-in pages × widths × themes`);
    return;
  }
  const browser = await launch();
  try {
    for (const slug of Object.keys(FLOWS)) {
      run.log(`flows: ${FLOWS[slug].title}`);
      const session = await recordFlow(run, browser, site, slug);
      await run.flush();
      await signedInStills(run, browser, site, slug, session);
    }
  } finally {
    await browser.close();
  }
}
