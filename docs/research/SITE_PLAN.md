# ReelForge public site: visibility, design and BuildBase showcase plan

**Prepared:** 2026-11-21 (Sat). **Site:** https://reelforge.buildbase.app (Next.js 16.4 on Cloudflare Workers via OpenNext, D1, `@buildbase/sdk` ^1.8). **Code:** `/home/user/reelforge-selling-public-site`, branch `claude/eloquent-wright-tm3cs7` (HEAD `9d52424`, "Buy flow from BuildBase items").
**Builds on:** `/tmp/claude-0/-home-user/91c022dd-328d-5abd-9833-cfc66824b3fd/scratchpad/design-research/BRIEF.md`. Its homepage wireframe (§3), pricing/buy flow (§4), tokens (§5) and banned claims (§7) still apply. This plan doesn't repeat them. It adds the Apple-pattern layer, the BuildBase mapping, SEO/AI-search, the hackathon reality check and a set of issues ready to file.
**Status:** Plan only. Nothing here is implemented. All repositories were left untouched.

---

## 0. Read this first: five findings that change the plan

1. **Ship or Die has no judges. The winner is whoever has the most verified profit.** The official rules (https://www.ship-or-die.com/100k-hackathon/rules, read 2026-11-21) say:
   - **Ranking:** "Profit = money received − refunds − chargebacks − payment fees − ad spend". It is verified through TrustMRR and checked by hand. There is no public voting, no demo score and no design score.
   - **Window:** **Nov 16 13:00 UTC → Dec 16 13:00 UTC**. The brief's "closing call Dec 16 14:00 UTC" is an hour later than the rules' cut-off, so plan every sale to land before **13:00 UTC**.
   - **Ad spend** includes affiliate and referral payouts, paid directory placements and sponsored posts. All of it is deducted.
   - **Cheating includes** "asking your audience to buy to help you win", self-purchases or purchases by friends, and selling below cost.
   - **Ineligible:** "agencies, consulting, client services". The paid install service is therefore probably **not** counted, so ask the organisers before relying on it.
   - **What this means:** "winning" = real sales by Dec 16 13:00 UTC. Design polish and SEO matter only to the extent they convert visitors in the next 25 days. Programmatic SEO will barely pay off inside the window (new domain, weeks to index). It is an M2/M3 investment, and we should say so honestly.
2. **The real blocker is live selling, not Stripe Connect.** The BuildBase docs say: "Selling does not need to be turned on, and **no Connect setup is needed for your own store**" (https://docs.buildbase.app/billing/selling#turn-it-on). Live money then needs three things:
   - the app on BuildBase's **live-selling pilot list**; otherwise checkout returns `403 LIVE_SELLING_NOT_ALLOWED`;
   - once the pilot ends, a Grow/Scale plan;
   - TrustMRR connected to the **same Stripe account** the own store charges. Own-store orders are "charged on your own Stripe account … with no transfer and no fee".

   STATUS says test selling is "blocked on Stripe Connect". Re-test the **own-store** path in the dev environment (`fsyqdskf`) before waiting on Connect. Ask BuildBase today to add the production org (`6b01478bb42d2c444e99fcd8`) to the pilot.
3. **The BuildBase docs contradict themselves on licence keys.** In https://docs.buildbase.app/billing/orders:
   - the intro lists "files to download and license keys" as deliverable;
   - the same page later says: "**License keys, bundles and transfers are not delivered yet: checkout refuses an option that includes one** (`CHECKOUT_REFUSED`, problem `benefit_not_delivered`)";
   - meanwhile `commerce.licenses.validate/activate/deactivate` exist in the server SDK (https://docs.buildbase.app/server-sdk/commerce).

   **Next step:** test a `license_key` benefit in the dev environment first. If checkout refuses it, fall back to a `webhook_only` benefit plus our own key issuing on `grant.created`, stored in D1.
4. **The positioning has to change to match the delivery model.**
   - **Decided model:** a locked Docker image plus a licence key.
   - **Where the site still assumes source code:** `siteConfig.description`, the hero copy, `llms.txt` and BRIEF §0/§3. Lines such as "you get the source code and the templates" or "templates are code you own" must go.
   - **Replacement claims that are true today:** your agent decides every scene and its timing; four engines; agent-written HTML and HyperFrames scenes are accepted (D-019); it runs on your hardware; pay once; every render is ffprobe-checked.
   - **Outdated descriptions:** the current site text still says "storyboard → Remotion and Motion Canvas", which predates REST/MCP (D-014) and the HTML and HyperFrames engines.
5. **BuildBase can't host the video, so video goes to R2.**
   - BuildBase **assets accept images only**: JPEG, PNG, GIF, WebP, SVG; ≤100 MB direct; no transforms; no AVIF (https://docs.buildbase.app/assets/overview).
   - BuildBase **content bodies are Markdown, not HTML** (https://docs.buildbase.app/content/delivering-content#what-a-read-returns). Yet `src/components/help/help-center.tsx` injects `policy.content` as HTML with a regex sanitiser. That is a rendering bug and a weak XSS filter.
   - **Media:** reels live in an R2 bucket on a `buildbase.app` subdomain.
   - **Metadata:** BuildBase Collections hold it, which keeps the showcase story.

---

## A. Site map

Legend for "Powered by":
- **BB** = BuildBase module (SDK hook or component in `code`).
- **R2** = Cloudflare R2.
- **Local** = repo code or MDX.
- **Exists?** = whether the route is in the store today.

| Route | Purpose | Primary CTA | Powered by | Exists? | Milestone |
| --- | --- | --- | --- | --- | --- |
| `/` | Product page. Real renders first; Apple-style story (§B.2) | **Buy** (when an item is published) / **Join waitlist** | BB selling (`usePublishedItems`, server-side read for SEO), BB Collections `gallery`, BB FAQs, BB content blocks (announcement), BB Analytics goals, R2 video | yes (hero + pricing only) | M1 rebuild |
| `/gallery` | Every reel rendered by ReelForge, with its manifest and agent prompt. Filters: template / engine / theme | Copy agent prompt → Buy | BB Collections `gallery` + R2; `ItemList` + `VideoObject` JSON-LD | no | M1 (grid on home), M2 page |
| `/gallery/[slug]` | One reel: video, manifest JSON, prompt, tools called, render time + hardware + version + date | Copy prompt / Buy | BB Collection record; `VideoObject` | no | M2 |
| `/agents` | "Connect your agent" page: tabs for Claude Code, Codex, generic MCP and REST (Cursor once tested); prompt cookbook; tool list | Buy / Read docs | Local snippets + BB Docs excerpts; `WebMcpTools` (site's own read-only tools) | no | M2 |
| `/agents/[client]` | Programmatic page per **tested** client (claude-code, codex). Untested clients don't get a page | Buy | BB Collection `agent-clients` (status field) | no | M2 |
| `/tech-specs` | Apple-style spec sheet with footnotes (§B.4) | Buy | BB content block per spec group? No: a typed BB Collection `specs` so numbers stay in one place; footnotes BB rich content | no | M2 |
| `/compare` | (a) tier comparison, (b) own-vs-rent calculator, (c) engine comparison | Buy {tier} | BB selling items (tier rows), BB Collection `saas-presets` (dated competitor prices) | no | M2 |
| `/pricing` | Tiers from BB items, "what you still pay for", licence summary, pricing FAQ | **Buy {tier} – $X** (`<BuyButton>`) | BB selling: `usePublishedItems({ seller: { type: 'org' } })`, `<BuyButton coupons>`, guest checkout; BB FAQs `pricing-faq` | yes (catalog) | M1 polish |
| `/order` | Post-checkout: status, download, licence key, 3-step quick start | Copy key → install docs | BB `useOrderByToken`, `useMyOrder({ waitForPayment })`, `useHoldings`, `<HoldingFiles>`, `<HoldingKeys>` (or own key API, finding 3) | yes | M1 verify |
| `/dashboard/licences` | Buyer's keys, releases, downloads | Download latest | BB `useHoldings`, `useReleases`, `<HoldingFiles>` | yes | M1 verify |
| `/dashboard/*` (invoices, security, notifications, inbox, profile) | Account | — | BB `useInvoice`, `<Sessions>`, `<Devices>`, `<ConnectedAgents>`, `<NotificationInbox>`, `usePushNotifications` | yes | — |
| `/docs` + `/docs/[...path]` | ReelForge docs: install (Docker), quick start, REST reference, MCP tool reference, manifest v0.2, themes/templates, agent cookbook, troubleshooting, privacy and egress | Buy / copy snippet | **BB Docs** (`content.docs.tree()`, `content.docs.byPath()`), Markdown twins, `TechArticle` JSON-LD | partial (`/help` shows a docs browser for folder `getting-started`) | M2 |
| `/docs/api` | REST `/v1` reference (+ link to the studio's OpenAPI once exposed) | — | BB Docs folder `api` | no | M2 |
| `/templates` + `/templates/[slug]` | Template catalog (4 today: `kinetic-title`, `animated-explainer`, `html-title`, `hyperframes-title`), with props, duration range, engine, sample render | Copy prompt | BB Collection `templates` + R2 | no | M2 |
| `/engines/[slug]` | Remotion / Motion Canvas / HTML / HyperFrames: what each is good at, licence, fees, sample | Buy | BB Collection `engines` | no | M2 |
| `/use-cases/[slug]` | Developers, agencies, automators (n8n/cron), faceless-channel operators, launch/changelog reels | Buy | BB Collection `use-cases` | no | M2 |
| `/alternatives/[slug]` | Honest "X alternative (self-hosted)" pages for **generation** tools only (revid, invideo, Pictory, Creatify). Each says when the SaaS is the better choice | Calculator → Buy | BB Collection `alternatives` (dated, sourced fields) | no | M2 |
| `/blog`, `/blog/[slug]` | Guides, build log, launch posts | Waitlist / Buy | today: Local MDX (contentlayer) → **BB Blogs** | yes (MDX) | M2 migrate |
| `/changelog`, `/changelog/[slug]` | Release notes (studio + store) | Buy / update | today: Local MDX → **BB Blogs folder `changelog`** (BuildBase has no changelog module) | yes (MDX) | M2 |
| `/help` | FAQ, refund policy block, help docs | Contact | BB FAQs (collection now `demo-help` → rename `store-faq`), BB rich content `refund-policy`, BB Docs | yes | M1 tidy |
| `/feedback` | Feature requests and template requests; public list of requests with status | Submit | **BB Forms** (custom form via `/api/forms/public/:orgId/:formId/fields`, captcha) → records in BB Collection; BB Workflows `form.submitted` → email/Slack. BuildBase has no voting module | no | M2 |
| `/services` | Install for me / deploy to my cloud / custom template: scope, turnaround, price | Request (form) / Buy | BB selling item (service variant with `manual` benefit) + BB Forms intake | no | M2 (keep out of hackathon maths) |
| `/waitlist` | Pre-sale capture | Join | BB `<BetaForm>` (exists) → BB audience → BB email campaign on launch | yes | — |
| `/contact` | Contact | Send | BB Forms (replace whatever the page uses now) | yes | M2 |
| `/built-with-buildbase` | Case study: every BB feature on this site, with live proof and the org blueprint | Visit buildbase.app (`<BuildBaseBadge refCode>`) | everything; BB blueprint export | no | M2 |
| `/build-log` (or `/open`) | Public, honest numbers: renders made for this site, changelog cadence, TrustMRR listing link. **No** "buy to help us win" | Buy | BB Analytics (manual numbers), TrustMRR embed/link | no | M2 (optional) |
| `/licence`, `/refund`, `/privacy`, `/terms` | Legal: **drafts**, marked as such | — | Local MDX today; option: BB rich content blocks so the founder edits without a deploy | yes (drafts) | founder |
| `/llms.txt`, `/llms-full.txt`, `/.well-known/*`, `/auth.md`, `/openapi.json`, `/security.txt`, `/api/mcp` | Agent discovery and the store MCP server | — | BB `createAgentStack` (exists) | yes | M1 content update |
| `/sitemap.xml`, `/robots.txt` | Crawl control | — | today: `next-sitemap` from MDX files at build. Plan: `app/sitemap.ts` reading BB content + collections; robots via `agent.serveAgentPath` with `contentSignals` | yes | M1/M2 |
| `/*.md` twins | Markdown version of every marketing page for agents | — | `markdownRewritePath` from `@buildbase/sdk` (https://docs.buildbase.app/agents/agent-ready#3-answer-agents-in-markdown) | blog/changelog only | M2 |
| `media.reelforge.buildbase.app/*` | Reels, posters, OG video | — | R2 public bucket on a custom domain (same Cloudflare account/zone) | no | M1 |

**Navigation:**
- **Global header:** Gallery · Agents · Docs · Pricing · Changelog · [Sign in] · [Buy/Join].
- **Product pages** also get a sticky local nav (§B.2.0).
- **Footer additions:** Tech specs, Compare, Templates, Engines, Use cases, Alternatives, Feedback, Built with BuildBase, llms.txt.

---

## B. Apple-pattern design system and page specs

**Rule:**
- **Use Apple's patterns only:** a product-first hero, sticky local nav, short headline + one line + big media, scroll-told sections, numbered footnotes on every number, a spec sheet and compare columns.
- **Never Apple's assets:** no SF Pro, no product imagery or icons, no "Pro/Max/Ultra" naming, no Apple phrasing, no white-on-black "Apple keynote" pastiche, no device mock-ups that copy iPhone hardware. The phone frame is a generic rounded rectangle.

Tokens stay as BRIEF §5: dark-first `#0b0b14`, pink `#ff3d71` with dark text on it, signal `#00d1b2` for "Included/verified", Geist Sans/Mono.

### B.1 Design system additions (on top of BRIEF §5)

| Element | Spec |
| --- | --- |
| Grid | 12-col, `max-w-[1200px]` content, `max-w-[980px]` for reading text, edge-to-edge media bands. Gutter 16px mobile / 24px desktop |
| Section rhythm | One idea per section. `py-24 md:py-40` on story sections (more air than BRIEF's `py-20/28`). Never two dense sections back to back |
| Display type | H1 `clamp(2.75rem, 7vw, 6rem)`, weight 700, `tracking-[-0.035em]`, `leading-[1.02]`. Section headline `clamp(2rem, 5vw, 4rem)` w600. "Eyebrow" 14px w600 in `--primary`. Body 17–21px, `text-pretty`, max 60ch |
| Headline formula | ≤ 7 words + one sentence of ≤ 20 words + one media block. A number appears only with a footnote marker (e.g. `¹`) |
| Colour | Restrained: 90% neutral. Pink only for the primary CTA and one accent per section. Teal only for verified/included states |
| Media frames | Phone frame: `aspect-[9/19.5]`, `rounded-[2.75rem]`, 10px `--card` border, inner `rounded-[2.1rem]`; drop shadow `0 40px 120px -40px rgb(255 61 113 / 0.35)`. Desktop "window" frame for terminal/JSON: 12px radius, 1px `--border`, no fake traffic lights |
| Buttons | Primary pill `h-11 px-6 rounded-full` pink with dark text; secondary = text link with `›` chevron ("Watch the film ›"). Max one primary per viewport |
| Footnotes | Every number links to `#fn-N`. A footnotes block above the footer lists hardware, ReelForge version, date measured, and the source file (e.g. `render-manifest.json`). This is the Apple pattern **and** our honesty rule (BRIEF §7.16) |
| Motion tokens | `--ease-out: cubic-bezier(.22,1,.36,1)`; durations 200 / 400 / 700 ms; scroll-linked effects use only `transform` and `opacity` |
| Contrast | AA everywhere: muted text `#c9c9d6` on `#0b0b14` (≈11:1); pink buttons use dark text (white on pink is ≈3.4:1, fails). Check any text over video with a 40% scrim |
| Focus | 2px ring `--ring` with 2px offset; visible in both themes |

### B.2 Home page, section by section

The order adapts BRIEF §3. Each row gives layout / motion / media / copy direction.

| # | Section | Layout | Motion | Media | Copy direction (not final copy) |
| --- | --- | --- | --- | --- | --- |
| 0 | **Sticky local nav** | 52px bar under the global header (collapses into it on scroll). Left: "ReelForge". Middle (desktop): Overview · Gallery · Agents · Tech specs · Compare. Right: price chip + pill "Buy" (or "Join waitlist") | Background goes from transparent to `bg-background/72 backdrop-blur-xl saturate-150` after 40px (CSS scroll-driven, §B.6) | — | Price chip text comes from the BuildBase item ("from $X"). Never hard-coded |
| 1 | **Hero** | `min-h-[100svh]`, centred. H1 (2 lines) → one-line sub → CTAs → phone frame below the fold line, partly visible (pulls the scroll) | H1/sub fade-up 400ms on load (CSS, not JS). As you scroll, the phone scales 0.92→1 and rises 40px (`animation-timeline: view()`). Reduced motion: static | Phone plays 3 real reels (6–8 s each, muted loop, cross-fade 400ms). Poster AVIF is the LCP image candidate | Angle: "own the factory". H1 direction: *Your agent directs. Your server renders.* Sub: an AI agent (Claude Code, Codex, any MCP client once tested) plans every scene and its timing; ReelForge renders it on your machine; pay once. Reassurance line: "One-time licence · Self-hosted Docker image · No per-video fees to ReelForge¹". Caption under phone: "Rendered by ReelForge v0.x on {hardware} in {N} s²" |
| 2 | **The film** | Full-bleed 16:9 band, large play button over a poster | Click-to-play only (no autoplay with sound). Loads the MP4 on click | 60–75 s launch film (§B.7) | "Watch an agent make a reel, start to finish." State which parts were rendered by ReelForge and which are screen recording |
| 3 | **Highlights rail** | Horizontal scroll-snap rail of 5 cards (full-height on mobile, 2.5 visible on desktop), dots + pause button | Each card's clip plays only while ≥60% visible (IntersectionObserver). `scroll-snap-type: x mandatory` | 5 short clips from real renders | Five cards with one line each: agent sets scene timing · four engines, one MP4 · every render ffprobe-checked · runs on your box, offline after setup³ · pay once |
| 4 | **Sticky story: how it works** | Two columns: left sticky (`position: sticky; top: 20vh`) device/terminal panel; right four steps, each `min-h-[80vh]` | The active step swaps the sticky panel content with a cross-fade (IntersectionObserver sets `data-step`, CSS does the rest). Step 3 shows a progress bar driven by real job state names | Step 1 brief text → 2 manifest JSON (Geist Mono, syntax-coloured) → 3 job `queued→running→succeeded` → 4 MP4 + ffprobe card (resolution, frames, codec, audio) | Tool names in mono under each step: `create_project`, `add_scene`, `validate_project`, `render_project`, `get_render_output`. Mobile: the panel stacks above each step, not sticky |
| 5 | **Connect your agent** | Dark window frame with tabs: Claude Code · Codex · Any MCP client · REST | Tab change = 200ms fade; copy button with "Copied" state | Code blocks from BRIEF §3.2 (placeholders only) | "Paste one line. Ask for a reel." Mention scoped keys (`read`, `write`, `render`, `admin`), stored hashed. Cursor tab only after a recorded test |
| 6 | **Four engines** | 2×2 tiles (1 column on mobile), each with a 3 s loop and an "Included" badge | Tiles reveal with a 12px rise as they enter (scroll-driven) | Same manifest rendered by each engine's template | Remotion (React), Motion Canvas (generator scenes, our headless harness, D-008), HTML/CSS (agent-written, sandboxed), HyperFrames (local renderer, telemetry off). Footnote: Remotion licence for teams over 3 |
| 7 | **Gallery** | Grid of 9:16 cards, 2 col mobile / 4 desktop, filter chips | Hover/tap plays; card → `/gallery/[slug]` (View Transition morph, §B.6) | From BB Collection `gallery` + R2 | "Every clip here was rendered by ReelForge from the manifest shown." Buttons: Copy prompt · Copy manifest |
| 8 | **Numbers band** | 3–4 huge numerals with one-line labels | Count-up **off** (Apple doesn't need it; it hurts INP and honesty). Plain fade-in | — | Only measurable, footnoted facts: "4 engines", "41 MCP tools · every REST route has one⁴", "1080×1920 · 30 fps · H.264 + AAC", "{N} s for a {M} s reel on {hardware}²" |
| 9 | **Privacy and control** | Two columns: "Stays on your machine" / "Leaves only if you set it up" | — | Simple line icons (lucide) | Name every egress (BRIEF §3 row 12). No compliance badges |
| 10 | **Which ReelForge is right for you?** | 3 tier columns (Apple "compare models" pattern): name, price (from BB), seats, client brands, updates, support; "Compare all ›" → `/compare` | — | — | Same code in every tier; tiers differ by seats/brands/updates/support (BRIEF §4). Price inside the CTA |
| 11 | **FAQ** | Accordion, 8–10 Qs | `<details>` native, no JS | — | From BB FAQs `home-faq`; the same text goes into `llms-full.txt` |
| 12 | **Final CTA** | Full-bleed dark band, one reel looping behind at 30% opacity | Video paused when off-screen | One reel | Repeat the angle, primary CTA and reassurance line |
| 13 | **Footnotes** | Small type, numbered list | — | — | ¹ Remotion licence for companies over 3 people and your TTS provider bill you directly. ² Hardware, version, date, source. ³ Chrome Headless Shell download and TTS caveats. ⁴ Parity test file |

### B.3 Pricing page (Apple "buy" page pattern)

The order follows BRIEF §4. Layout specifics:
- **Step layout:** "1. Choose a licence" (3 cards, Studio highlighted) → "2. Add a service (optional)" → "3. Checkout". This is a single page, not a wizard.
- **Sticky summary on desktop:** a right rail that shows the chosen tier, its price and `<BuyButton>` and stays visible while you scroll. On mobile it becomes a bottom bar with the price and the Buy button.
- **Guest checkout:** turn on "Who can buy → guests" and pass `guest={{ name, email }}` to `<BuyButton>` from a 2-field form. This removes the sign-in step that the current "Sign in to buy" button forces. Guests then open `/order` with `?order=&token=` (already coded).
- **"What you'll still pay for" box:** keep `RemotionNotice`. Add TTS and compute.
- **Prices in the HTML:** fetch published items on the server with the server client (`commerce.items.list`, an app-server key with a `marketplace_items` read role) or the public items endpoint. Revalidate on the `item.*` webhook.
  - Today `usePublishedItems` fetches in the browser, so search engines and AI crawlers see no price and we can't emit `Offer` JSON-LD.
- **Footnotes:** what "1 year of updates" means; what happens after updates end; the refund window.

### B.4 Tech specs page

**Layout:** two-column rows separated by hairlines. Label on the left (`w-1/4`); values on the right in short lines, with footnotes. Sticky local nav as on home. A "Download as Markdown" link (`/tech-specs.md`) for agents.

| Group | Rows (only verified values; "Planned" shown greyed) |
| --- | --- |
| Output | 1080×1920, 30 fps, H.264 yuv420p, AAC 48 kHz stereo (always an audio track, D-012); exact frame counts (D-009); ffprobe + full decode check on every render |
| Engines | Remotion · Motion Canvas 3.17.2 with headless harness · HTML/CSS (sandboxed, no network) · HyperFrames (local renderer) |
| Templates and themes | 4 templates, 2 themes today (list them); agent-written HTML/HyperFrames scenes accepted; transitions: cut only |
| Agent interfaces | REST `/v1` · MCP over Streamable HTTP (stateless) · 41 tools · SSE job events · MCP guide resource and `make_reel` prompt |
| Security | Operator-created API keys, scopes `read/write/render/admin`, stored hashed; Host/Origin checks; signed 1-hour download links |
| Audio | Music, voice, SFX mixing. Ducking: **Planned**. Captions: **Planned** (stored, not rendered) |
| Providers | ElevenLabs TTS: **Bring your key**. Footnote: verified against a mock; live test pending. Avatars, stock, image generation: **Planned** |
| Render backends | Local: Included. Remotion Lambda: **Planned** (skeleton returns 501) |
| Storage | Local filesystem. S3-compatible: **Planned** |
| Requirements | Docker; tested on Linux x64, 4 vCPU / 15 GB. macOS, Windows/WSL, ARM: **untested** until tested |
| Network egress | TTS provider (if configured) · URLs you ask it to fetch (https only, SSRF-guarded) · none from ReelForge itself |
| Licences | Component licences + Remotion terms link; GSAP not bundled |
| In the box | Locked Docker image + compose, licence key, install docs, sample project, agent kit, updates for the tier's period, support channel |

### B.5 Compare page

- **Tiers:** Apple compare pattern. Up to 3 columns, each with a `<select>` for picking the tier. A sticky column header holds the name, price and Buy button. Row groups: licence, updates, support, delivery, refund.
- **Own vs rent calculator:** BRIEF §3.3, unchanged in substance. Competitor presets come from BB Collection `saas-presets` with the fields `name`, `plan`, `priceMonthly`, `sourceUrl`, `checkedOn`, `note`. The page prints "as listed on {checkedOn}". It must show the case where SaaS is cheaper. The calculator is a small client island, and the default result is server-rendered so it can be crawled.
- **Engines:** a matrix of the four engines covering strengths, authoring language, licence and fees, and best use.

### B.6 Performance budget and cheap motion on Next.js + Workers

**Budget, p75 on mobile (Moto G Power-class device, 4G), checked with Lighthouse CI and CrUX once traffic exists:**

| Metric | Budget | How |
| --- | --- | --- |
| LCP | ≤ 2.0 s | The LCP element is the H1 or the hero poster (AVIF ≤ 60 KB, `fetchpriority="high"`, `<link rel=preload>`), never the video. Home stays prerendered. Today it returns `x-nextjs-prerender: 1` / `x-opennext-cache: HIT`; keep it that way. Client islands are the only dynamic parts |
| INP | ≤ 150 ms | No scroll listeners; no count-ups; hydrate only islands (tabs, calculator, gallery filters, video controller) |
| CLS | ≤ 0.05 | Every media box has `aspect-ratio`; fonts via `next/font` with `adjustFontFallback`; the badge already ships width/height |
| JS (home, first load) | ≤ 150 KB gz | Measure with `npm run build:analyze`. Biggest lever: `SaaSOSProvider` + `@buildbase/sdk/css` on marketing routes. Option: render marketing pages with `<BuildBaseTracking analytics>` (https://docs.buildbase.app/tracking/overview#a-marketing-site-without-the-provider-tree) and a server-rendered price, and keep `SaaSOSProvider` for `/pricing`, `/order`, `/dashboard` and the sign-in button island |
| Hero video | ≤ 1.5 MB per clip; total transferred before interaction ≤ 2.5 MB | `preload="none"` except the first hero clip (`preload="metadata"`); AV1/VP9 WebM first, H.264 MP4 fallback; loops have no audio track (`-an`) |
| Card video | ≤ 800 KB | 720×1280, 6–8 s |
| Fonts | 2 files (Geist variable sans + mono subset) | `display: swap`, preload sans only |

**Scroll animation without JavaScript:**

```css
@media (prefers-reduced-motion: no-preference) {
  @supports (animation-timeline: view()) {
    .reveal {
      animation: rise linear both;
      animation-timeline: view();
      animation-range: entry 0% cover 30%;
    }
    .hero-phone {
      animation: phone-in linear both;
      animation-timeline: view();
      animation-range: entry 10% cover 50%;
    }
    .local-nav {
      animation: nav-solid linear both;
      animation-timeline: scroll(root);
      animation-range: 0 40px;
    }
  }
}
@keyframes rise { from { opacity: 0; transform: translateY(12px); } }
@keyframes phone-in { from { transform: translateY(40px) scale(.92); } }
@keyframes nav-solid { to { background: color-mix(in oklch, var(--background) 72%, transparent); backdrop-filter: blur(20px) saturate(1.5); } }
```

- **Fallback:** browsers without scroll-driven animations show the final state; there is no JS polyfill.
- **Sticky story:** `position: sticky` + one `IntersectionObserver` that sets `data-step` on the section; CSS cross-fades the panels with `opacity`/`transform` only.
- **Video controller:** one tiny client component.
  - `IntersectionObserver` with threshold 0.6 calls `play()`/`pause()`.
  - Videos never play under `prefers-reduced-motion`: show the poster + a play button.
  - Every autoplaying region has a visible pause button (WCAG 2.2.2).
  - A `document.visibilitychange` handler pauses all videos.
- **View Transitions:** turn on `experimental.viewTransition` in `next.config.ts` and wrap the gallery card media and the detail-page video in React `<ViewTransition name={slug}>`. Use them only for gallery card → detail and pricing tier select; navigation is instant without support. Test on Workers before relying on it, because the flag is experimental.
- **Images on Workers:**
  - `next/image` optimisation doesn't run on Workers by default.
  - Recommended: pre-generate AVIF/WebP/JPEG posters at gallery build time and serve them from R2 with `<picture>` and `srcset`.
  - Alternative: Cloudflare Image Transformations via a custom `loader`, which needs the zone setting turned on.
- **CSP changes needed in `src/proxy.ts`:**
  - Add `media-src 'self' https://media.reelforge.buildbase.app`. Today `media-src` falls back to `default-src 'self'`, so R2 video would be **blocked**.
  - Add `worker-src 'self'` for `push-sw.js`.
  - Don't embed YouTube iframes; link out instead. If one is ever needed, add `frame-src https://www.youtube-nocookie.com` and use a click-to-load facade.
  - Drop `'unsafe-eval'` once blog and changelog leave Contentlayer's client MDX runtime.
- **Also check:** live responses show `strict-transport-security: max-age=0`, while the code sets `max-age=31536000`. Something at the Cloudflare zone overrides it. Fix the zone setting deliberately; `preload` with `includeSubDomains` affects every `*.buildbase.app` host, so decide it with the BuildBase owner.

### B.7 Demo-video pipeline (renders made by ReelForge itself)

**Where media lives:** **R2**, because BuildBase assets reject video and AVIF.
- **Bucket:** `reelforge-media` in Cloudflare account `0109f7bce7af42ac8a88104d324efe4d`.
- **Domain:** custom domain `media.reelforge.buildbase.app`, which gives range requests and edge caching.
- **Metadata:** in **BB Collection `gallery`**, so the store reads it via `content.collections.data('gallery')` and refreshes on `collection.record_*` webhooks. The existing `/api/webhooks/content` route plus `createNextWebhookHandler` already revalidate the tags.
- **Posters:** can be **also** uploaded to BB assets (WebP) for blog/OG use. That's fine as a showcase, but keep R2 as the source.

**Steps:**
1. **Manifests.** In the studio, add `examples/gallery/*.json`: one per template × theme, plus 3 "story" reels (launch, changelog, listicle). Use a non-empty first frame, because DECISIONS §F found frame 0 empty and platform thumbnails need it.
2. **Render.** Add a `pnpm gallery` script that starts the server, then for each manifest calls REST: `POST /v1/projects` → render → `GET` the output + `render-manifest.json`. It writes `gallery/{id}/final.mp4` and `meta.json`:
   - `template`, `engine`, `theme`, `durationSeconds`, `renderMillis`;
   - `hardware` (CPU model, cores, RAM);
   - `reelforgeVersion`, `renderedAt`, `manifest`, `prompt`, `toolsCalled`.
3. **Transcode for web** (ffmpeg 6.1, which the studio already uses):
   ```bash
   ffmpeg -i final.mp4 -vf scale=720:-2 -c:v libx264 -profile:v high -crf 26 -preset slow -pix_fmt yuv420p -movflags +faststart -an web.mp4
   ffmpeg -i final.mp4 -vf scale=720:-2 -c:v libvpx-vp9 -crf 34 -b:v 0 -row-mt 1 -an web.vp9.webm
   ffmpeg -i final.mp4 -vf scale=720:-2 -c:v libsvtav1 -crf 38 -preset 6 -an web.av1.webm   # if libsvtav1 is present
   ffmpeg -ss 2.5 -i final.mp4 -frames:v 1 -vf scale=720:-2 poster.png && npx sharp-cli -i poster.png -o poster.avif && npx sharp-cli -i poster.png -o poster.jpg
   ```
   Keep the 1080×1920 **with audio** master for YouTube Shorts, TikTok and X uploads.
4. **Upload.** Use content-hashed names:
   ```bash
   wrangler r2 object put reelforge-media/gallery/{id}/{hash}.mp4 --file web.mp4 --content-type video/mp4 --cache-control "public, max-age=31536000, immutable" --remote
   ```
5. **Register.** Upsert the BB Collection record through the Records API (https://docs.buildbase.app/collections/records-api) with an org key from CI, or by hand in the console for the first ten.
6. **Show.** Home, gallery and the programmatic pages read the collection. `VideoObject` JSON-LD is generated from the same record.
7. **Distribute.** Upload the masters by hand to YouTube Shorts, X and LinkedIn (no auto-posting, BRIEF §6 #21). Each upload description links to `/gallery/{slug}?utm_source=youtube&utm_medium=short&utm_campaign=launch`.

**The 60–75 s launch film:** make it with ReelForge scenes (kinetic titles, HTML scenes that typeset the real manifest JSON and tool-call log, HyperFrames end card) plus one screen recording of Claude Code calling the MCP tools. The film's footnote states which parts were screen-recorded. Run time and hardware go in the caption.

---

## C. BuildBase showcase matrix

**Sources:**
- **Effort:** S ≤ ½ day, M 1–2 days, L 3–5 days.
- **"Today":** verified by grepping `src/` on 2026-11-21.
- **Docs:** pages on https://docs.buildbase.app.

| BB feature | Where on the site | SDK hook / component / server call | Console setup | Today | Effort | Notes / flags |
| --- | --- | --- | --- | --- | --- | --- |
| Sign-in (hosted, OAuth server) | Header, `/dashboard`, buy flow | `SaaSOSProvider`, `useSaaSAuth`, `/api/auth/*` routes | Sign-in client exists; add GitHub + Google social (`/authentication/social-providers`), Turnstile bot protection (`/authentication/bot-protection`) | **yes** | S | Developers expect GitHub sign-in |
| Own-store selling | `/pricing`, home, `/compare` | `usePublishedItems({ seller:{type:'org'} })`, `<BuyButton>`, server `commerce.items.list` | Billing → Credentials (Stripe keys); Selling → Settings → **Your own store** on; item type with "Your own store"; items Solo/Studio/Agency; "Order page" URL = `/order` (needed for receipts) | **code yes, no items** | M | No Connect needed for own store; **live needs the pilot** (`LIVE_SELLING_NOT_ALLOWED`) and later Grow/Scale (`/billing/selling`) |
| Guest checkout | `/pricing` | `<BuyButton guest={{name,email}}>`, `useOrderByToken`, `orderLinkFromUrl` | Selling → Settings → "Who can buy" → guests | /order handles tokens; pricing forces sign-in | S | Big conversion lever |
| Orders, order page | `/order`, `/dashboard` | `useMyOrder({waitForPayment})`, `useMyOrders`, `orderDisplayStatus`, `useHoldings` | — | **yes** | — | Verify with a test card in the dev environment |
| File releases (downloads) | `/order`, `/dashboard/licences` | `<HoldingFiles>`, `useReleases`, `useDownloadFile`; server `commerce.files/releases` | Release series `reelforge`, one release per version (≤ 20 files) | **UI yes** | M | Max file size isn't stated in the docs: **VERIFY** before planning to ship a `docker save` tarball. Alternative: a `link`/`manual` benefit with registry pull instructions plus per-buyer registry tokens issued on `grant.created` |
| Licence keys | `/order`, `/dashboard/licences`, image activation | `<HoldingKeys>`; server `commerce.licenses.validate/activate/deactivate` | `license_key` benefit (`activationLimit`, `expiresInDays`) | **UI yes** | M | **Docs say "not delivered yet"** (`benefit_not_delivered`). Test first; fallback `webhook_only` + own keys in D1 + `/api/licence/activate` |
| Coupons | `/pricing` | `<BuyButton coupons>` (renders `<CouponField>`), `couponCode` | Selling → Coupons → New coupon (start/end dates, uses) | no | S | Launch code only with a **real end date**. Lowers hackathon revenue per sale |
| Affiliates and referrals | `/affiliates` page, all pages (`?ref=`) | `captureReferral()` (`@buildbase/sdk/tracking`), `<AffiliateJoin>`, `<AffiliateDashboard>`, `<AffiliatePayoutSetup>` | Selling → Settings → Affiliates on; program (rate, window, hold, payout: PayPal/manual) | no | M | Commissions count as **ad spend** in the hackathon maths. Transfers need affiliates' Stripe accounts → use PayPal/manual. **M3** |
| Waitlist | `/waitlist`, hero pre-sale | `<BetaForm>` | User management → Beta users → settings and emails | **yes** | — | Don't switch sign-up access mode to "waitlist" (it would block buyers' accounts) |
| Forms | `/feedback`, `/contact`, `/services` intake | Public endpoints `/api/forms/public/:orgId/:formId[/fields]`, `_captcha` (`/forms/custom-forms`) | Forms → Create form on a collection; captcha + spam rules (`/forms/spam-protection`); "Collect subscribers" for newsletter | no | M | No token needed in the browser |
| Collections | gallery, templates, engines, use-cases, alternatives, specs, saas-presets, feature requests | `content.collections.data(slug)` (server); Records API for CI writes | Content → Collections → versions → promote live | no | M | Webhook `collection.record_*` revalidates |
| Blogs | `/blog` | `content.blogs.list/byPath/tags/authors` | Content → Blogs; SEO title/description/keywords fields per post | **no (local MDX)** | M | Bodies are Markdown → render server-side with remark/rehype + `rehype-sanitize` |
| Changelog | `/changelog` | `content.blogs.byPath('changelog/…')` | Blog folder `changelog` | no (MDX) | S | **No changelog module in BB**; a folder is the honest substitute |
| Docs | `/docs/[...path]` | `content.docs.tree()`, `content.docs.byPath()`, `docs.list` | Content → Docs; folders `start`, `install`, `api`, `mcp`, `cookbook`, `manifest`, `troubleshooting` | partial (`/help` reads folder `getting-started`) | L | Plan limits `max-docs-pages`, `max-docs-folders`, `max-folder-depth` (`/reference/plan-features-and-limits`) |
| FAQs | home, `/pricing`, `/help`, `/agents` | `content.faqs.questions(slug)` | FAQ collections `home-faq`, `pricing-faq`, `agents-faq`, `store-faq` | **yes** (collection `demo-help`, a leftover name) | S | Same text feeds `FAQPage` JSON-LD and `llms-full.txt` |
| Help centre | `/help` | FAQs + Docs + rich content | — | **yes** | S | No dedicated help-centre module; composed from the above |
| Testimonials | home (hidden until real) | `content.testimonials.list()` | Content → Testimonials | read, none exist | S | Real buyers only, with permission (BRIEF §7.8) |
| Content blocks (rich content) | Announcement bar, launch-price note, Remotion notice, legal drafts | `content.richContent.get(slug)` | Content → Content blocks | **yes** (`refund-policy`) | S | **Bug:** rendered as HTML today; bodies are Markdown |
| Reviews / ratings | — | — | — | — | — | **No reviews module in BB docs.** Don't emit `aggregateRating` |
| Feature requests / voting | `/feedback` | Forms + Collections (status field) | as above | no | M | **No voting module in BB**; show statuses, not vote counts |
| Assets | blog images, OG images, founder photo, posters (WebP) | `POST /api/assets`, console upload | Content → Assets (console uploads are private by default → make public) | no | S | **Images only**, no video/AVIF, no resizing → videos on R2 |
| Web analytics + revenue per source | Every page; console Analytics | Counts automatically under `SaaSOSProvider` (SDK ≥ 1.0); `trackGoal()` from `@buildbase/sdk/tracking`; `data-bb-goal` attributes | Settings → Analytics: confirm `reelforge.buildbase.app` is **tracked**, add extra params (`ref`) | provider yes; goals no | S | Goals: `waitlist_join`, `buy_click`, `checkout_started`, `copy_agent_snippet`, `film_play`, `docs_copy`. Revenue is credited to source automatically for SDK checkouts |
| Tracking tags + consent | site-wide | `tracking` prop (exists), `<CookieBanner>` (exists) | Tracking & tags | **yes** | — | Ship or Die verifier loads before consent (disclosed in privacy draft) |
| Email sender + receipts | Order receipt, waitlist confirm | automatic | Email → connect sender (`/email/connect-a-sender`) **on prod (none yet, STATUS §4)** | no | S | Without an order page **and** a sender, no receipts are sent |
| Email campaigns | Launch announcement to waitlist | — | Email → campaign, list = waitlist/audience, template with unsubscribe group (`/email/first-campaign`) | no | S | Biggest single launch-day lever. Never say "buy to help us win" |
| Notifications / inbox | `/dashboard/inbox`, release announcements | `<NotificationInbox>` (exists); server `notifications` | Notifications → custom event `release.published` | inbox yes | S | Notify buyers of new releases |
| Slack alerts | Founder's Slack | — | Notifications → Slack (`/notifications/slack`): `order.paid` | no | S | Live sales feed during launch |
| Workflows | form → email/Slack; `order.paid` → tag buyer, add to "customers" list | emit events from the server | Workflows → templates | no | S | |
| Short links | Channel links in bios | — | Links → create | no | S | Always on BuildBase's domain; may show a "Checking this link" step. Prefer UTM-tagged direct links; use short links only where length matters |
| i18n | — | `useTranslation` (SDK), next-intl (site) | — | **English only** (by decision) | — | 7 other message files hold starter copy: keep them out of `locales` and the sitemap. M3 |
| Agent readiness | `/llms.txt`, `/.well-known/*`, `/auth.md`, store MCP | `createAgentStack` (exists), `provideWebMcpTools` (exists), `markdownRewritePath`, `discovery.robots.contentSignals`, `npx @buildbase/sdk agent-ready check` | User management → Access → Authentication → Agent readiness | **yes** | S | Content is store-only today; add product facts and docs |
| Badge | Footer, case-study page | `<BuildBaseBadge variant refCode params>` | — | **yes** | S | Add `refCode` and `utm_campaign` so BuildBase can attribute visits |
| Blueprints | Case-study page + repo | `blueprint_export` / `npx @buildbase/sdk blueprint export` (`/blueprints/cli`) | — | no | S | Commit a blueprint (no secrets) so test→prod config is reproducible and visible |
| Feature flags | Preview new pages to staff | `<WhenUserFeatureEnabled slug>` | Users → Features | no | S | Optional |
| Deploy hooks | — | — | — | — | — | Only Vercel/Netlify/CF Pages/Render hooks. The store is a Worker deployed by GitHub Actions and reads content at runtime, so no hook is needed |
| Webhooks | `/api/webhooks/buildbase` (orders), `/api/webhooks/content` | `parseWebhookEvent`, `createNextWebhookHandler` | Settings → Webhooks | **yes** | — | Subscribe content + collection + `order.*`/`grant.*` events |
| SEO helpers / sitemap | — | `discovery.sitemap.urls` in the agent stack; blog SEO fields | — | — | — | **No SEO or sitemap module**; we build `app/sitemap.ts` ourselves |
| Environments | Test site on the production org's `development` environment (`fsyqdskf`), replacing the test org | `NEXT_PUBLIC_BUILDBASE_ENVIRONMENT` | — | (dev env) | — | saas-os/os#2737 (fixed 2026-11-21) |

---

## D. SEO and visibility plan

### D.1 Technical checklist

**Crawl and index**
- [ ] Verify the property in Google Search Console and Bing Webmaster Tools (`seoConfig.verification` is empty). Bing also feeds ChatGPT search and Copilot.
- [ ] Turn on **Crawler Hints (IndexNow)** in the Cloudflare zone, or ping IndexNow on content webhooks.
- [ ] Replace build-time `next-sitemap` with `app/sitemap.ts`, built from routes plus BB blogs/docs/collections, with real `lastmod` values. Exclude `/order`, `/dashboard`, and drafts.
  - Today the sitemap is derived from MDX files, so BB content will never appear in it.
- [ ] Serve `robots.txt` from `agent.serveAgentPath` with `contentSignals: { search: true, aiInput: true, aiTrain: <founder> }`.
  - The committed `public/robots.txt` currently names the **dev** host. The deploy regenerates it correctly, so live is fine, but it's a trap.
- [ ] Self-referencing canonical on every page via `buildMarketingMetadata`; no `?ref=`/`utm` variants indexed.
- [ ] `noindex` stays on reelforge-dev (it does today).
- [ ] Remove `hreflang` alternates for unserved locales (`locales = ['en']`).
- [ ] 404s for unknown `[slug]`s, not empty 200 pages (programmatic pages).

**Rendering**
- [ ] Every indexable page is server-rendered with its main content in the HTML, including **prices** (B.3) and gallery metadata.
- [ ] `/help` is `force-dynamic`. Switch it to ISR with tag revalidation; the content webhooks already exist.

**Metadata and media**
- [ ] A unique title (≤ 60 chars) and description (≤ 155 chars) per page.
- [ ] Per-page OG image from `/api/og` (already exists).
- [ ] `og:video` (MP4 on R2, `og:video:type`, width/height) on gallery and home, which unfurls in Discord, Slack and LinkedIn. `twitter:card=summary_large_image`. Set `seoConfig.social.twitter` and `sameAs` once accounts exist.

**Performance and accessibility**
- [ ] The budgets in B.6. Lighthouse CI in GitHub Actions on `/`, `/pricing`, `/gallery`, `/docs`.
- [ ] axe check in Playwright (an `e2e/` folder exists).
- [ ] Reduced-motion and keyboard paths tested.

**Security headers**
- [ ] Add `media-src` and `worker-src`.
- [ ] Fix the zone HSTS override.
- [ ] Drop `'unsafe-eval'` after the MDX migration.

**Content correctness**
- [ ] One source for every number (BB Collection `specs` or `facts`). Page, JSON-LD and `llms.txt` all read it, avoiding the FAQ-vs-schema mismatch BRIEF flags.
- [ ] "Last verified {date}" stamps on comparison and spec pages.

### D.2 Content and programmatic pages: first 20 targets

**Rules:**
- **Honest:** each page states what ReelForge does **not** do where that matters to the searcher.
- **Status from data:** "Planned" items come from the data's `status` field, never from copy.
- **Dated facts:** competitor facts are dated and linked.
- **Volumes:** keyword volumes aren't measured here (no keyword tool access). Validate them in GSC and Bing after two weeks and re-rank.

| # | URL | Target query (intent) | Type | Honesty gate |
| --- | --- | --- | --- | --- |
| 1 | `/` | self-hosted AI video generator; AI agent video studio | commercial | — |
| 2 | `/self-hosted-ai-video-generator` | self hosted AI video generator (pillar guide: what it means, costs, trade-offs) | informational/commercial | Includes "when SaaS is better" |
| 3 | `/mcp` | MCP server for video rendering; video generation MCP | commercial/dev | Lists only tested clients |
| 4 | `/agents/claude-code` | Claude Code make videos MCP | how-to | Recorded test exists |
| 5 | `/agents/codex` | Codex MCP video generation | how-to | Recorded test exists |
| 6 | `/docs/api` | video rendering REST API self-hosted | dev reference | — |
| 7 | `/alternatives/revid-ai` | revid ai alternative self-hosted | comparison | Dated prices; revid has auto-posting and avatars, we don't |
| 8 | `/alternatives/invideo-ai` | invideo ai alternative one time payment | comparison | Same pattern |
| 9 | `/alternatives/pictory` | pictory alternative self hosted | comparison | Pictory does URL/PPT-to-video natively; ours is via the agent |
| 10 | `/alternatives/creatify` | creatify alternative open source/self-hosted | comparison | Say plainly ReelForge is **not** open source |
| 11 | `/compare/own-vs-rent` | AI video generator one-time purchase vs subscription | commercial | Calculator shows the break-even both ways |
| 12 | `/use-cases/faceless-youtube-shorts` | faceless YouTube shorts generator self-hosted | use case | "Your agent or cron runs the schedule; we render." No auto-upload, no virality claims |
| 13 | `/use-cases/n8n-video-automation` | n8n video generation API | use case | REST + SSE; recipe tested |
| 14 | `/use-cases/agency-client-reels` | short-form video automation for agencies | use case | One theme per client; seats per tier |
| 15 | `/use-cases/release-notes-videos` | changelog / release notes video generator | use case | Dogfooded on our own changelog |
| 16 | `/templates/kinetic-title` | Remotion kinetic typography template | template | Real render |
| 17 | `/engines/motion-canvas` | Motion Canvas headless render | engine/dev | Explain the headless harness on upstream 3.17.2 (D-008) honestly |
| 18 | `/engines/hyperframes` | HyperFrames render server / HTML to video | engine/dev | "Uses HyperFrames (Apache-2.0)"; no endorsement implied |
| 19 | `/guides/remotion-license-for-teams` | Remotion license cost for companies | informational | Links Remotion's page, dated; not legal advice |
| 20 | `/guides/validate-vertical-video-ffprobe` | ffprobe check 1080x1920 mp4 | dev how-to | Our own QA approach, generic and useful |

**Blog/build-log series (BB Blogs), one post a week, 2 inside the window:**
- "Rendering Motion Canvas without its editor";
- "Letting an agent set exact scene timing";
- "What an MCP tool parity test buys you";
- "Shipping a store entirely on BuildBase".

### D.3 Structured data (JSON-LD components already exist in `src/components/seo/json-ld.tsx`)

| Type | Pages | Source of values | Notes |
| --- | --- | --- | --- |
| `Organization` + `WebSite` | all (root layout, exists) | `seoConfig` | Fill `sameAs` with X, YouTube, GitHub org and TrustMRR listing once they exist. `legalName` stays a placeholder until decided |
| `SoftwareApplication` (component exists, unused) | `/`, `/pricing`, `/tech-specs` | `applicationCategory: "MultimediaApplication"`, `operatingSystem: "Linux (Docker)"`, `offers` from **server-fetched BB items** | Emit `offers` only while an item is published; no `aggregateRating`/`review` |
| `Offer` / `AggregateOffer` | `/pricing` | BB item variants | lowPrice/highPrice from live variants |
| `VideoObject` | `/gallery/[slug]`, home (hero reels), templates | BB `gallery` record: `name`, `description`, `thumbnailUrl` (R2 poster), `contentUrl` (R2 MP4), `uploadDate`, `duration` (ISO 8601) | Eligible for video rich results; each video needs a watch page (gallery detail) |
| `ItemList` | `/gallery`, `/templates`, `/use-cases`, `/alternatives` | collections | exists as a component |
| `FAQPage` | `/`, `/pricing`, `/help`, `/agents` | BB FAQs | Google limits FAQ rich results to few sites, but answer engines read it. Text must match the visible accordion exactly |
| `TechArticle` | `/docs/*` | BB Docs (`title`, `description`, `updatedAt`) | + `BreadcrumbList` |
| `BlogPosting` / `Article` | blog, changelog (exist) | BB Blogs after migration | `dateModified` from `updatedAt` |
| `BreadcrumbList` | all deep pages | route | exists |
| `Person` | founder note, blog authors | founder decides name/photo | Author pages exist |

### D.4 AI-search (answer engine) plan

1. **Make `llms.txt` product-first.**
   - Today it describes only the store.
   - Generate it (and `llms-full.txt`) from BB content: one-paragraph product summary, a facts table (from `specs`), pricing link, docs index, the MCP tool list, FAQ, "what it doesn't do".
   - It stays in `createAgentStack({ discovery: { llmsTxt } })`.
2. **Markdown twins for every marketing page** via `markdownRewritePath(request)` in `src/proxy.ts`, plus `/index.md`, `/pricing.md`, `/tech-specs.md` routes (`Vary: Accept`). This generalises the existing blog/changelog negotiation.
3. **Answer-first page pattern:**
   - H1 phrased as the query;
   - a 40–60-word direct answer paragraph;
   - a facts table;
   - "Last verified" date and sources;
   - then depth.

   Comparison pages use real HTML tables.
4. **Entity consistency:** always "ReelForge" (product) and "ReelForge Studio" (the self-hosted server), with the same one-line definition everywhere: site, PH, HN, directories, YouTube descriptions.
5. **Site-level WebMCP tools** (read-only) with `<WebMcpTools>`: `get_pricing`, `search_gallery`, `get_tech_specs`, `get_install_steps`. The store already registers some via `web-mcp-tools.tsx`.
6. **Be cited where models read:** Show HN, Reddit, dev.to/Hashnode deep posts, GitHub (a public `reelforge-examples` repo of manifests and agent prompts, MIT, no product code), YouTube descriptions. Also MCP directories that accept self-hosted commercial servers (mcp.so, Glama, PulseMCP, Smithery); check each one's listing rules and state "commercial, self-hosted".
7. **Measure weekly:** ask ChatGPT search, Perplexity, Claude, Gemini and Copilot 10 fixed queries (e.g. "self-hosted AI video generator for Claude Code"). Log whether we're cited and which URL, in a BB Collection `ai-visibility`. Run `npx @buildbase/sdk agent-ready check https://reelforge.buildbase.app` in CI.

### D.5 Launch channel calendar (2026-11-21 → 2026-12-16)

**Constraints for the whole calendar:**
- **No paid placements:** they count as ad spend.
- **No "help us win" asks:** that is cheating under §6 of the rules.
- **Launch only once buying works:** big launches go out after live checkout is verified.
- **Timing:** US Thanksgiving is Thu Nov 26, so avoid launches Nov 25–29. Revenue counts until **Dec 16 13:00 UTC**.

| Date (2026) | Channel / action | Owner prerequisite |
| --- | --- | --- |
| Sat 21 – Sun 22 Nov | Ask BuildBase for live-selling pilot (prod org). Connect TrustMRR to the Stripe account used by the own store. Create X, YouTube and Product Hunt maker accounts; reserve handles. GSC + Bing verification | founder |
| Mon 23 Nov | Own-store test purchase in the dev environment (Stripe test card) → `/order` → receipt; licence-key benefit test. First 3 gallery reels rendered and on R2 | Issue 1, 3 |
| Tue 24 Nov | X build-in-public thread #1 (the agent → MCP → MP4 loop, with a real reel). First YouTube Short made with ReelForge (daily from here, with descriptions linking to `/gallery/...`) | Issue 3 |
| Wed 25 Nov | Free directory submissions with long review times: AlternativeTo, SaaSHub, There's An AI For That (free tier), Futurepedia (free), Toolify, DevHunt, Uneed (free queue), MicroLaunch, Peerlist Launchpad, BetaList (slow). Track them in a BB Collection `directories` | positioning copy final |
| Thu 26 – Sun 29 Nov | (US holiday) Ship homepage v2 + pricing polish + docs quick start. Product Hunt "coming soon" page. Indie Hackers build-log post | Issues 2, 4, 6 |
| Mon 30 Nov | **Go-live gate:** live selling on, one real price published, receipts working, TrustMRR shows the account connected. If the pilot isn't granted by now, see E.4 contingency | Issue 1 |
| Tue 1 Dec | Email campaign #1 to the waitlist: "ReelForge is on sale". Plain, what it does and doesn't do, launch price with its **end date** | sender connected |
| **Wed 2 Dec** | **Product Hunt launch** (00:01 PT). Gallery as images, the 60–75 s film, maker comment with the honest limitations list. Reply all day | Issues 4, 11 |
| **Thu 3 Dec** | **Show HN:** "Show HN: ReelForge – self-hosted studio your coding agent drives over MCP". Post 14:00–16:00 UTC, link to `/agents` or docs (not pricing). Founder answers technical questions | docs quick start live |
| Fri 4 – Sun 6 Dec | Reddit, one sub per day, read each sub's self-promo rules first and disclose it's commercial: r/SideProject, r/ClaudeAI (MCP angle), r/n8n (recipe post, value first). r/selfhosted only if its rules allow paid, closed-source tools, and say so upfront | — |
| Mon 7 Dec | dev.to/Hashnode article "Rendering Motion Canvas headless" (canonical on our blog). Public `reelforge-examples` repo | Issue 8 |
| Tue 8 – Thu 10 Dec | Second wave: comparison and alternative pages live (Issue 10); X thread with the own-vs-rent calculator; YouTube 3–4 min walkthrough (long-form) | Issues 9, 10 |
| Fri 11 Dec | Changelog release + release-notes reel made by ReelForge (dogfood the use case) → X/LinkedIn | — |
| Sat 12 – Sun 13 Dec | MCP directory listings; Remotion/HyperFrames community showcase channels **only** where their rules allow commercial showcases | — |
| Mon 14 Dec | Email campaign #2 to non-buyers: one new capability + FAQ answers; mention the launch price end date only if it's real | — |
| Tue 15 Dec | Build-log post: what shipped, real numbers (no ask to buy) | — |
| **Wed 16 Dec 13:00 UTC** | Revenue window closes. Keep the site and checkout running. 14:00 UTC: closing call (if it's a live session, use the E.2 demo) | — |
| After 16 Dec | M3: affiliates, more templates, Cursor test, translations, SEO pages scaled from data | — |

---

## E. Hackathon win plan

### E.1 What "winning" means here
- **The score:** verified profit received between Nov 16 13:00 UTC and Dec 16 13:00 UTC, minus refunds, fees and ad spend. Nothing else counts.
- **North-star metric:** paid orders on the own store, visible in TrustMRR.
- **Example targets (assumptions, not forecasts):**
  - 6,000 visitors × 0.4% → 24 orders × ~$250 average ≈ $6k gross;
  - waitlist emails usually convert far better than cold traffic, so grow the waitlist now.
- **What doesn't count:**
  - Install and support services are probably excluded as "client services". Sell them anyway for the business, and ask the organisers in Discord.
  - Coupons lower revenue per sale.
  - Affiliate payouts are deducted, so start affiliates after Dec 16 unless the founder accepts the cost.
  - Refunds before winners are confirmed are deducted. Honest copy reduces refunds, so the "what it doesn't do" list is a profit lever.

### E.2 What to show, and when
| When | What | Where |
| --- | --- | --- |
| Now → Nov 30 | The working loop on video: agent → MCP → render → verified MP4 (real, short) | X, YouTube Shorts, waitlist page |
| Dec 1–3 | The film + live site + working checkout | Email, PH, HN |
| Dec 8–11 | Depth: docs, comparisons, calculator, engine pages | Search, X, dev.to |
| Dec 16 14:00 UTC (closing call, if live) | 90-second demo (below) + one slide of real numbers | Call |

**Demo script (90 s live, or the 60–75 s film):**
1. **0:00–0:08:** "This reel was directed by an AI agent and rendered on this machine." Play the finished reel. The caption shows render time and hardware.
2. **0:08–0:25:** Terminal: `claude mcp add --transport http reelforge http://127.0.0.1:PORT/mcp --header "Authorization: Bearer $REELFORGE_KEY"`. Type the prompt: "20-second launch reel, midnight theme, 4 scenes, hook in 1.5 s."
3. **0:25–0:50:** Tool calls stream: `get_capabilities → list_templates → create_project → add_scene ×4 → validate_project → render_project → get_job`. Cut to the manifest JSON showing the per-scene `durationFrames`.
4. **0:50–1:05:** The job goes `queued → running → succeeded`. The ffprobe card shows 1080×1920, 30 fps, frames, H.264 + AAC.
5. **1:05–1:20:** Store: pricing (live BB items) → `<BuyButton>` → Stripe test page → `/order` with download + licence key. In public videos, use a test-mode recording and say so on screen.
6. **1:20–1:30:** "Pay once. Runs on your hardware. Your agent does the directing." URL.

### E.3 Metrics to show (only real ones, with dates)
- **Revenue:** TrustMRR provisional revenue (link to the listing; anonymous mode is allowed).
- **Traffic:** BuildBase Analytics visitors, top sources and revenue by source (Analytics → Overview); waitlist size (Beta users).
- **Product facts:** reels rendered for the site (count of `gallery` records); median render time on named hardware; tests passing (184 with browser, per STATUS); MCP tools (41); release cadence (changelog entries).
- **Don't show:** projected MRR, "users", or anything from test mode presented as real.

### E.4 Risks and contingencies
| Risk | Signal | Response |
| --- | --- | --- |
| Live-selling pilot not granted | `LIVE_SELLING_NOT_ALLOWED` on Nov 30 | Founder decision, not a default: delay the launches (PH → Tue Dec 8) **or** sell temporarily through a TrustMRR-supported checkout outside BuildBase. The second breaks goal 3 and needs its own licence/delivery path, so decide by Nov 27 |
| Licence keys not deliverable | `benefit_not_delivered` in Staging | `webhook_only` benefit + own key issuing (Issue 1 fallback) |
| Locked-image delivery not ready | no tested pull/download path | Sell only after the clean-machine install test passes (STATUS A4 says Docker works; test the buyer path) |
| Refund spike | refunds in BB orders | Tighten the "doesn't do" copy; add a pre-purchase checklist on pricing |
| Remotion licence answer (#10) negative | written reply | Lead with Motion Canvas/HTML/HyperFrames; keep the Remotion notice |

---

## F. GitHub issues ready to file

**Where:** issues are off on the store repo. STATUS says to file store issues in `buildbase-app/reelforge-studio` with an `area: store` label. Existing related issues: #1, #2 (buy flow), #3 (legal), #7 (SEO/layout/a11y/perf), #8 (selling setup), #11 (packaging), #12 (templates).

**Milestones:**
- **M1** = before the hackathon checkpoint. No checkpoint date is published in the rules, so the default is **Sun Nov 29**; change it if the founder's dashboard says otherwise.
- **M2** = by **Wed Dec 16 13:00 UTC**.
- **M3** = after.

**Sizes:** S ≤ ½ day, M 1–2 days, L 3–5 days.

---

### M1

#### 1. Selling go-live path: own store in Staging, licence-key check, live-selling readiness. **Order 1 · M · deps: none · relates #2 #8**
**Body:**
- [ ] Move the test site to the production org's `development` environment (`fsyqdskf`): in the console (ReelForge → development) create a sign-in client with `https://reelforge-dev.buildbase.app` in its redirect URLs, a webhook → reelforge-dev.buildbase.app and an API key; then set the store's `deploy-test` values to `NEXT_PUBLIC_BUILDBASE_ORG_ID=6b01478bb42d2c444e99fcd8`, `NEXT_PUBLIC_BUILDBASE_ENVIRONMENT=fsyqdskf` and the new client id, client secret, webhook secret and API key.
- [ ] In the dev environment (`fsyqdskf`) follow https://docs.buildbase.app/billing/selling#turn-it-on for the **own store** only: Stripe test keys saved, "Sell your own items" on, item type with "Your own store". Check whether Connect is really required (the docs say it isn't).
- [ ] Create item "ReelForge" with variants Solo/Studio/Agency (founder sets prices; nothing hard-coded in code).
- [ ] Set "Order page" = `https://reelforge-dev.buildbase.app/order` and connect an email sender, so receipts send.
- [ ] Turn on guests under "Who can buy".
- [ ] Add a `license_key` benefit. Record whether checkout refuses it (`benefit_not_delivered`).
  - If it does: switch to a `webhook_only` benefit, issue keys on `grant.created` in `/api/webhooks/buildbase`, store them in D1, and show them on `/order` through a signed route.
- [ ] Add a `file` benefit with release series `reelforge`, v0.1 release. Record the largest file accepted.
- [ ] Test purchase with Stripe test card → `/order` shows status, download, key → receipt email arrives → refund from console works.
- [ ] Ask BuildBase to add the production org `6b01478bb42d2c444e99fcd8` to the live-selling pilot. Record the answer in STATUS.
- [ ] Connect TrustMRR to the Stripe account the production own store charges.

**Acceptance criteria:**
- [ ] A test order completes end to end with receipt, download and key; refund recorded.
- [ ] A written note in `docs/STATUS.md` says: Connect needed yes/no, licence keys delivered yes/no (with fallback status), file size limit, pilot status.

#### 2. Technical SEO, CSP and positioning baseline. **Order 2 · M · deps: none · relates #7**
**Body:**
- [ ] CSP in `src/proxy.ts`: add `media-src 'self' https://media.reelforge.buildbase.app`, `worker-src 'self'`.
- [ ] Find and fix the zone HSTS override; decide `preload`/`includeSubDomains` with the BuildBase owner.
- [ ] Update `siteConfig.description`, `seoConfig.tagline`, hero copy and `src/lib/agent/content.ts` (`PAGES`, `llms.txt`) for the decided model (locked Docker image + licence key; REST/MCP; 4 engines). Remove "source code" wording.
- [ ] Server-render prices on `/` and `/pricing` (server read of published items, revalidated by the `item.*` webhook). Emit `SoftwareApplication` + `Offer` only while an item is published.
- [ ] `app/sitemap.ts` replaces `next-sitemap`'s URL list (keep `postbuild` pagefind). robots via `agent.serveAgentPath` with `contentSignals`.
- [ ] GSC + Bing verification tokens in `seoConfig.verification`; Crawler Hints on.
- [ ] Remove hreflang for unserved locales.

**Acceptance criteria:**
- [ ] `curl` of `/pricing` HTML contains the live price text and the JSON-LD `offers`.
- [ ] A video on the R2 domain plays with no CSP error.
- [ ] `npx @buildbase/sdk agent-ready check https://reelforge-dev.buildbase.app` passes all scored checks.
- [ ] Lighthouse SEO = 100 on `/`.

#### 3. Gallery pipeline: render with ReelForge, transcode, R2, BuildBase Collection. **Order 3 · M · deps: none (studio server works) · relates #12**
**Body:**
- [ ] Studio: `examples/gallery/*.json` (each of the 4 templates × 2 themes + 3 story reels) with a non-empty first frame.
- [ ] Studio: `pnpm gallery` renders via REST and writes `final.mp4` + `meta.json` (template, engine, theme, durationSeconds, renderMillis, hardware, version, renderedAt, manifest, prompt, toolsCalled).
- [ ] Transcode script (B.7): MP4 H.264 720p `-an`, VP9 WebM, optional AV1, AVIF + JPEG poster.
- [ ] R2 bucket `reelforge-media` + custom domain `media.reelforge.buildbase.app`; immutable cache headers; hashed names.
- [ ] BB Collection `gallery` (fields as in `meta.json` + URLs + `status: published|hidden`); records created for the first renders.
- [ ] Store: `getGallery()` in `src/lib/platform/content.ts` via `content.collections.data('gallery')`; subscribe `collection.record_*` to the content webhook.

**Acceptance criteria:**
- [ ] ≥ 8 reels on R2, each ≤ 800 KB (hero clips ≤ 1.5 MB).
- [ ] The store lists them from BuildBase; editing a record in the console shows on the site within one request after the webhook.
- [ ] Each record's render time and hardware match its `render-manifest.json`.

#### 4. Homepage v2: Apple-pattern product page. **Order 4 · L · deps: 2, 3 · relates #7**
**Body:**
- [ ] Sections 0–13 from PLAN §B.2: local nav, hero with phone + real reels, film slot, highlights rail, sticky how-it-works, connect-your-agent tabs, engines, gallery grid, numbers band with footnotes, privacy, tier chooser, FAQ (BB `home-faq`), final CTA, footnotes.
- [ ] CSS scroll-driven animations behind `@supports` and reduced-motion; one `IntersectionObserver` video controller with pause buttons.
- [ ] Copy follows BRIEF §7 and PLAN §0.4. Every number has a footnote with hardware/version/date.
- [ ] `trackGoal` on primary CTA, film play, copy snippet.

**Acceptance criteria:**
- [ ] Lighthouse mobile on the deployed dev site: LCP ≤ 2.0 s, CLS ≤ 0.05, TBT ≤ 200 ms; home JS ≤ 150 KB gz (or a measured note on the gap and the provider-split follow-up).
- [ ] axe: 0 serious violations.
- [ ] With reduced motion on, no video autoplays and nothing animates.
- [ ] 360 px wide: no horizontal scroll; the sticky story stacks.

#### 5. Measurement: analytics goals, UTMs, sales alerts. **Order 5 · S · deps: none**
**Body:**
- [ ] Settings → Analytics: confirm the production and dev domains are tracked; add `ref` as an extra param.
- [ ] Goals: `waitlist_join`, `buy_click`, `checkout_started`, `film_play`, `copy_agent_snippet`, `docs_copy` via `trackGoal` (`@buildbase/sdk/tracking`).
- [ ] A UTM convention table in the README (`utm_source` = channel, `utm_campaign` = `launch-2026-12`).
- [ ] Slack alert on `order.paid` (https://docs.buildbase.app/notifications/slack).

**Acceptance criteria:**
- [ ] Each goal appears in BuildBase Analytics after a test click on dev.
- [ ] A test order posts to Slack.

#### 6. Content fixes and FAQ/blocks on BuildBase. **Order 6 · S · deps: none**
**Body:**
- [ ] Render BB Markdown bodies to HTML on the server (unified/remark already installed) and sanitise with `rehype-sanitize`, replacing the regex `sanitizeHtml` in `help-center.tsx`.
- [ ] Rename FAQ collection `demo-help` → `store-faq`; create `home-faq`, `pricing-faq`, `agents-faq`; `FAQJsonLd` from the same data.
- [ ] Content blocks: `announcement-bar`, `launch-price-note`, `remotion-notice` (the component reads the block, with the current text as fallback).
- [ ] `/help` from `force-dynamic` to ISR with tag revalidation.

**Acceptance criteria:**
- [ ] A Markdown FAQ answer with a code span and a link renders correctly.
- [ ] A `<script>` in a block is stripped.
- [ ] Editing an FAQ in the console updates `/help` and the JSON-LD after the webhook.

---

### M2

#### 7. Docs site on BuildBase Docs. **Order 7 · L · deps: 6**
**Body:**
- [ ] `/docs/[...path]` with `content.docs.tree()` and `content.docs.byPath()`; sidebar from the tree; prev/next; "Edit date".
- [ ] Folders: `start` (quick start: `docker compose up` → `reelforge keys create` → connect agent), `install`, `api` (REST `/v1`), `mcp` (41 tools, grouped), `manifest` (v0.2), `cookbook` (prompts → tools called), `privacy` (egress), `troubleshooting`. Content ported from `reelforge-studio/docs` (public-safe parts only).
- [ ] Code blocks highlighted server-side (`rehype-pretty-code`, already a dependency); copy buttons.
- [ ] Markdown twins (`/docs/x.md`) and `TechArticle` + `BreadcrumbList`.
- [ ] Docs in `llms-full.txt` and the sitemap.

**Acceptance criteria:**
- [ ] A new doc published in the console appears in nav, sitemap and `llms-full.txt` without a deploy.
- [ ] A cold reader can follow the quick start from the docs only (tested on a clean machine).

#### 8. Blog and changelog on BuildBase Blogs; drop client MDX. **Order 8 · M · deps: 6**
**Body:**
- [ ] Move `introducing-reelforge` and `v0-1-0` into BB Blogs (folder `changelog` for releases); authors and tags in the console.
- [ ] Pages, RSS feeds, `/api/content/*` markdown negotiation read BB instead of contentlayer.
- [ ] Remove Contentlayer and `'unsafe-eval'` from the CSP once nothing uses the client MDX runtime (legal pages can stay as server-rendered MDX/HTML or move to content blocks).

**Acceptance criteria:**
- [ ] Publishing a post in the console updates `/blog`, the RSS feed and the sitemap.
- [ ] The CSP has no `'unsafe-eval'`.
- [ ] Lighthouse best-practices = 100.

#### 9. Product pages: tech specs, compare, pricing v2, agents. **Order 9 · L · deps: 4**
**Body:**
- [ ] `/tech-specs` per PLAN §B.4 from BB Collection `specs` (value, status: included/byok/planned, footnote, verifiedOn).
- [ ] `/compare`: tier columns with selectors; own-vs-rent calculator (server-rendered default, presets from BB Collection `saas-presets` with `checkedOn` + `sourceUrl`); engine matrix.
- [ ] `/pricing` v2: step layout, sticky summary/bottom bar, guest checkout form → `<BuyButton guest coupons>`, "what you still pay for", licence summary, pricing FAQ.
- [ ] `/agents`: client tabs (Claude Code, Codex, MCP JSON, REST), cookbook, tools by job.

**Acceptance criteria:**
- [ ] Every "Planned" label comes from data.
- [ ] The calculator shows a SaaS-cheaper scenario at low volume.
- [ ] A guest can buy without an account (dev environment) and reach `/order` from the receipt link.

#### 10. Programmatic SEO pages from Collections. **Order 10 · L · deps: 3, 7, 9**
**Body:**
- [ ] Collections: `templates`, `engines`, `use-cases`, `alternatives`, `agent-clients`, each with `status`, `verifiedOn`, `sources[]`, `notFor` (who it's not for).
- [ ] Routes: `/templates/[slug]`, `/engines/[slug]`, `/use-cases/[slug]`, `/alternatives/[slug]`, `/agents/[client]` with `generateStaticParams` + ISR; 404 for missing or hidden records.
- [ ] The 20 targets in PLAN §D.2 written (honesty gates applied); `ItemList`/`VideoObject` where relevant; internal links between related pages.

**Acceptance criteria:**
- [ ] 20 pages live and in the sitemap, each with a unique title/description, a real render or table, a "Last verified" date.
- [ ] No page claims a feature whose `status` isn't `included`.

#### 11. Launch kit and channel execution. **Order 11 · M · deps: 1, 4**
**Body:**
- [ ] Email sender on prod; waitlist campaign #1 (Dec 1) and #2 (Dec 14) via BB Email campaigns.
- [ ] 60–75 s film (PLAN §B.7) in 16:9 and 9:16; PH gallery images; maker comment with limitations.
- [ ] Show HN text; Reddit drafts per sub's rules; X threads; directory tracker (BB Collection `directories`).
- [ ] Review all copy against BRIEF §7 and the hackathon rule "no asking to buy to help win".

**Acceptance criteria:**
- [ ] PH and HN posted on the calendar dates (or the contingency dates).
- [ ] Every link carries UTMs.
- [ ] Each channel's visits and orders are visible in BuildBase Analytics → Sources.

#### 12. Feedback, contact and services intake on BuildBase Forms. **Order 12 · M · deps: 6**
**Body:**
- [ ] Forms: `feature-request`, `template-request`, `contact`, `install-service` (captcha on; spam rules).
- [ ] Custom React forms via `/api/forms/public/:orgId/:formId/fields`.
- [ ] Workflow `form.submitted` → email to founder + Slack.
- [ ] `/feedback` lists requests from the collection with status (planned/in progress/shipped); no vote counts.
- [ ] `/services` page; the service item uses a `manual` benefit (kept separate in revenue reporting).

**Acceptance criteria:**
- [ ] A submission without a captcha is refused.
- [ ] A valid one appears in the console, Slack and (after moderation) on `/feedback`.

#### 13. "Built with BuildBase" case study and blueprint. **Order 13 · S · deps: 1, 6, 7**
**Body:**
- [ ] `/built-with-buildbase`: the PLAN §C matrix as a page (feature → where → live proof link), architecture diagram, what we built ourselves and why (video on R2, sitemap, key fallback if used).
- [ ] Export the org blueprint (no secrets) into `buildbase/blueprint.json`; link it.
- [ ] `<BuildBaseBadge refCode=… params={{ utm_campaign: 'reelforge-case-study' }}>`.

**Acceptance criteria:**
- [ ] Every claim on the page links to a live page or doc URL.
- [ ] `blueprint validate` passes in CI.

---

### M3

#### 14. Affiliates, coupons strategy and referral tracking. **Order 14 · M · deps: 1 (live selling)**
**Body:**
- [ ] Selling → Settings → Affiliates on; one program (percent, 30-day window, 30-day hold, PayPal/manual payouts).
- [ ] `captureReferral()` in the root client; `/affiliates` with `<AffiliateJoin>` and `<AffiliateDashboard>`; `<AffiliatePayoutSetup>`.
- [ ] Coupon policy (dated codes only).

**Acceptance criteria:**
- [ ] A test referral in Staging earns a pending commission.
- [ ] A refund reverses it.

#### 15. Licence activation for the locked image, i18n and buyer notifications. **Order 15 · L · deps: 1, studio #11**
**Body:**
- [ ] `/api/licence/activate|validate|deactivate` using `commerce.licenses.*` (or the D1 fallback). The image calls it softly: it never blocks rendering (Q5), only gates updates/support.
- [ ] Custom notification event `release.published` → inbox + email to holders.
- [ ] Translations: pick 1–2 locales by Analytics country data; translate message files + BB content; add to `locales`.
- [ ] Testimonials section switched on once ≥ 3 real, permitted quotes exist.

**Acceptance criteria:**
- [ ] Activation beyond `activationLimit` is refused with a clear message, and rendering still works offline.
- [ ] A release notifies every holder once.

---

## Sources consulted
- BuildBase docs: https://docs.buildbase.app/llms.txt · /billing/selling · /billing/orders · /billing/affiliates · /billing/coupons · /server-sdk/commerce · /content/overview · /content/delivering-content · /content/blogs-and-docs · /content/faqs · /forms/overview · /forms/custom-forms · /assets/overview · /tracking/web-analytics · /agents/agent-ready · /pre-built-ui/badge · /reference/api-reference · /reference/plan-features-and-limits · /integrations/deploy-hooks · /links/create-a-short-link
- Ship or Die: https://www.ship-or-die.com/100k-hackathon and https://www.ship-or-die.com/100k-hackathon/rules (read 2026-11-21)
- Apple: https://www.apple.com/macbook-pro/ (text only, page-structure patterns)
- Live site checks: headers, `robots.txt`, `sitemap-0.xml`, `llms.txt` on https://reelforge.buildbase.app (2026-11-21)
- Repos: `/home/user/reelforge-selling-public-site` (src/app, src/components, src/lib, src/proxy.ts, next.config.ts, next-sitemap.config.js, wrangler.jsonc), `/home/user/reelforge-studio/docs/{STATUS,DECISIONS,AGENT_PLATFORM}.md`, `/home/user/ReelForge/REELFORGE_PLAN.md`
