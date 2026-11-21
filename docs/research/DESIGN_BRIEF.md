# ReelForge store: design and product-concept brief

**Prepared:** 2026-11-21. **Scope:** pattern-level research on revid.ai, 8 AI-video peers and 3 sites that sell developer products, mapped onto what ReelForge Studio actually has today.
**Rule followed:** nothing copied. No competitor text, branding, logos or assets. Patterns only.
**Read with:** `/home/user/ReelForge/REELFORGE_PLAN.md`, `/home/user/reelforge-studio/docs/AGENT_PLATFORM.md`, `/home/user/reelforge-studio/docs/STATUS.md`.

---

## 0. The five findings that matter most

1. **"Agent-native" no longer sets ReelForge apart by itself.** revid (an MCP server with about 30–36 tools, plus a CLI and agent skills), invideo ("bring your own agents"), Pictory (API + MCP), OpusClip (MCP connector), Submagic (Claude/ChatGPT integration) and Creatify (API + MCP) all market agent access now. ReelForge's real edge is the combination below, which none of the peers offer:
   - the agent **decides every scene and its exact timing** in an open, versioned manifest;
   - you get **the source code and the templates** (React, Motion Canvas, HTML, HyperFrames);
   - it runs on **your hardware or cloud**;
   - you **pay once**, not per credit.
2. **Every peer sells by showing output.** The pages are built from phone-shaped autoplaying loops, before/after pairs and "make one like this" cards. ReelForge's homepage currently has no video at all. That is the biggest gap.
3. **Pricing is credit math everywhere, and buyers have to decode it.** For example, revid's own FAQ puts a typical 30-second video at about 40–80 credits, so 2,000 credits ≈ 25–50 videos/month on the $39 plan. That opacity is our opening, as long as we compare honestly and count the buyer's own costs too (TTS, the Remotion licence for teams over 3, compute).
4. **Dev-product sellers win on "what you get, pay once, here is the code".** Examples: remotion.dev's install command in the hero, supastarter's "your coding agent deserves" framing with one-time tiers, and ShipFast's itemised list of chores you skip. Copy their structure, not their hype. Avoid fake scarcity.
5. **Trust signals have to be different for us.** The peers lean on user counts, logo walls, G2 badges and SOC 2. We have none of these and must not imitate them. Our trust signals are verifiable facts:
   - runs offline;
   - a list of every network egress;
   - no telemetry from ReelForge itself;
   - ffprobe-verified renders;
   - a licence inventory;
   - a named founder;
   - a public changelog.

---

## 1. Sources

All sites were fetched as text with WebFetch on 2026-11-21. Playwright screenshots were attempted for all 12 sites. The proxy blocked every host except remotion.dev (`ERR_TUNNEL_CONNECTION_FAILED`), so only `shots/remotion.dev-hero.png` exists. Notes on visual language are therefore inferred from page structure, asset names and that one screenshot. They are not pixel-verified.

