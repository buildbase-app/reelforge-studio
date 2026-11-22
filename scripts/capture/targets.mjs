// What gets captured. Edit here to add a page, a width or a flow.

export const DEV_SITE = 'https://reelforge-dev.buildbase.app';
export const PROD_SITE = 'https://reelforge.buildbase.app';

/** Stills at a phone and a desktop width (CSS px); captured at deviceScaleFactor 2. */
export const VIEWPORTS = {
  390: { width: 390, height: 844, label: 'Phone (390 px)' },
  1440: { width: 1440, height: 900, label: 'Desktop (1440 px)' },
};
export const THEMES = ['light', 'dark'];

/**
 * Store pages. `optional`: skipped (and noted) when the site answers 404,
 * for pages that are not deployed everywhere yet. `expect`: the status the
 * page should answer. `emptyWhen`: text that marks an empty state worth a
 * note (and a re-capture later). Routes found in /sitemap.xml are added.
 */
export const STORE_ROUTES = [
  { route: '/', title: 'Home' },
  { route: '/pricing', title: 'Pricing' },
  { route: '/agents', title: 'Connect your agent' },
  { route: '/docs', title: 'Docs', emptyWhen: /could not be loaded on this server/i, emptyNote: 'docs content not loaded (no content-reader key on the Worker, #93)' },
  { route: '/docs/start/quick-start', title: 'Docs: Quick start', emptyNote: 'doc page not served yet (#93)' },
  { route: '/docs/install/docker', title: 'Docs: Docker install', emptyNote: 'doc page not served yet (#93)' },
  { route: '/docs/mcp/tools', title: 'Docs: MCP tools', emptyNote: 'doc page not served yet (#93)' },
  { route: '/blog', title: 'Blog', emptyWhen: /no posts|nothing (here|yet)|could not be loaded/i, emptyNote: 'no posts shown (blog content needs the content-reader key, #93)' },
  { route: '/changelog', title: 'Changelog', emptyWhen: /no (entries|posts|release)|could not be loaded/i, emptyNote: 'no entries shown (needs the content-reader key, #93)' },
  { route: '/help', title: 'Help' },
  { route: '/licence', title: 'Licence' },
  { route: '/privacy', title: 'Privacy' },
  { route: '/refund', title: 'Refund policy' },
  { route: '/terms', title: 'Terms' },
  { route: '/waitlist', title: 'Waitlist' },
  { route: '/contact', title: 'Contact' },
  { route: '/gallery', title: 'Gallery', optional: true, emptyNote: 'gallery not deployed on this site yet' },
  { route: '/this-page-does-not-exist', title: 'Not found (404)', expect: 404, slug: 'not-found' },
];

/** Signed-in pages captured after a flow, with the flow's session. `{order}` is the order page the flow reached. */
export const SIGNED_IN_ROUTES = [
  { route: '{order}', title: 'Order page with the licence key (masked)', slug: 'order' },
  { route: '/dashboard', title: 'Dashboard' },
  { route: '/dashboard/licences', title: 'Dashboard: licences (key masked)' },
  { route: '/dashboard/invoices', title: 'Dashboard: invoices' },
  { route: '/dashboard/profile', title: 'Dashboard: profile (email masked)' },
  { route: '/dashboard/settings', title: 'Dashboard: settings' },
  { route: '/dashboard/security', title: 'Dashboard: security' },
  { route: '/pricing', title: 'Pricing, signed in', slug: 'pricing-signed-in' },
];

/** Default sites, widths and themes per step. Production is captured in light only, for comparison. */
export function siteDefaults(site) {
  const prod = /\/\/reelforge\.buildbase\.app/.test(site);
  return { themes: prod ? ['light'] : THEMES, widths: [390, 1440] };
}
