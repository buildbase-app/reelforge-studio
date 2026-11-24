// Asset index for BRAND.md: file, size, where it is used, who uploads it.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './brand.mjs';

const RULES = [
  [/^src\/mark-(light|dark)\.svg$/, 'Master mark for 48 px and up, on light / dark', 'Design source'],
  [/^src\/mark-(ink|white)\.svg$/, 'One-colour mark (print, embossing, single-colour UI)', 'Design source'],
  [/^src\/mark-32\.svg$/, 'Mark for 24–40 px (pixel grid, 2 px stroke)', 'Design source'],
  [/^src\/mark-16\.svg$/, 'Mark for 16 px (pixel grid)', 'Design source'],
  [/^src\/icon\.svg$/, 'Theme-aware tab icon (source of web/icon.svg)', 'Design source'],
  [/^src\/app-tile\.svg$/, 'App tile, rounded (listings, launchers)', 'Design source'],
  [/^src\/app-tile-square\.svg$/, 'App tile, full bleed (platforms that mask)', 'Design source'],
  [/^src\/wordmark-/, 'Wordmark alone, outlined', 'Design source'],
  [/^src\/lockup-horizontal-/, 'Horizontal lockup: site header, docs, decks', 'Design source'],
  [/^src\/lockup-stacked-/, 'Stacked lockup: square spaces, splash screens', 'Design source'],
  [/^web\/favicon\.ico$/, 'Legacy favicon (16/32/48), bookmarks', 'Agent (site repo, `src/app/`)'],
  [/^web\/(icon|favicon)\.svg$/, 'Browser tab icon, follows OS theme', 'Agent (site repo, `src/app/icon.svg`)'],
  [/^web\/favicon-\d+x\d+\.png$/, 'PNG favicon fallback', 'Agent (site repo)'],
  [/^web\/apple-touch-icon\.png$/, 'iOS home screen (opaque)', 'Agent (site repo, `apple-icon.png`)'],
  [/^web\/android-chrome-/, 'Web app manifest icon, purpose "any"', 'Agent (site repo)'],
  [/^web\/maskable-/, 'Web app manifest icon, purpose "maskable"', 'Agent (site repo)'],
  [/^web\/mstile-/, 'Windows pinned tile, opaque `#191B1F` square (matches `TileColor`)', 'Agent (site repo)'],
  [/^web\/safari-pinned-tab\.svg$/, 'Safari pinned tab / Touch Bar (monochrome)', 'Agent (site repo)'],
  [/^web\/site\.webmanifest$/, 'Web app manifest (Next: `manifest.ts`)', 'Agent (site repo)'],
  [/^web\/browserconfig\.xml$/, 'Windows tile config', 'Agent (site repo)'],
  [/^web\/head-snippet\.html$/, 'Every `<head>` tag, for non-Next pages', 'Agent (site repo)'],
  [/^share\/og-image\.png$/, 'Open Graph default (Facebook, LinkedIn, Slack, Discord unfurls)', 'Agent (site repo, `opengraph-image.png`)'],
  [/^share\/og-image-dark\.png$/, 'Open Graph alternative for dark contexts', 'Agent (site repo)'],
  [/^share\/twitter-card\.png$/, 'X/Twitter `summary_large_image`', 'Agent (site repo, `twitter-image.png`)'],
  [/^share\/linkedin-share\.png$/, 'LinkedIn post image / link preview', 'Founder (posts)'],
  [/^share\/og-image-square\.png$/, 'Square unfurls (WhatsApp, Slack, some chats)', 'Agent (site repo)'],
  [/^github\/social-preview/, 'Repository social preview', 'Founder (repo Settings → Social preview)'],
  [/^github\/org-avatar/, 'GitHub organisation avatar', 'Founder (org settings)'],
  [/^github\/readme-banner-/, 'README header, `<picture>` light/dark', 'Agent (README PR)'],
  [/^social\/x-avatar/, 'X profile photo', 'Founder'],
  [/^social\/x-header/, 'X header', 'Founder'],
  [/^social\/linkedin-logo/, 'LinkedIn company page logo', 'Founder'],
  [/^social\/linkedin-cover-1512/, 'LinkedIn company cover (current help-page size)', 'Founder'],
  [/^social\/linkedin-cover-1128/, 'LinkedIn company cover (older size, same ratio)', 'Founder'],
  [/^social\/youtube-channel-icon/, 'YouTube profile picture', 'Founder'],
  [/^social\/youtube-banner/, 'YouTube banner (content in TV/desktop/mobile safe area)', 'Founder'],
  [/^social\/instagram-threads/, 'Instagram and Threads avatar', 'Founder'],
  [/^social\/tiktok/, 'TikTok avatar', 'Founder'],
  [/^social\/facebook-profile/, 'Facebook page profile picture', 'Founder'],
  [/^social\/facebook-cover/, 'Facebook page cover', 'Founder'],
  [/^social\/discord-server-icon/, 'Discord server icon', 'Founder (server settings)'],
  [/^social\/discord-server-banner/, 'Discord server banner (boost level 2)', 'Founder'],
  [/^social\/bluesky-avatar/, 'Bluesky avatar', 'Founder'],
  [/^social\/bluesky-banner/, 'Bluesky banner', 'Founder'],
  [/^social\/producthunt-thumbnail/, 'Product Hunt thumbnail', 'Founder'],
  [/^social\/producthunt-gallery/, 'Product Hunt gallery image', 'Founder'],
  [/^social\/reddit-avatar/, 'Reddit community or profile avatar', 'Founder'],
  [/^social\/reddit-banner/, 'Reddit community banner', 'Founder'],
  [/^social\/mastodon-avatar/, 'Mastodon avatar', 'Founder'],
  [/^social\/mastodon-header/, 'Mastodon header', 'Founder'],
  [/^slack-discord-apps\/slack-app-icon/, 'Slack app icon (Slack accepts 512–2000 px)', 'Founder or agent (api.slack.com app settings)'],
  [/^slack-discord-apps\/slack-workspace/, 'Slack workspace icon', 'Founder (workspace admin)'],
  [/^slack-discord-apps\/discord-app-icon/, 'Discord bot/app icon (shown as a circle)', 'Founder or agent (Discord developer portal)'],
  [/^slack-discord-apps\/github-app-logo/, 'GitHub App logo. Opaque, full bleed, no transparent padding: GitHub rounds the corners and shows it on the badge background colour, which should be `#191B1F`. Keep the mark inside the centre circle (it is: 62 % of the radius).', 'Founder (GitHub App settings)'],
  [/^listings\/dockerhub-logo/, 'Docker Hub repository logo', 'Founder (Docker Hub)'],
  [/^listings\/listing-icon/, 'npm, GitHub Marketplace and MCP directory icon (app tile)', 'Founder or agent (per directory)'],
  [/^listings\/google-business-logo/, 'Google Business Profile logo', 'Founder'],
  [/^listings\/google-business-cover/, 'Google Business Profile cover', 'Founder'],
  [/^listings\/directory-card/, 'Generic directory/listing card', 'Founder or agent'],
  [/^listings\/promo-tile/, 'Small promo tile (Chrome Web Store style)', 'Founder'],
  [/^business\/email-signature-300x80/, 'Email signature logo (white plate, survives dark mode)', 'Founder (mail client)'],
  [/^business\/email-signature-600x160/, 'Email signature logo @2x (display at 300×80)', 'Founder (mail client)'],
  [/^business\/letterhead-header\.svg$/, 'Letterhead header band, A4 width (210×36 mm)', 'Founder (docs, mail merge)'],
  [/^business\/letterhead-a4\.pdf$/, 'A4 letterhead page', 'Founder'],
  [/^business\/invoice-header\.svg$/, 'Invoice header band (210×58 mm)', 'Founder (billing tool)'],
  [/^business\/invoice-a4\.pdf$/, 'A4 invoice template', 'Founder (billing tool)'],
  [/^business\/business-card-us/, 'Business card, US 3.5×2 in, 3 mm bleed, crop marks; page 1 front, page 2 back', 'Founder (printer)'],
  [/^business\/business-card-eu/, 'Business card, EU 85×55 mm, 3 mm bleed, crop marks; page 1 front, page 2 back', 'Founder (printer)'],
  [/^business\/slide-title-/, 'Deck title slide template', 'Founder'],
  [/^business\/slide-section-/, 'Deck section slide template', 'Founder'],
  [/^business\/press-kit\.pdf$/, 'Press-kit one-pager', 'Founder (press page, email)'],
];

export function assetIndex(A) {
  const sizes = Object.fromEntries(A.map((a) => [a.file, `${a.w}×${a.h}`]));
  const rows = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(path.join(ROOT, d)).sort()) {
      const rel = path.join(d, f);
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else {
        const rule = RULES.find(([re]) => re.test(rel));
        if (!rule) continue;
        let size = sizes[rel];
        if (!size && rel.endsWith('.svg')) size = 'vector';
        if (!size && rel.endsWith('.pdf')) size = rel.includes('card-us') ? '3.5×2 in + bleed' : rel.includes('card-eu') ? '85×55 mm + bleed' : 'A4';
        if (!size && rel.endsWith('.ico')) size = '16, 32, 48';
        if (!size) size = '—';
        rows.push(`| \`${rel}\` | ${size} | ${rule[1]} | ${rule[2]} |`);
      }
    }
  };
  for (const d of ['src', 'web', 'share', 'github', 'social', 'slack-discord-apps', 'listings', 'business']) walk(d);
  return ['| File | Size | Where it is used | Who uploads it |', '| --- | --- | --- | --- |', ...rows].join('\n');
}