| Site | URL | Fetched | Key takeaways (pattern level) |
| --- | --- | --- | --- |
| revid.ai | https://www.revid.ai/ (+ /pricing, /mcp) | Yes (text). Screenshot blocked. `/api` returns 404; the agent page is `/mcp` | **Page structure:** about 18 sections. The hero has one CTA and a "no card" line, set over autoplay loops with an avatar stack. Then input→"your version" pairs, about 15 template cards with **"Create similar"** buttons that prefill the tool through URL parameters, embedded social posts showing view counts, a series/episodes strip, a 4-step how-it-works, a tools grid, a stats band, and a 13-question FAQ **with an LLM-readable markdown copy**. The CTA repeats about 6 times.<br>**Agent page:** client tabs (Claude, ChatGPT, Claude Code, Cursor, VS Code, skills); a "prompt cookbook" listing which tools each prompt triggers; tools grouped by job, with plan badges; OAuth up front and the technical detail collapsed; a `calculate_credits` tool so agents can estimate cost before rendering.<br>**Pricing:** $39 / $89 / $199 per month, plus credit top-ups, a slider and a struck-through anchor price. API, MCP and auto-posting are gated to the higher plans. |
| opus.pro (OpusClip) | https://www.opus.pro/ (+ /pricing) | Yes (text). Screenshot blocked | The hero leads with an adoption number over a creator-card grid, then a logo wall. The product is split into named "models" (clip, reframe). Workflow automation and API sections. Teams and brand templates. A long testimonial block and creator outcome stats. The FAQ sits at the bottom, with a paste-a-link input. **Pricing:** Free / $15 / $29 / Custom, with an ROI calculator and a full comparison table. The API, scheduler and MCP are Pro-only. |
| invideo.io | https://invideo.io/ | Yes (text). Screenshot blocked | The hero calls it an "agentic editor" with a secondary link to use it inside ChatGPT or Claude, then a 4-step strip and a logo marquee. Feature blocks show **agent roles** (scriptwriter, editor, colourist…). A use-case grid. Trust badges (SOC 2, GDPR). A "connect your agent" section. Pricing sits on the homepage with toggles. Heavy promo bars. No FAQ. |
| pictory.ai | https://pictory.ai/ | Yes (text). Screenshot blocked | The hero has an embedded demo video and "no card". A **"ways to start" card per input type** (text, script, URL, audio, PPT, image). A feature grid, a 4-step how-it-works, Make/Zapier automation, persona cards, review badges, case studies and an FAQ. SOC 2 / ISO seals. API pricing **by video minute**. |
| heygen.com | https://www.heygen.com/ | Yes (text). Screenshot blocked | The hero cycles use-case chips. Social proof: rating, press, logos and a developer count. Sections on avatars, a research report (original vs generated), prompt-to-video shown **with transcripts**, translation with language flags, a tools grid, a **trust and safety** section (identity verification, moderation, pen tests, compliance badges), events, a video testimonial and an FAQ. They also publish **HyperFrames** (open-source HTML rendering, Apache-2.0), which ReelForge already uses as an engine. |
| captions.ai (Mirage) | https://www.captions.ai/ | Yes (text). Screenshot blocked | The hero is upload + **named style presets** + clickable example edit prompts. A **one video in three styles** comparison with a switcher. A press strip and stats. Personas listed under "Solutions". A 6-question FAQ that explains the Mirage Studio merger (Mirage folded into Captions; legal links still point at mirage.app). |
| submagic.co | https://www.submagic.co/ (+ /pricing) | Yes (text). Screenshot blocked | Built around product-UI mockups rather than video. **Caption style thumbnails with names**, a highlight-colour picker and a size slider. 4-step how-it-works, a feature grid, persona cards, review stars, a 6-question FAQ, and a closing stat band. **Pricing:** $19 / $39 / $69 per month (yearly is about 40% off). The API is sold in minutes ($0.10–0.23/min packs). |
| creatify.ai | https://www.creatify.ai/ | Yes (text). Screenshot blocked | **Dark, cinematic** look. The hero is a **prefilled prompt field**, followed by agent chat transcripts with step checklists, a format gallery, integration logos, a **brand-kit section showing swatches, fonts and logos**, a research lab, case-study metrics, and the prompt field repeated in the closing CTA. No FAQ. No prices on the page. |
| vizard.ai | https://www.vizard.ai/ | Yes (text). Screenshot blocked | The hero has a CTA plus **22 template chips used as example prompts**, then a logo wall and review badges, social-ready outputs with platform icons, 4 persona cards, team workspace, a feature slider, 3-step how-it-works, and testimonials with metrics. No FAQ. Prices are not on the homepage. |
| remotion.dev | https://www.remotion.dev/ | Yes (text + **screenshot**) | **White page; a very large, heavy two-line headline (80px, weight 900, geometric sans).** In the hero, a dark terminal-style **install command button** sits next to Docs, Discord and GitHub (with star count). Below it, a large dark product screenshot (timeline + preview). After that: pillars (agentic, interactive, programmatic), a feature grid, **licence and pricing explained by company size with a worked example**, customer logos, a stats bar (installs, stars, contributors), and a free evaluation call. |
| shipfa.st | https://shipfa.st/ | Yes (text). Screenshot blocked | The flow runs **problem → itemised chores ("hours of headaches") → solution → feature tabs with "time saved" → founder story → pay-once tiers with strikethrough and value stack → wall of love → objection FAQ** (including no refunds and alternative payment). There is a live "N left" scarcity banner (do **not** copy that). |
| supastarter.dev | https://supastarter.dev/ | Yes (text). Screenshot blocked | **Dark, monochrome.** The hero names the coding agent as the audience, with 4 value bullets and a **price inside the CTA** ("Get lifetime access – $X") plus "See demo". Each feature block has a mockup and a link to its docs. Tech-stack logo rows show the choices per category. One-time tiers by **seats/projects** (Solo / Startup / Agency), with consulting add-ons, a "last updated" note, a founder note and a developer counter. |

---

## 2. Patterns that win (and how ReelForge should use each)

