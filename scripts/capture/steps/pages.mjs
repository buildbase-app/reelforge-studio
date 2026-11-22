// Every public store page, at each width and theme: full page + fold crop.

import { launch, newContext, scrollThrough, settle, shoot } from '../browser.mjs';
import { routeSlug, siteLabel } from '../lib.mjs';
import { STORE_ROUTES, VIEWPORTS, siteDefaults } from '../targets.mjs';

/** The route list: STORE_ROUTES plus any path in the site's sitemap not listed yet. */
export async function discoverRoutes(site, { fetchImpl = fetch } = {}) {
  const routes = [...STORE_ROUTES];
  try {
    const res = await fetchImpl(`${site}/sitemap.xml`);
    if (res.ok) {
      const xml = await res.text();
      for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        const path = new URL(m[1]).pathname.replace(/\/$/, '') || '/';
        if (!routes.some((r) => r.route === path)) routes.push({ route: path, title: path, fromSitemap: true });
      }
    }
  } catch {
    // No sitemap: the fixed list is enough.
  }
  return routes;
}

export function planPages(site, args, routes) {
  const d = siteDefaults(site);
  const themes = args.themes ?? d.themes;
  const widths = args.widths ?? d.widths;
  const picked = args.routes ? routes.filter((r) => args.routes.includes(r.route)) : routes;
  return { themes, widths, routes: picked, states: themes.length * widths.length * picked.length };
}

export async function capturePages(run, sites) {
  for (const site of sites) {
    const routes = await discoverRoutes(site);
    const plan = planPages(site, run.args, routes);
    const label = siteLabel(site);
    run.log(`pages: ${site} — ${plan.routes.length} routes × ${plan.widths.length} widths × ${plan.themes.length} themes = ${plan.states} states`);
    if (run.args.dryRun) {
      for (const r of plan.routes) run.log(`  would capture ${r.route}${r.optional ? ' (if deployed)' : ''}`);
      continue;
    }
    const status = new Map();
    const browser = await launch();
    try {
      for (const theme of plan.themes) {
        for (const width of plan.widths) {
          const vp = VIEWPORTS[width] ?? { width, height: Math.round(width * 0.625) };
          const ctx = await newContext(browser, { ...vp, theme, site });
          const page = await ctx.newPage();
          for (const r of plan.routes) {
            if (status.get(r.route) === 'skip') continue;
            const res = await page.goto(site + r.route, { waitUntil: 'load', timeout: 60_000 }).catch((e) => ({ status: () => 0, error: e }));
            const code = res?.status?.() ?? 0;
            if (r.optional && code === 404) {
              status.set(r.route, 'skip');
              run.skip(`${label} ${r.route}`, `answers 404 (${r.emptyNote ?? 'not deployed'})`);
              continue;
            }
            await settle(page);
            await scrollThrough(page);
            await settle(page, { idleMs: 5000 });
            const text = await page.innerText('main').catch(() => '');
            let note = null;
            if ((r.expect ?? 200) !== code) note = `answered ${code}${r.emptyNote ? `: ${r.emptyNote}` : ''}`;
            else if (r.emptyWhen?.test(text)) note = r.emptyNote ?? 'empty state';
            if (note && !status.has(r.route)) run.note(`${label} ${r.route}: ${note}`);
            status.set(r.route, 'done');
            const pngs = await shoot(page);
            await run.queueShots(
              { group: 'store', site: label, slug: r.slug ?? routeSlug(r.route), width, theme },
              pngs,
              { page: 'docs/public/screenshots/store.md', siteUrl: site, route: r.route, title: r.title, status: code, note }
            );
            run.log(`  ${label} ${theme} ${width} ${r.route} → ${code}${note ? ` (${note})` : ''}`);
          }
          await ctx.close();
          await run.flush();
        }
      }
    } finally {
      await browser.close();
    }
  }
}