| # | Pattern | Seen at | ReelForge version |
| --- | --- | --- | --- |
| P1 | **Output is the hero.** Phone-shaped 9:16 loops, muted autoplay, several clips cycling | revid, heygen, pictory, vizard | Hero shows a phone frame cycling 3 real renders. Each clip is labelled with its template, engine and render time on named hardware. |
| P2 | **"Make one like this"** cards that prefill the tool | revid ("Create similar"), vizard (template chips) | Each gallery card has two buttons: **"Copy manifest"** and **"Copy prompt for your agent"**. This is our honest equivalent: the buyer's agent recreates the video on their own instance. |
| P3 | **Input → output pairs** | revid, heygen (prompt + transcript), captions (one video, three styles) | Show the brief, then the manifest JSON, then the MP4 side by side. Add a **"same manifest, three themes"** switcher, which is cheap because themes are tokens. |
| P4 | **Agent setup as a first-class page**: client tabs, copy buttons, a prompt cookbook that maps each prompt to the tools it calls, and tools grouped by job | revid /mcp, invideo, creatify transcripts | A "Connect your agent" section on the homepage plus a full `/agents` page. Tabs for Claude Code, Codex, Cursor and generic MCP JSON, plus a REST curl example. |
| P5 | **Cost visible before render** | revid `calculate_credits` | We already have `costNote` on provider plugins and `get_capabilities`. Say so plainly: "Your agent sees each provider's cost note before it spends your key." |
| P6 | **Numbered how-it-works (3–4 steps)** | every peer | Brief → agent plans (theme, templates, timing) → server validates and renders → verified MP4. Use the real MCP tool names in small monospace text. |
| P7 | **Personas as cards linking to deeper pages** | vizard, pictory, heygen, captions | 4 cards: Developers, Agencies, Automators, Faceless-channel operators. Each card shows a render that persona would actually make. |
| P8 | **Named style presets with thumbnails** | submagic (named caption looks), captions (named edit styles) | A theme gallery (we have `default` and `midnight`; add 6–8 more) and named caption presets once burn-in ships. |
| P9 | **Brand kit shown as swatches, fonts and logo** | creatify, opus | Show a theme as a token card (colours, font, radius, motion speed, caption style) next to the render it produces. |
| P10 | **Install command in the hero** | remotion.dev | A copyable `docker compose up` chip under the CTAs. Show it only once Docker is tested (STATUS A4). |
| P11 | **Licence and pricing explained with a worked example** | remotion.dev | A "What you'll pay, in total" box on pricing that includes the third-party costs. |
| P12 | **Pay-once tiers by seats/projects + service add-ons + founder note** | supastarter, shipfa.st | Solo / Studio / Agency (prices come from BuildBase items) plus "Install for me" and "Deploy to my cloud" services. |
| P13 | **Objection-handling FAQ, also published as LLM-readable markdown** | revid, shipfa.st | The FAQ also goes into the site's existing `llms.txt` / `llms-full.txt`, so buyers' agents can answer "will this work for me?" |
| P14 | **The CTA repeats every 2–3 sections** | all | Repeat it, but with one primary action (Buy, or Join the waitlist before launch) and one secondary action (Watch it render / Docs). |
| P15 | **Status honesty for integrations**: plan badges, "optional" step markers | revid (plan badges, optional steps) | Every engine, provider and backend card carries one badge: **Included**, **Bring your key**, or **Planned**. These mirror `GET /v1/capabilities`. |

**Anti-patterns to avoid:**
- fake scarcity counters ("11 left");
- permanent "Black Friday" banners;
- unverifiable uplift stats ("+40% views");
- logo walls without permission;
- compliance badges we don't hold;
- editor screenshots of a UI we haven't built (the web UI is #15, not started);
- inconsistent numbers between the FAQ and structured data (OpusClip's caption-accuracy figure differs between the two).

---

## 3. Recommended homepage wireframe

**Positioning line (direction, not final copy):** *Own your video factory. Your AI agent directs; your server renders; you pay once.*
**Tone:** concrete, developer-plain, with numbers we can measure. Use short sentences. Use no superlatives ("first", "only", "best").

| # | Section | Purpose | Layout | Copy direction |
| --- | --- | --- | --- | --- |
| 0 | Announcement bar (optional) | Show the product is alive | Thin bar | Current version, date and a link to the changelog. Example: "v0.2 — HTML engine and themes. See what changed →". Never a fake promo. |
| 1 | Nav | Get people where they want to go | Logo · Gallery · Agents · Docs · Pricing · Changelog · [Buy] | Primary button: "Buy" when selling is live, "Join waitlist" before. |
| 2 | **Hero** | Say what it is in 5 seconds and show real output | Split on desktop. **Left:** H1, subhead, 2 CTAs, a reassurance line, and an install chip (once Docker is tested). **Right:** a phone frame playing 3 real renders in turn, muted autoplay, with a pause control (accessibility), and a "View manifest" toggle that flips the phone to the JSON | **H1** angle: own the factory, not a subscription. **Sub:** say that an AI agent (Claude, Codex, any MCP client) plans scenes and timing, and ReelForge renders them on your machine or cloud. **Reassurance:** "One-time licence · Self-hosted · No per-video fees to us". **Caption under the phone:** "Rendered by ReelForge vX.Y on <hardware> in <N>s". |
| 3 | Proof strip (facts, not logos) | Replace a logo wall with claims that can be checked | 5–6 small mono stat chips | Only facts that are true at launch, for example: "4 engines", "1080×1920 H.264 + AAC", "Every render ffprobe-checked", "REST + MCP", "Works offline", "No telemetry from ReelForge". Each chip links to the doc or file that proves it. |
| 4 | **Demo gallery (real renders)** | Make the output feel tangible | Horizontal scroller (mobile) or 4-column grid (desktop) of 9:16 cards. Filter chips: template · engine · theme. Each card plays on hover or tap and has a footer with template, engine badge, duration and render time, plus buttons for **Copy manifest**, **Copy agent prompt** and **Download MP4** | Feed it from a build-time JSON that the studio's `render-manifest.json` outputs generate (see §3.1). Copy: "Every clip here was rendered by ReelForge from the manifest shown. No stock reels, no mock-ups." |
| 5 | How it works | Make the agent model concrete | 4 numbered steps with small diagrams, each ending in the tool names in mono | 1. Write a brief (or let your agent write one). 2. The agent picks a theme, templates and per-scene timing (`list_templates`, `add_scene`). 3. ReelForge validates and renders across engines (`validate_project`, `render_project`). 4. You get a checked MP4 link (`get_render_output`). |
| 6 | **Connect your AI agent** | Turn developer intent into "I can try this in 2 minutes" | Tabs: **Claude Code · Codex · Cursor · Other MCP · REST**. Each tab has a code block with a copy button. Next to it: a "prompt cookbook" of 3 example prompts, each listing the tools it calls. Underneath: an excerpt of a `get_capabilities` response | Snippets in §3.2. Copy: "Your instance, your keys. Create a key with `reelforge keys create`, paste one line into your agent, and ask for a reel." Say that keys are scoped (`read`, `write`, `render`, `admin`) and stored hashed. |
| 7 | **Own vs rent: the honest maths** | Win the "tired of per-minute fees" buyer without overclaiming | An interactive calculator next to a "What you still pay for" list | Covered in §3.3. The tone is a calculator, not an attack ad. Competitor figures appear only as **dated, sourced presets**. |
| 8 | Pluggable everything | Show extensibility and set expectations honestly | A 4-column grid: Engines · Voice providers · Render backends · Storage. Each item has a status badge: Included / Bring your key / Planned | **Engines:** Remotion, Motion Canvas, HTML, HyperFrames. **TTS:** ElevenLabs, marked "Bring your key". **Backends:** Local is Included; Remotion Lambda is **Planned** (it is a stub in v0.1). **Storage:** Local, plus S3-compatible marked Planned unless verified. Copy: "Add an engine or provider as a plugin, not a fork." |
| 9 | Personas | Help each buyer see themselves | 4 cards, each with a render, the job to be done, the feature that matters and a "Read the guide" link | **Developers:** embed rendering in your app over REST. **Agencies:** one theme per client brand, renders on your box. **Automators:** n8n, Make or cron plus REST, with no per-render bill from us. **Faceless-channel operators:** a saved theme + template set + agent recipe gives a consistent series (the agent schedules; ReelForge renders). |
| 10 | Templates and themes | Show range and that it can be customised | Template catalog cards: name, engine, props, duration range. A theme strip that shows the **same manifest in 3 themes** | "Templates are code you own: React (Remotion), generator scenes (Motion Canvas), plain HTML/CSS, HyperFrames. Fork them." Show only templates that exist. |
| 11 | What you get (box contents) | Answer "what do I actually download?" (the supastarter/ShipFast pattern) | A checklist grid | Source code (monorepo), Docker Compose, install docs (macOS, Linux; Windows via WSL untested), sample project, agent kit (schema, prompts, examples), licence notices and asset inventory, updates for the period the tier states, and the support channel. |
| 12 | Privacy and control | A trust signal that fits self-hosting | Two columns: "Stays on your machine" / "Leaves only if you configure it" | Name every egress: the TTS provider you configure, URLs you ask it to fetch, and a Chrome Headless Shell download at install time if you don't supply one. ReelForge itself sends no telemetry. HyperFrames' telemetry is switched off by default. Note that Remotion 5 plans mandatory telemetry for its paid "Automators" licence holders. |
| 13 | Pricing teaser | Move people to buy | The live `PricingCatalog` (already built) + `RemotionNotice` + a link to the full pricing page | Keep the current "prices come from the store, never hard-coded" behaviour. |
| 14 | Founder note | Show there is a person behind it (works for one-time sellers) | Photo, 3–4 sentences, links to the changelog and contact | Why it exists, who it's for, how support works. Real name and entity (STATUS open item #4). |
| 15 | FAQ | Handle objections | Accordion, about 10 questions. Also generated into `llms.txt` | Do I need an AI subscription? Which agents work? Hardware needed? Remotion licence? Windows? What updates do I get? Refunds? Can I sell the videos I make? Can I resell the code? Does it post to TikTok or YouTube? (No; here is how to wire your own.) |
| 16 | Final CTA | Close | Full-width dark band with one render looping in the background | Restate the angle and repeat the primary CTA and the reassurance line. |
| 17 | Footer | Utility | Existing footer + EULA, refund, privacy, licence notices, security.txt, llms.txt | — |

### 3.1 Feeding the gallery with real renders

- In the studio repo, add a script (for example `pnpm gallery`) that renders `examples/*.json` and writes these to a `gallery/` folder:
  - `{id}.mp4` (H.264, about 3–6 MB)
  - `{id}.webm` (optional)
  - `{id}.jpg` (a poster frame from ffmpeg)
  - `{id}.json`, holding: manifest, template, engine, theme, durationSeconds, render millis, hardware string, ReelForge version, render date
- Upload the files to R2 (the store already runs on Cloudflare) or to BuildBase assets. The store reads a `gallery.json` index at build time.
- Video tags: `<video muted playsinline loop preload="none" poster>`. Play only while in view (IntersectionObserver). Respect `prefers-reduced-motion` by showing the poster plus a play button.
- Each card's render time comes from `render-manifest.json` (`millis`). Never round it in our favour, and state the hardware.

### 3.2 "Connect your AI agent" snippets (based on AGENT_PLATFORM.md §7)

```bash
# Claude Code
claude mcp add --transport http reelforge https://YOUR-HOST/mcp \
  --header "Authorization: Bearer $REELFORGE_KEY"
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.reelforge]
url = "https://YOUR-HOST/mcp"
http_headers = { Authorization = "Bearer rf_..." }
```

```json
// Any MCP client (generic Streamable HTTP)
{ "mcpServers": { "reelforge": { "url": "https://YOUR-HOST/mcp",
  "headers": { "Authorization": "Bearer rf_..." } } } }
```

```bash
# REST
curl -H "Authorization: Bearer $REELFORGE_KEY" https://YOUR-HOST/v1/capabilities
```

**Snippet rules:**
- Use `YOUR-HOST` and `rf_...` placeholders, never a real key.
- Mention `127.0.0.1:PORT` for local use.
- Put the TLS and `REELFORGE_HOST=0.0.0.0` note in a collapsed "Remote access" block, the same way revid collapses its protocol detail.
- Show the Cursor tab only after it has been tested.

**Example prompt card:**
- Prompt: *"Make a 20-second reel announcing our v2 launch, midnight theme, 4 scenes, hook in the first 1.5s."*
- Tools it calls: `get_capabilities → list_templates → create_project → add_scene ×4 → validate_project → render_project → get_job → get_render_output`.

### 3.3 Honest cost comparison

**Calculator inputs:**
- videos per month;
- average length in seconds;
- team size (this drives the Remotion licence);
- TTS on/off and provider;
- "what you pay today" (free entry, **or** a preset).

**Outputs:**
- 12- and 24-month totals for each side;
- the break-even month.

**ReelForge side (all listed, none hidden):**
- the licence tier price (read live from BuildBase);
- the optional install service;
- **the Remotion licence if the team is over 3 people** (Automators: $0.01/render, $100/month minimum, checked 2026-11-21). Point out that the Motion Canvas, HTML and HyperFrames engines carry no Remotion fee;
- TTS spend at the buyer's provider (the buyer enters it, or we use a dated rate from the provider's pricing page);
- compute: "your existing machine", or an estimated VPS cost the buyer enters.

**SaaS-side presets (dated, linked, labelled "as listed on <date>"):**
- revid Growth $39/mo (their FAQ: about 25–50 thirty-second videos);
- revid Ultra $199/mo;
- Submagic Pro $39/mo;
- OpusClip Pro $29/mo.

Add a disclaimer: these products do different jobs (clipping vs generation). Compare what you would actually use.

**Rules:**
- Don't call SaaS "a rip-off".
- Show the case where SaaS is cheaper. At low volume with no developer time, SaaS often wins, and saying so builds trust.
- Include "your setup time" or point to the install service.
- Refresh the presets monthly and show the date.

---

## 4. Pricing page and buy flow

**Pricing page layout (top to bottom):**

1. **Header:** "Pay once. Run it forever on your own hardware." (direction). If there is a real launch price, give its **end date**. No live scarcity counter.
2. **Three tier cards from BuildBase items:** Solo / Studio / Agency. STATUS proposes $149 / $349 / $899; never hard-code these.
   - Differentiate by **seats, client brands/projects allowed, update period (one year per Q4), support level**. Don't differentiate by features: every tier gets the same code, which matches the source-sale model and avoids crippleware.
   - Highlight Studio as the middle tier.
   - Put the price in the CTA ("Buy Studio – $X"), as supastarter does.
3. **Service add-ons as separate cards:** "Install on your machine", "Deploy to your AWS/GCP", "Custom template". Each states what is delivered and the turnaround.
4. **"What you'll still pay for" box (the remotion.dev worked-example pattern):** the Remotion licence over 3 people (keep `RemotionNotice`), TTS and avatar providers you choose, your compute and storage. Then: "We never sit between you and these bills."
5. **Comparison table:** rows grouped as Licence (seats, brands, commercial use of videos, resale of code: no), Updates, Support, Delivery (zip / Docker / GitHub access, per Q2), Refund.
6. **Plain-English licence summary** (5 bullets) that links to the EULA.
7. **Pricing FAQ:** refunds (state the policy and window clearly); upgrading tiers (do we credit the price already paid?); what happens after updates end (keep using it; renew for updates); VAT/receipts; team transfers; "is there a subscription?" (no).
8. **Cost calculator link** (§3.3) and the final CTA.

**Buy flow:**

1. **Before checkout:** prices are visible without signing in. If BuildBase requires sign-in to buy, the button reads **"Sign in to buy"** (already in `pricing-catalog.tsx`) with a one-line reason: "so we can deliver your download and licence key".
2. **Checkout:** `<BuyButton>` → Stripe. Collect the tier, the seats, and an optional "company size over 3?" checkbox. The checkbox only triggers the Remotion reminder; it is not a gate.
3. **`/order` page (most important after the homepage):**
   - a success state;
   - the **download** (source zip + checksums);
   - the **licence key** with a copy button;
   - a **3-step quick start**: `docker compose up` → `reelforge keys create` → paste the agent snippet, pre-filled with `127.0.0.1`;
   - links to the install docs and the Remotion licence page;
   - the receipt and support contact;
   - the same content sent by email.
4. **`/dashboard/licences`:** keys, activations (if used), every release with notes and checksums, renewal for updates, and an upgrade path.
5. **Licence enforcement stays soft (per Q5):** the key unlocks downloads, updates and support. It never blocks rendering. Say this on the pricing page, because developers trust it.
6. **Pre-launch:** keep the waitlist as the primary CTA until test purchases have been verified (STATUS B5). Don't show a Buy button that fails.

---

## 5. Design tokens (shadcn/Tailwind v4, matches `globals.css` token names)

**Direction:**
- **Dark-first marketing** (video and code both read better on dark; creatify, supastarter and remotion's product shot all lean dark). Keep a light theme via the existing `theme-toggle`.
- Brand continuity: reuse the **studio's default theme** (`#0b0b14` background, `#ff3d71` accent, `#00d1b2` secondary), so the site and the sample reels feel like one product.
- Fonts: keep Geist Sans / Geist Mono (already wired). Use a heavier display weight for the H1 (the remotion.dev pattern: very large, tight leading, weight 800–900).

**Palette (oklch, dark = default marketing look):**

| Token | Dark | Light | Note |
| --- | --- | --- | --- |
| `--background` | `oklch(0.155 0.019 284)` (#0b0b14) | `oklch(0.985 0 0)` | Studio default bg |
| `--card` | `oklch(0.227 0.033 284)` (#1a1a2b) | `oklch(1 0 0)` | Studio "surface" |
| `--foreground` | `oklch(0.985 0 0)` | `oklch(0.155 0.019 284)` | |
| `--muted` | `oklch(0.294 0.034 284)` | `oklch(0.968 0.004 286)` | |
| `--muted-foreground` | `oklch(0.84 0.018 286)` (#c9c9d6) | `oklch(0.479 0.034 285)` | Check 4.5:1 |
| `--primary` | `oklch(0.666 0.228 11)` (#ff3d71) | `oklch(0.56 0.22 13)` | Brand "record" pink |
| `--primary-foreground` | `oklch(0.155 0.019 284)` (**dark text**: white on #ff3d71 is only about 3.4:1) | `oklch(0.985 0 0)` | Check AA on light |
| `--accent` (signal) | `oklch(0.769 0.143 177)` (#00d1b2) | `oklch(0.511 0.086 186)` | Use for "Included", "verified" and success-type chips, not CTAs |
| `--border` | `oklch(1 0 0 / 10%)` | `oklch(0.922 0 0)` | |
| `--ring` | `oklch(0.666 0.228 11 / 60%)` | `oklch(0.56 0.22 13 / 60%)` | |
| status badges | Included = accent, Bring your key = `--warning`, Planned = `--muted` | same | Matches P15 |

**Type scale (Tailwind classes):**

| Role | Mobile | Desktop | Style |
| --- | --- | --- | --- |
| Display H1 | `text-5xl` | `text-7xl` / `8xl` | `font-extrabold tracking-tight leading-[0.95]` |
| H2 | `text-3xl` | `text-5xl` | `font-bold tracking-tight` |
| H3 | `text-xl` | `text-2xl` | `font-semibold` |
| Body | `text-base` | `text-lg` | muted-foreground for supporting copy |
| Eyebrow | `text-xs` | — | `uppercase tracking-widest font-mono` (for "STEP 2", engine badges, stat chips) |
| Code | `font-mono text-sm` | — | on `--card`, with a copy button |

**Radius:**
- Keep `--radius: 0.625rem` for UI.
- Phone frames use `rounded-[2.25rem]` with a 6–8px border in `--card`.
- Video cards use `rounded-2xl`.
- Code blocks use `rounded-xl`.
- Chips use `rounded-full`.

**Motion (`tw-animate-css` is already installed):**
- **Video does the moving; the UI stays calm.** Fades and slide-ups of 150–250ms, `ease-out`.
- No parallax, no scroll-jacking.
- The hero phone cross-fades between clips (400ms).
- Gallery cards scale on hover (`scale-[1.02]`, 200ms) and start playing.
- One "rendering" progress-bar micro-animation in the How-it-works step 3, which echoes real job states (queued → running → succeeded).
- Everything respects `prefers-reduced-motion`: posters instead of autoplay, no transitions.

**Density:**
- Marketing sections use `py-20 md:py-28` with a `max-w-6xl` container.
- The gallery is the densest section; the rest stays airy.
- Promo bars: at most one.

---

## 6. Concept gap table for the studio

**Classification:** (a) already supported · (b) easy to add as a template, theme or provider plugin · (c) needs a third-party provider the buyer brings a key for · (d) out of scope.
**Priority** reflects how much each concept helps a sale to our buyers (developers, agencies, automators, faceless operators). The "state" column comes from the studio code on 2026-11-21. Other agents are editing it now, so re-check before claiming anything.

| Prio | Concept | Who markets it | Class | ReelForge state today | What to do / how to market it honestly |
| --- | --- | --- | --- | --- | --- |
| 1 | **Agent/API/MCP control** (create, edit, theme, render, fetch) | revid, invideo, pictory, opus, creatify, submagic | **(a)** in progress | REST + MCP v0.1 under construction (#9, STATUS A1/A2). Tool list defined in AGENT_PLATFORM §7 | Headline feature. Claim it only once A2 passes end to end with Claude Code and Codex. Lead with "the agent sets per-scene timing", which most peers don't expose. |
| 2 | **Prompt/script/brief-to-video** | revid, pictory, heygen, invideo, creatify | **(a)** via the buyer's agent | There's no built-in LLM (by design); the agent writes the manifest. The `plan_reel` MCP prompt is planned | Market it as "bring your agent". Don't claim "type a prompt in our app". |
| 3 | **Templates gallery** | revid, vizard, submagic, captions | **(b)** | 4 templates: `kinetic-title` (Remotion), `animated-explainer` (Motion Canvas), `html-title`, `hyperframes-title`. The HTML engine also accepts agent-written HTML/CSS | Ship 8–12 short-form templates before launch (#12): hook card, listicle/countdown, quote, stat reveal, product showcase, split-screen, caption-over-image, end card/CTA. This feeds the gallery directly. **Biggest sales lever after video proof.** |
| 4 | **Auto captions + caption styles** | every peer | **(b)** (+(c) for word timing) | Schema only: `captions` (source `text` or `voice`) and a theme `captionStyle`. ElevenLabs returns word timestamps. No burn-in code found in core or media-pipeline | Build a caption overlay pass and 4–6 named presets (#13). Claim it only after a tested render. Word-by-word highlighting needs TTS timestamps (c) or text-timed captions (b). |
| 5 | **Brand kits** | opus, creatify, pictory, heygen, vizard | **(a)/(b)** | Themes = brand tokens: colours, font, heading weight, radius, spacing, motion speed, caption style. Built-ins: `default`, `midnight`. CRUD via `/v1/themes` | Market "one theme per client" for agencies. Add a logo asset and intro/outro scenes (b). Add 6–8 built-in themes. |
| 6 | **AI voice (TTS)** | all generators | **(c)** | ElevenLabs provider with word timestamps; **unit-tested against a mock only, live untested** | Verify live. Add OpenAI TTS (c) and consider a local/offline TTS plugin (b) for the "works offline" story. Label it "Bring your key". |
| 7 | **Render QA / verified output** | nobody markets it | **(a)** | ffprobe + decode checks, exact-frame assembly, render manifest | Differentiator for developers and automators: "Every render is checked: resolution, frames, codec, audio." Peers don't offer this. |
| 8 | **Cost transparency before spend** | revid (`calculate_credits`) | **(a)** | Provider `costNote`, `get_capabilities` | Market it in the agent section. |
| 9 | **Faceless channels / series / autopilot** | revid (series, automations, channel watcher) | **(b)** recipe; scheduling belongs to the buyer | Not a feature. Achievable with a saved theme + template set + agent prompt run on the buyer's cron or agent scheduler | Ship a "series recipe" in the agent kit and a docs guide. Say "your agent or cron runs it; ReelForge renders". Never "autopilot channel". |
| 10 | **Batch / bulk rendering** | remotion.dev, creatify ("10 to 1,000 ads") | **(b)** | Job runner with bounded concurrency; many projects via API | Claim "queue many renders over REST" once tested. Publish a measured throughput figure for named hardware. |
| 11 | **URL-to-video** | revid, pictory, creatify | **(b)** via the agent | The agent reads the URL itself; `add_asset_from_url` fetches images (https, SSRF-guarded) | Cookbook prompt: "turn this product page into a reel". No built-in scraper needed. |
| 12 | **Background music / SFX** | captions, submagic, pictory | **(a)** partly + (b) | Music track and SFX cues in the manifest. **Ducking is stored but not applied** (warning) | Implement ducking. Bundle a few CC0 tracks with an inventory (R4). Treat music generation as (c). |
| 13 | **Multi-language** | heygen, pictory, submagic, opus | **(b)/(c)** | `brief.language`; the ElevenLabs multilingual model; the agent translates the script | Market "your agent writes it in any language your TTS supports". Check fonts cover non-Latin scripts before claiming. |
| 14 | **Cloud render on the buyer's AWS (Remotion Lambda)** | remotion.dev | **(c)** buyer's AWS | Backend **stub**: it checks configuration, then refuses ("not implemented in v0.1") | Show it as "Planned". Local, VPS and container deployment of the same image is the honest cloud story today. |
| 15 | **B-roll / stock footage** | heygen, submagic, vizard, pictory | **(c)** | `stock` provider kind exists in the interface; no implementation | Add a Pexels/Pixabay plugin (buyer's key) that records licence metadata in assets. That is a nice provenance angle. |
| 16 | **AI image / generative video clips** (Veo, Kling…) | invideo, pictory, revid | **(c)** | `image` kind in the interface; no implementation | Later. Possible plugin, generated assets cached by hash. |
| 17 | **Voice cloning** | invideo, heygen, pictory, revid (top tier) | **(c)** | Accepts any ElevenLabs `voiceId`, including the buyer's own cloned voice | Say "use your cloned ElevenLabs voice". We don't clone anything. |
| 18 | **Avatars / talking heads** | heygen, captions, creatify, revid | **(c)** | `avatar` kind planned (HeyGen as an example) | Low priority for this buyer. Don't feature it. |
| 19 | **Hooks** | revid and submagic (hook generators) | **(b)** | — | Ship hook-card templates and a hook-writing guide in the agent kit. |
| 20 | **Viral / virality scoring** | opus (trend data), creatify (creative score) | **(d)** | — | We have no performance data and can't back a score. Out of scope. |
| 21 | **Auto-posting / scheduling** | revid, opus, submagic, vizard, creatify | **(d)** for v1 | — | Out of scope, and it carries platform-API compliance risk. Offer a render-finished webhook or SSE (`/v1/jobs/:id/events` exists) so buyers wire n8n/Zapier/their agent. Document that path. |
| 22 | **Clip from long video** (highlights, reframe) | opus, vizard, submagic | **(d)** | — | A different product (transcription + highlight detection + reframing). Out of scope. Say so in the FAQ so clipping buyers don't refund. |
| 23 | **Dubbing with lip-sync** | heygen, pictory | **(d)** | — | Out of scope. |
| 24 | **Web editor / timeline UI** | all SaaS peers, remotion.dev | **(b)** later | Optional web UI (#15), not started | Don't show an editor. Show manifest JSON, the API and renders instead. |
| 25 | **Team workspaces / collaboration** | opus, invideo, vizard, heygen | **(d)** | Single-tenant; multiple scoped API keys | Frame it as "one server, many keys". Seats are a licence term, not a feature. |
| 26 | **Other aspect ratios (16:9, 1:1)** | opus, vizard, pictory | **(b)** | Default preset 1080×1920@30; other presets unverified | Verify before listing. Stay focused on 9:16. |

**Top 5 to build before launch, by sales impact:**
1. Agent platform A1/A2 finished and tested with Claude Code and Codex.
2. 8–12 templates + 6–8 themes.
3. A gallery render script.
4. Caption burn-in + presets.
5. A live-verified ElevenLabs integration.

---

## 7. Claims we must NOT make yet

1. **"No per-video fees"** without a qualifier. Say **"no per-video fees to ReelForge"**: Remotion bills companies over 3 people ($0.01/render, $100/month minimum), and TTS providers bill per use.
2. **"Render on your AWS / Remotion Lambda."** The backend is a stub in v0.1.
3. **"Auto captions"** or named caption styles. Schema only; no burn-in yet.
4. **"ElevenLabs voiceover works."** Tested only against a mock.
5. **"Works with any AI agent."** Say "any MCP client" only once A2 ships, and name only the clients we actually tested (Claude Code and Codex first; Cursor once tested).
6. **"First" / "only" agent-native video studio.** revid, invideo, pictory, opus, submagic and creatify all market agent or MCP access.
7. **View, reach or "viral" outcomes**, virality scores, or "+X% views".
8. **User counts, testimonials, customer logos, review badges.** We have no customers yet. Use real ones only, with permission.
9. **SOC 2, GDPR-compliant, ISO, or any certification badge.** Instead say "runs on your infrastructure; ReelForge itself sends no telemetry", and list the egress.
10. **"Fully offline" without caveats.** Chrome Headless Shell may be downloaded at install, the TTS provider is online, and fetched assets are online.
11. **Avatars, stock B-roll, auto-posting, dubbing, clip-from-long-video, voice cloning as features.** At most "Bring your key", and only with a working plugin.
12. **Windows support.** WSL is untested.
13. **"Lifetime updates"** unless the founder decides that (Q4 proposes one year).
14. **Hard-coded prices or strikethrough "was" prices** that never applied. Fake scarcity counters.
15. **"Upstream Motion Canvas is maintained"**, or any implied partnership or endorsement from Remotion or HeyGen (HyperFrames). Use the factual "uses X (licence)" form.
16. **Render-speed numbers** without the hardware, version and date they were measured on.
17. **Tested Docker / one-command install** until STATUS A4 is verified on a clean machine.

---

*Research artefacts:*
- `/tmp/claude-0/-home-user/91c022dd-328d-5abd-9833-cfc66824b3fd/scratchpad/design-research/shots/remotion.dev-hero.png` (the only screenshot that wasn't blocked)
- `/tmp/claude-0/-home-user/91c022dd-328d-5abd-9833-cfc66824b3fd/scratchpad/design-research/shots.cjs` (screenshot script)
