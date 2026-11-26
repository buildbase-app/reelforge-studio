# Affiliate program and creator selling: research and plan

> ReelForge is now RenderWeld (#408). This record keeps the names it was written with; [RENAMED.md](../RENAMED.md) maps each old name to the new one.

**Status:** research and plan only (2026-11-23). Nothing here is built or configured.
**Epic:** #216. **Founder request (2026-11-23):** "add affiliate program and selling
program into reelforge project so that we can sell and our end users can sell using our
platform, and also use our own affiliate program to increase sales".
Not legal or tax advice: every legal and tax point below needs the founder's adviser.
ReelForge is source-available, not open source.

## Summary

| Program | Decision or recommendation |
| --- | --- |
| **A. ReelForge's own affiliate program** (affiliates earn on Commercial licence sales) | Use **BuildBase's native affiliates** (programs, `?ref=` links, affiliate coupon codes, holds, refund clawback, PayPal/Wise/Stripe payouts, ready-made `<AffiliateJoin>`, `<AffiliateDashboard>`, `<AffiliatePayoutSetup>`). No third-party tool: each one duplicates BuildBase and costs USD 49 to 1,000 a month. Launch **after 2026-12-16**: Ship or Die deducts affiliate payouts as ad spend. Draft the terms and prepare the dev environment before. |
| **B. Creators sell what they make with ReelForge** (reels, templates, themes, presets, prompt packs, music beds) | **DECIDED (founder, 2026-11-23): Option A, creator storefronts.** Each creator sells through their own Stripe connected account, as seller of record, and owns their tax. Stripe does KYC. ReelForge provides the packaging tools, the storefront and listing pages, and discovery. This maps to BuildBase Selling in the **storefront shape** (direct charges on the creator's account). **DECIDED: creators pay ReelForge a monthly Creator subscription.** Recommendation: no per-sale application fee at launch (§4.3). ReelForge is **not** merchant of record. |
| **Before 2026-12-16** | Studio packaging tools (`export_package`, `validate_package`, listing facts, export presets for Gumroad, Etsy, Envato or a creator's own site), the licence wording that lets creators sell what they make, the "Sell what you make" guide, the affiliate and creator terms drafts, the founder decisions and the upstream requests. All of these earn nothing for affiliates and move no creator money through ReelForge. |
| **After 2026-12-16** | Affiliate launch, then creator storefronts on the store (onboarding via Connect, Creator subscription with listing limits, listing pages, checkout, downloads and import, moderation), then memberships and custom orders. |

## 1. Context and constraints

- **Licence today** (`LICENSING.md`, `COMMERCIAL-LICENSE.md` draft): noncommercial use is free
  under PolyForm Noncommercial 1.0.0 with a Personal key; commercial use needs a paid one-time
  Commercial licence; resale, rebranding, redistribution and hosting for others are not permitted.
  `COMMERCIAL-LICENSE.md` §4 already says output is the buyer's. Selling anything is commercial use,
  so **every creator who sells needs a Commercial licence** (§4.6).
- **Studio** is single-tenant and self-hosted; "billing inside the studio" and "a template
  marketplace" were out of scope for v0.1 (`docs/AGENT_PLATFORM.md` §9). This plan keeps billing
  in the store and BuildBase; the studio only packages and imports.
- **Security** (D-085, D-086, `docs/security/HARDENING.md`): agent HTML for `html` and
  `hyperframes` scenes is parsed, CSP-wrapped and network-isolated. Remotion still hard-codes
  `--no-sandbox` and renders built-in templates only. So **third-party packs must be data, not
  code**, until render isolation (#29) is done.
- **Store** (Next.js 16 on Cloudflare Workers, `@buildbase/sdk` ^1.8.0): own-store items
  (`seller: { type: 'org' }`), licences, signed BuildBase webhooks into D1 (the production
  endpoint subscribes to `*`, read from the console 2026-11-23), the SDK `CookieBanner` with
  `consent.set`, and a per-request nonce CSP with `strict-dynamic` (store #17).
- **Hackathon** (`docs/research/SITE_PLAN.md` §E.1): score = profit received
  2026-11-16 to 2026-12-16 13:00 UTC minus refunds, fees and ad spend; affiliate payouts count
  as ad spend; client services are probably excluded (#56, #38). Live selling still waits on #90.

## 2. What BuildBase already provides

All read on docs.buildbase.app on 2026-11-23 (§12). The ReelForge org's selling settings could
not be read: `/api/marketplace/settings` needs an admin key, not an agent session (asked
read-only, 2026-11-23).

| Need | BuildBase | Where |
| --- | --- | --- |
| Affiliate programs on our own items | Yes: up to 20 programs; percent (bps) or fixed; click window 1 to 365 days; hold 0 to 120 days; join `open`/`approval`/`invite`; tiers; levels (off by default) | /billing/affiliates |
| Links and codes | `?ref=<code>` → `POST /api/v1/guest/:orgId/referrals/click` → signed token kept first-party, last click wins; `captureReferral()`; `<BuyButton>` sends it. Affiliate coupons (`affiliateId`) and `codeOnlyAttribution` (the code refers with no discount) | /billing/affiliates, /billing/coupons |
| Refund clawback | A refund takes back the commission's share; after payout a `clawback` row offsets the next payout; disputes hold commissions | /billing/affiliates#commissions |
| Payouts | Daily batching; `transfer` (Stripe), `paypal` (our PayPal Business), `wise_export` (CSV we pay), `manual`; `minPayout`; destination change confirmed by email and held 24 to 72 h | /billing/affiliates#payouts |
| Fraud basics | Refused referrals: `self_referral`, `buyer_is_seller`, `affiliate_is_seller`, `affiliate_inactive`, `pending_cap` (1,000); ban voids unpaid commissions | /billing/affiliates#what-earns-nothing |
| Affiliate events | `affiliate.joined`, `affiliate.approved`, `commission.created`, `commission.paid`, `commission.reversed` | /billing/affiliates#events |
| Users selling | Selling on Stripe Connect, **storefront** (direct charge on the seller's account, seller refunds and disputes) or **marketplace** (we take the money). The shape locks once the first seller joins. Our own store keeps selling beside sellers in either shape | /billing/selling |
| Seller onboarding | `<SellerHome>` with Stripe's embedded onboarding (needs `connect-js.stripe.com` and `js.stripe.com` in `script-src` and `frame-src`); seller approval by hand optional | /billing/first-sale-storefront |
| Connected-account events | BuildBase's Connect endpoint ("Set it up for me") brings sellers' payments, refunds, disputes and renewals; our server gets `order.*`, `grant.*`, `payout.*`, `seller.status_changed` | /billing/first-sale-storefront, /webhooks/overview |
| What creators list | Item types (fields, pricing incl. subscriptions, delivery: files, link, licence key, access, manual); **review queue** (approve or reject with a reason); **listing limit from our own plans** (`ITEM_LISTING_LIMIT`); buyer-country limits | /billing/item-types, /billing/items |
| Files for buyers | `file` benefit: release series, versioned releases, up to 20 files each; every file carries a **malware scan status** (`pending`, `clean`, `infected`, `failed`, `not_scanned`) | /billing/orders#files, `me.files.list` |
| Seller extras | Seller coupons, seller-run affiliate programs (3 each), sales export, `<SellerSales>`, Stripe Tax per seller (`seller_choice`) | /billing/coupons, /billing/selling#tax-at-checkout |
| Charging creators | Plans for users (`payerType: user`), add-ons, coupons; plans are versioned | /billing/users-and-workspaces, /blueprints/file-format |
| Measurement | `ref` and `via` kept by the attribution record (marketing cookie `bb_attr`, 90 days, after consent); sales export gains `affiliate_code` and `commission` | /tracking/consent |
| Config as code | Blueprints cover app, auth, email, `billing` (plans, items, add-ons, Stripe promotion codes), RBAC, webhooks, integrations, data, workflows. **Not** selling settings, item types, item coupons or affiliate programs | /blueprints/file-format |

**Gaps** (each becomes an upstream request, §8): no blueprint section for selling; no tax-form
(W-9/W-8) collection or 1099-NEC for affiliate payouts by PayPal, Wise or manual; the docs do
not say which Stripe Connect configuration sellers and affiliates get; no "report this item"
flow; no rule for live items when a creator's plan lapses; no signed release digests.

## 3. Affiliate program

### 3.1 Options compared

Third-party prices are from vendor-comparison pages (not the vendors' own pages unless noted)
and need a check before any purchase.

| Option | Cost | Fits BuildBase checkout? | Refund clawback | Payouts | Verdict |
| --- | --- | --- | --- | --- | --- |
| **BuildBase native** | Included | Native: `<BuyButton>` sends the referral | Native | Stripe, PayPal, Wise, manual | **Recommended** |
| Rewardful | USD 49/99/149+ a month by attributed revenue | Reads Stripe customers; BuildBase creates the Checkout Session, so we cannot add its referral id (VERIFY) | From Stripe refunds | Managed payouts +3% | No: duplicate attribution |
| Tolt | USD 69 to 199 a month; auto payouts +2% | Same Stripe-side problem | Yes | PayPal, Wise | No |
| FirstPromoter | USD 49/99/149+ a month | Same | Yes | Several | No |
| Dub Partners | About USD 90/300 a month + 3 to 5% of payouts | Same | Yes | Stripe Express, PayPal | No |
| PartnerStack | About USD 1,000 a month, annual, sales-led | Same | Yes | Own rails | No: cost |
| Lemon Squeezy | 5% + 50¢ per sale, +3% on affiliate orders | Needs Lemon Squeezy as checkout and MoR; new sign-ups reportedly gated in 2026 | Yes | Own | No: leaves BuildBase |
| Paddle | MoR fee | Needs Paddle checkout; no affiliate product found | n/a | n/a | No |
| DIY on Stripe | Engineering time | We would rebuild BuildBase | Ours | Ours | No: founder rule |

### 3.2 Attribution, consent and CSP

- **Consent.** The EDPB reads URL and pixel tracking and terminal storage as inside Art. 5(3)
  ePrivacy (Guidelines 2/2023 v2, adopted 2024-10-07). BuildBase itself treats `bb_attr` as a
  marketing cookie from SDK 1.0.0. **Recommendation:** store the referral token only after
  marketing consent: on landing, keep `ref` in memory; call `captureReferral()` (or the click
  route) once `consent.effective.marketing` is true; never on refusal. Region defaults follow the
  store's existing banner settings.
- **Attribution without storage.** Turn on `codeOnlyAttribution` and give every affiliate a code:
  a buyer who refused cookies can still type it at checkout (`<BuyButton coupons>`). This is the
  consent-free path.
- **CSP and Workers.** No third-party script: the click is one `fetch` to the BuildBase API the
  SDK already calls (check it is in `connect-src`). Call it from the browser, not from a Worker
  route: the click route is rate limited per address and code, so all clicks proxied from
  Cloudflare egress addresses would share one limit (VERIFY with BuildBase).
- **Window and model.** Last click, 30 days (BuildBase default). `coupon_wins` when a link and a
  code disagree.

### 3.3 Commission, refunds and clawback

Recommendation (founder decision D-A2): **25% of net** on Commercial licence lines; free Personal
claims earn nothing (BuildBase refuses free orders); tiers forward-only (30% from the 10th paid
referral in a calendar quarter); levels off (multi-level rules, FTC). **Hold = refund window
+ 14 days** (30 days if #97 sets a 14-day window), so most refunds land before money leaves.
Clawback is native; the store mirrors `commission.*` into D1 for reporting. Coupons: dated
codes only (#54 policy), 10% off with an end date, one per affiliate.

### 3.4 Payouts and tax

- **Methods:** `paypal` and `wise_export` for everyone, `transfer` for affiliates in our Stripe
  country (Stripe recipient accounts often cannot take cross-border payouts, per BuildBase docs).
  No `manual` (no sanctions screening). `minPayout` USD 50. PayPal payouts need the platform's
  PayPal switch, which may be off: verify in the dev console.
- **US tax:** affiliates are paid by the ReelForge legal entity, so we collect W-9 (US) or
  W-8BEN/W-8BEN-E (non-US) before the first payout, and file **1099-NEC** for US affiliates paid
  at least **USD 2,000 in tax year 2026** (raised from USD 600 by the One Big Beautiful Bill Act;
  inflation-indexed from 2027). BuildBase collects no tax forms: upstream request, and an adviser
  decides the interim (Stripe transfer for US affiliates, where Stripe collects tax details in
  onboarding, VERIFY).
- **VAT:** commissions from VAT-registered EU/UK affiliates are B2B services (reverse charge);
  agree self-billing invoices in the terms.
- **Merchant of record:** ReelForge is already seller of record for its own licences (own
  store on our Stripe account); affiliates do not change that.

### 3.5 Fraud rules

Native: self-referral, seller/affiliate overlap, pending cap, bans, destination-change hold.
Ours (terms + runbook): `approval` join; no bidding on "ReelForge" or misspellings; no coupon
or deal sites; no cookie stuffing (iframes, pop-unders, forced clicks); disclosure required;
weekly review of refund rate and order velocity per affiliate from the commissions CSV; ban
voids unpaid commissions; Personal (free) claims never earn.

### 3.6 Terms, dashboard, assets and measurement

- **Terms** (legal): eligibility, approval, commission and hold, refunds and clawback, payout
  methods and minimum, tax forms, disclosure ("paid link" next to the link is acceptable, "affiliate
  link" alone is not, per the FTC's 2023 Endorsement Guides FAQ), prohibited methods, trademark
  use, termination, data protection.
- **Pages:** public `/affiliates` (program terms via `useAffiliateProgram`, join), private
  `/dashboard/affiliate` (`<AffiliateDashboard>`, `<AffiliatePayoutSetup>`). The Stripe Connect
  embed needs `connect-js.stripe.com` only on that private page (page-scoped CSP).
- **Marketing kit:** links, codes, banned claims (`DESIGN_BRIEF.md` §7), reels from the gallery,
  disclosure text, on BuildBase Assets and Docs.
- **Measurement** (#45): revenue by affiliate and by `utm_source`, commission cost, refund rate,
  net margin per channel; affiliate cost reported as ad spend.

## 4. Creators selling what they make

### 4.1 Commercial model

| | **A. Creator storefronts (DECIDED)** | B. Marketplace, ReelForge MoR | C. Hybrid and external |
| --- | --- | --- | --- |
| Shape | BuildBase storefront: direct charge on each creator's connected account | BuildBase marketplace: charge on our account, transfer to creators; or an MoR provider | Discovery on our store with A's checkout; or listing on Gumroad, Etsy, Envato |
| BuildBase support | Native (onboarding, items, files, review, coupons, seller affiliate programs, Stripe Tax per seller) | Native for money flow; tax registrations and filings are ours | A is native; external marketplaces need only studio export tools |
| Tax burden on ReelForge | Lowest. Creator is seller of record. Caveats: EU e-services "deemed supplier" (Art. 9a Reg. 282/2011) and US marketplace-facilitator laws may still reach us (§4.7) | Highest: EU/UK VAT (OSS/IOSS), US state sales tax registrations, 1099-K/DAC7 reporting duties as applicable | None for external marketplaces (Gumroad is MoR since 2025-01-01; Etsy remits as facilitator) |
| MoR providers | n/a | Paddle's AUP bars marketplaces for non-Paddle sellers; Lemon Squeezy and Stripe Managed Payments do not do multi-vendor payouts; FastSpring has partner split payouts but no documented marketplace (VERIFY) | n/a |
| Creator friction | Stripe onboarding (5 to 10 min), Commercial licence, subscription | Email + Stripe onboarding | External account per marketplace |
| Buyer UX | One page per creator in a cart (storefront carts go in steps) | One page for a cart | Leaves our site |
| Refunds, chargebacks | Creator's (their Stripe balance) | Ours | Marketplace's |
| Time to first sale | After the storefront ships (January 2027 realistic) | Longer (tax work) | Days after the studio export tools ship |
| Phase | After 2026-12-16 | Considered, not now | External: before 2026-12-16 |

### 4.2 Stripe Connect account type and costs

Read on stripe.com and docs.stripe.com, 2026-11-23:

| Configuration (controller properties) | Who pays Stripe fees | Negative balances | Dashboard | Connect fees to ReelForge |
| --- | --- | --- | --- | --- |
| **Standard-like:** `fees.payer=account`, `losses.payments=stripe`, `stripe_dashboard=full` | The creator ("Stripe handles pricing") | **Stripe**, on payments the account cannot repay; on direct charges fraud and disputes are the connected account's | Full | **None**: no account, payout or tax-reporting fees; Stripe files 1099-K for Standard accounts |
| Express-like: `fees.payer=application`, `losses=application`, `express` | ReelForge ("you handle pricing") | ReelForge | Express | **USD 2 per monthly active account** (active = a payout that month), **0.25% + 25¢ per payout**, 1099 e-file USD 2.99 (IRS) and 1.49 (state); ReelForge files 1099s |
| Custom-like: `application` everything, no dashboard | ReelForge | ReelForge | None | As Express, plus we collect requirements |

Instant payouts 1%, cross-border payouts from 0.25% in both models. **Recommendation:**
Standard-like (or Accounts v2 with the creator paying fees and Stripe liable): lowest cost,
least liability, supports one-off sales and subscriptions on direct charges, and Stripe owns
KYC. **Never** choose "we pay Stripe's fee" in BuildBase's Money step. **Unknown:** which
configuration BuildBase creates for sellers (its docs say storefront "Stripe's fees: the seller's,
or yours if you choose"). Step ticket: read a test seller's `controller` in Stripe test mode
before pricing is final, and an upstream doc request. Stripe Tax (0.5% per transaction where
registered, pay-as-you-go) runs on each creator's account in the storefront shape and is the
creator's choice and cost (`taxMode: seller_choice`).

### 4.3 Creator subscription

**DECIDED:** creators pay ReelForge monthly. **Native fit:** a BuildBase plan for users
(`payerType: user`) with a `listings` limit, and creator item types whose listing limit reads
that plan, so publishing over the limit answers `ITEM_LISTING_LIMIT` (402).

- **Cost floor per active creator a month.** Worst case (Express-like): USD 2 + payouts (four
  payouts of USD 125 ≈ USD 2.25) ≈ USD 4.25, plus the cost of charging the subscription itself
  (Stripe Billing 0.7% of billing volume, card fees, VERIFY whether BuildBase plans incur
  Billing fees). Best case (Standard-like): only the subscription's own charge, under USD 1.
- **Proposed tiers** (founder decision D-B3; prices exclude tax):

| Tier | Price | Live listings | Files | Includes |
| --- | --- | --- | --- | --- |
| Creator | USD 12/mo or 120/yr | 15 | 5 GB | Storefront page, packaging tools, standard placement, seller coupons |
| Pro | USD 29/mo or 290/yr | 100 | 25 GB | Featured-slot eligibility, own affiliate program for their items, sales analytics |
| Studio | USD 79/mo or 790/yr | 500 | 100 GB | Workspace seller (team), priority review, a featured slot each month |

- **Licence prerequisite (recommended):** an active **Commercial licence** before onboarding
  (selling is commercial use). The store checks the buyer's licence grant before showing
  `<SellerHome>`. Bundling a licence into a subscription would mix the one-time model (D-004)
  with recurring rights; not recommended.
- **Application fee per sale:** **0% at launch** (recommended). It keeps the offer simple
  against Gumroad (10% + 50¢ direct, 30% via Discover) and Etsy (about 6.5% + listing and
  processing fees) and keeps one price lever in reserve. BuildBase supports it (`feeRule`) if
  needed later, for example 5% on Creator only.
- **Enforcement when a subscription lapses:** BuildBase blocks new publishes over the limit;
  what happens to live items is not documented. Bridge: the store's webhook handler unlists the
  creator's items over the limit through `/api/v1/server/commerce/items/:id` on the
  subscription-ended event, and lists them again on renewal. Upstream request for native behaviour.
- **Storage:** creator files count against the ReelForge org's BuildBase storage (VERIFY limits
  and price), so tiers cap files.

### 4.4 Packaging in the studio

New capability on `ReelforgeService`, REST + MCP with parity (AGENTS.md conventions):

| Tool | Does |
| --- | --- |
| `export_package` | Builds a pack from a project, theme or scene set: copies data, renders a short **preview reel** (MP4 + poster) as a normal render job, writes `reelforge-pack.json`, SHA-256 per file and a pack digest; writes atomically |
| `validate_package` | The same checks import uses, for sellers before upload and for the moderation job |
| `import_package` | Upload or URL import (existing SSRF guard and byte caps); verifies digest, schema, content policy; installs themes and templates under a vendor namespace (`vendor/<seller>/<pack>`); never overwrites built-ins |
| `list_packages`, `remove_package` | Installed packs with version, source and digest |
| `get_listing_facts` | Structured facts for a listing (kind, engines, duration, aspect ratios, preview files, licence, requirements). The agent writes the copy; the server has no LLM |

**`reelforge-pack.json` v1:** `packVersion`, `id`, `name`, `version` (semver), `kind`
(`template-pack`, `theme`, `project-template`, `preset`, `prompt-pack`, `reel`, `music-bed`),
`title`, `description`, `author` (display name), `buyerLicence` (`personal`, `commercial`,
`extended`, or a URL), `requires` (engines, minimum studio version, manifest `schemaVersion`),
`contents[]` (path, media type, bytes, sha256), `preview` (poster, reel), `createdWith`.
**Content policy v1:** data only: manifests, theme tokens, `html`/`hyperframes` scene markup
(already treated as untrusted, D-085), images, audio, video, fonts with provenance, Markdown and
JSON prompts. Refused: Remotion or Motion Canvas code, executables, symlinks, absolute or `..`
paths, SVG with scripts, archives over the entry-count or byte caps. **Signing:** v1 = digests
shown on the listing and checked on import; v2 = signed digests (Sigstore or a BuildBase-signed
release digest, upstream request).
**Export presets** for external marketplaces: MP4 9:16/1:1/16:9, poster sizes, a zipped pack,
and a listing text skeleton for Gumroad, Etsy, Envato and a creator's own site.

### 4.5 Buyer side: checkout, entitlements, import

Buyer pays on the creator's account (`<BuyButton>`, guest checkout allowed) → BuildBase grant
→ `file` benefit download from the store's `/dashboard/purchases` (`<HoldingFiles>`) → the
buyer's agent calls `import_package` with the file. Packs stay DRM-free (like Envato and
Gumroad); the buyer licence and the creator terms protect them. The buyer's studio needs its
own licence; rendering a bought template for commercial work needs a Commercial licence.

### 4.6 Rights, licences and trust

**PolyForm Noncommercial 1.0.0** permits noncommercial purposes only, so a Personal-key user
who sells reels or packs needs a Commercial licence. **Wording changes** (maintainer-only
files; founder and lawyer, with #97):

1. `LICENSING.md` "At a glance": add "Sell reels, templates, themes, presets or prompt packs
   you made with ReelForge → Commercial licence"; make clear the resale row covers ReelForge
   itself, not the user's own creations.
2. `COMMERCIAL-LICENSE.md` §3: "This section does not restrict selling or licensing Your
   Content (§4)". §4: define Your Content (videos, manifests, templates, themes, presets, prompt
   packs, scene markup you author), excluding ReelForge code, built-in templates and themes,
   and assets you have no rights to; buyers need their own ReelForge licence.
3. `TRADEMARK.md`: "made for ReelForge" and "compatible with ReelForge" allowed in listings;
   no logo as the creator's own brand.
4. New store documents: **Creator terms** (seller of record, tax, refunds and disputes,
   warranties on content rights incl. music and fonts, subscription and listing limits,
   takedown, termination), **buyer asset licences** (personal, commercial, extended/agency),
   **fee disclosure**. BuildBase requires seller terms and a refund policy before selling opens.

**Trust:** BuildBase item review (approval on), BuildBase malware scan, ReelForge pack review
(an ops-run studio runs `validate_package` and a test render in isolation and records the
result), reports via a BuildBase Form, a takedown runbook, a **DMCA designated agent**
(USD 6, renewed every three years). EU DSA: hosting duties (Arts. 11 to 17, notice and action,
statement of reasons) apply to us; marketplace trader-traceability (Art. 30) does not apply
to micro and small enterprises (Art. 29), VERIFY our size class.

### 4.7 Refunds, disputes and tax

- **Refunds and disputes are the creator's** (storefront): they refund from `<SellerSales>`
  and answer disputes in their own Stripe Dashboard. Our policy: creators must honour a
  minimum refund rule for broken or misdescribed packs; ReelForge may refund from the console
  and will pause sellers with high dispute rates.
- **Tax:** creators own it (Stripe Tax optional on their account). Caveats for the adviser:
  (a) EU Art. 9a: a platform that authorises the charge or delivery, or sets the general terms,
  cannot name the creator as supplier of e-services, so ReelForge could be the deemed supplier
  for EU B2C sales even in the storefront shape; (b) Stripe warns that US and EU marketplace laws
  may make the platform liable; (c) DAC7: sales of digital goods are outside "sale of goods"
  (tangible only), but custom orders and services are "personal services" and reportable.
  **Mitigation until advice:** item types limit buyer countries (native) so EU/UK B2C sales
  open only after the adviser agrees.
- **1099-K:** Stripe files for Standard-like accounts; the platform files for Express/Custom.
  Threshold restored to more than USD 20,000 and more than 200 transactions (IRS FAQ).

### 4.8 Creator affiliate tie-in

Creators join ReelForge's affiliate program like anyone (§3) and put their link in listings
("needs ReelForge"); `get_listing_facts` can include it. Later, Pro creators run their own
seller programs (BuildBase `sellerPrograms`) for their items.

### 4.9 Ranking of earning models

| Rank | Model | BuildBase | Effort | Creator revenue | ReelForge revenue | Legal/licence | Main risk | First sale | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Creator storefronts (DECIDED) | Native | L | High | Subscriptions + more Commercial licences | Clauses in §4.6 | Moderation load; EU VAT caveat | ~Jan 2027 | After |
| 2 | Sell anywhere: export presets + listing facts for Gumroad, Etsy, Envato, own site | Not needed | M | Medium | Commercial licences | Same clauses | No platform revenue | Days after the tools ship | **Before** |
| 3 | Creator affiliate tie-in | Native | S | Low to medium | Licence sales | Affiliate terms | Ad-spend accounting | With §3 | After |
| 4 | Memberships (monthly packs) | Native item subscriptions | S | Recurring | Subscriptions | Subscription law | Churn, support | After 1 | After (phase 2) |
| 5 | Custom orders and done-for-you reels | Native (apply-first checkout, `manual` benefit, bookings) | M | High per order | Subscriptions | DAC7 reporting; services | Disputes, quality | After 1 | After (phase 2) |
| 6 | Extended/agency licence for packs | Native (variants) | S | Higher prices | Indirect | Buyer licence text | Licence confusion | With 1 | With 1 |
| 7 | Stock reels, per-use licences | Partly (licence keys) | L | Medium | Indirect | Per-use licence law | Enforcement | — | Considered |
| 8 | Bounties and challenges | No | M | Low | Marketing | Prize-promotion law | Moderation | — | Considered |
| 9 | Revenue share per render | No | L | Unclear | Unclear | Needs telemetry from self-hosted studios | Conflicts with no-telemetry rule; gameable | — | Not planned |
| 10 | Marketplace with ReelForge as MoR (Option B) | Money flow native | XL | High | Fees | Full tax burden | Tax, refunds, chargebacks on us | — | Considered, not now |

**Other ideas, not planned** (licence reasons): reselling ReelForge licences, running the
studio for clients (both forbidden by `COMMERCIAL-LICENSE.md` §3 and would need a partner
agreement), and a services marketplace (#38 is our own service, on hold until after the
hackathon because client services do not count).

## 5. Architecture

| Layer | Affiliate program | Creator storefronts |
| --- | --- | --- |
| **BuildBase** | Program, codes, referral tokens, attribution, commissions, holds, clawback, payouts, affiliate emails, events | Selling (storefront), Connect onboarding and endpoint, item types, review, files and scans, checkout (direct charges), grants, refunds, payouts, Creator plan and listing limits, seller coupons |
| **Store** | Consent-gated `captureReferral`, code field at checkout, `/affiliates`, `/dashboard/affiliate`, D1 mirror of `commission.*` (dedupe by event `id`), reports | `/creators`, `/market`, listing pages, `/dashboard/selling` (`<SellerHome>`, `<SellerItems>`, `<SellerFiles>`, `<SellerSales>`, `<SellerCoupons>`), licence prerequisite check, lapse handler, report form |
| **Studio** | Nothing | `export_package`, `validate_package`, `import_package`, `list_packages`, `remove_package`, `get_listing_facts`; vendor namespace; no billing, no telemetry |
| **Ops** | Fraud review, payouts, tax forms | Pack review job (isolated studio), approvals, takedowns |

Creator flow: studio `export_package` → store `<SellerItems>` upload (BuildBase scan) → review
(BuildBase approval + pack review result) → listing → buyer checkout on the creator's account →
grant → download → buyer studio `import_package`.

## 6. Enterprise concerns

- **Isolation:** BuildBase scopes seller and affiliate routes to their own rows; sellers see
  affiliates' emails only with consent (`affiliateContact: hidden` default). The store never
  stores bank details, TINs or identity documents (Stripe, PayPal, Wise and BuildBase do).
- **Webhooks:** keep `parseWebhookEvent` (HMAC-SHA256, five-minute replay window); dedupe by the
  payload's `id` (`evt_…`) instead of a body hash; handlers idempotent.
- **Compliance:** GDPR (consent records via `consent.set`, BuildBase proof of consent, erasure
  keeps financial records anonymised), ePrivacy, FTC disclosure, DSA hosting duties, DMCA,
  sanctions (Stripe, PayPal and Wise screen; no manual payouts), KYC by Stripe.
- **Auditability:** BuildBase audit rows for payout destination changes and ban/approve
  actions; commissions and sales CSV exports; store D1 mirror; decisions in `docs/DECISIONS.md`.
- **Abuse:** fraud rules §3.5; pack content policy §4.4; review and takedown §4.6; seller pause.

## 7. Phases and the 2026-12-16 deadline

| Phase | When | What |
| --- | --- | --- |
| 0 | Now to 2026-12-16 | Founder decisions, licence wording, affiliate and creator terms drafts, tax adviser booked, upstream requests, studio pack format + export/validate tools + listing facts and presets, "Sell what you make" guide; affiliate and selling setup scripted for dev (not applied) |
| 1 | 2026-12-17 to mid-January | Affiliate launch (dev e2e, then production); Stripe configuration verified; storefront shape in dev; Creator plans; onboarding; listings; checkout; downloads; import; moderation; e2e on dev |
| 2 | After phase 1 | Production storefronts (after the adviser's EU/US answer), memberships, custom orders, seller affiliate programs |

## 8. Upstream BuildBase requests

To file on the BuildBase tracker, linked from #100: (1) blueprint sections for selling settings,
item types, item coupons and affiliate programs; (2) docs: which Stripe Connect configuration
sellers and affiliates get, and who files 1099-K/1099-NEC; (3) tax-form collection and 1099-NEC
for affiliate payouts; (4) what happens to live items when a seller's plan drops below the
listing limit, and an option to unlist automatically; (5) "report this item" with notice,
action and statement of reasons; (6) signed release digests for `file` benefits; (7) reconcile
the docs on seller events ("no webhook event about a seller's account" vs
`seller.status_changed`); (8) read access for console agents to selling settings.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Live selling not granted (#90) | Everything in phase 1 runs in dev with test keys |
| Storefront shape is irreversible once a seller joins | Founder decision recorded; first seller only after the dev e2e |
| ReelForge deemed supplier for EU VAT, or facilitator in US states | Adviser before EU/UK B2C; buyer-country limits meanwhile |
| Malicious packs | Data-only policy, scans, review job, D-085 isolation; no code packs until #29 |
| Affiliate fraud, brand bidding | Approval join, hold, runbook, bans |
| Low creator uptake | Phase 0 "sell anywhere" proves demand before storefront work |
| Unknown Connect configuration raises costs | Verify first; tier prices cover the worst case |

## 10. Founder decisions

**DECIDED (2026-11-23):** D-B1 creator storefronts (Option A), creators are sellers of record,
Stripe does KYC, ReelForge is not MoR; D-B2 creators pay a monthly Creator subscription;
D-B0 the selling program means users selling what they make with ReelForge (not resale).
**Open, with recommendations:** D-A1 BuildBase native affiliates (yes); D-A2 25% of net, 30-day
window, hold = refund window + 14 days, approval join, levels off; D-A3 payout methods PayPal +
Wise (+ Stripe transfer in-country), minimum USD 50, no manual; D-A4 launch after 2026-12-16;
D-B3 Creator tiers and prices (§4.3); D-B4 0% application fee at launch; D-B5 Commercial licence
required to sell; D-B6 Standard-like Connect configuration; D-B7 data-only packs until #29;
D-B8 buyer countries limited until tax advice; D-B9 licence wording (§4.6) with the lawyer.

## 11. Step tickets

Epic #216 (child of #78). Phase "before" = before 2026-12-16. #54 is folded in as a child
of #216; each of its criteria maps to a step below.

| # | Step | Phase | Est. |
| --- | --- | --- | --- |
| #217 | [ops] Founder decisions: affiliate program and creator storefronts | Before | S |
| #218 | [legal] Licence wording for selling reels and assets made with ReelForge | Before | S |
| #219 | [legal] Affiliate program terms and disclosure rules | Before (draft) | M |
| #222 | [ops] Upstream BuildBase requests for affiliates and creator selling | Before | S |
| #224 | [studio] Pack format v1: `reelforge-pack.json`, content policy and checksums | Before | M |
| #225 | [studio] `export_package` and `validate_package` with an automatic preview reel | Before | L |
| #227 | [studio] Listing facts and export presets for selling anywhere | Before | M |
| #228 | [docs] "Sell what you make with ReelForge" guide and store `/creators` page | Before | S |
| #226 | [studio] `import_package`, `list_packages`, `remove_package` | Before (stretch) / after | L |
| #220 | [legal] Creator terms, seller obligations, buyer asset licences, takedown policy | After | M |
| #221 | [ops] Tax and compliance review with an adviser | After (book before) | M |
| #229 | [ops] Affiliate program setup in the development environment | After | S |
| #230 | [store] Consent-gated referral capture and affiliate code at checkout | After | M |
| #231 | [store] Affiliate pages: `/affiliates`, terms, `/dashboard/affiliate` | After | M |
| #232 | [store] Commission webhooks in D1, dedupe by event id, clawback check | After | S |
| #233 | [ops] Affiliate fraud rules and review runbook | After | S |
| #234 | [store] Affiliate marketing kit | After | S |
| #235 | [ops] BuildBase Selling in the storefront shape in development | After | M |
| #223 | [ops] Verify the Stripe Connect configuration BuildBase gives sellers (test mode, read only) | After | S |
| #236 | [store] Creator subscription billing and enforcement | After | M |
| #237 | [store] Creator onboarding via Stripe Connect and the seller dashboard | After | L |
| #238 | [store] Storefront and listing pages with discovery | After | L |
| #239 | [ops] Moderation and safety: pack review job, approval, reports, takedown | After | M |
| #240 | [store] Buyer checkout as direct charges, purchases, downloads, import hand-off | After | M |
| #241 | [store] Refunds and disputes on creator sales | After | S |
| #242 | [store] Creator affiliate tie-in | After | S |
| #243 | [store] Measurement: affiliate and creator attribution reporting | After | S |
| #244 | [store] E2E on the dev site in Stripe test mode | After | M |
| #245 | [docs] Docs for affiliates and creators; STATUS and DECISIONS | After | S |
| #246 | [store] Phase 2: creator memberships and custom orders | After (phase 2) | M |

## 12. Sources

All read on 2026-11-23 unless noted.

- BuildBase docs: https://docs.buildbase.app/billing/affiliates ·
  https://docs.buildbase.app/billing/selling · https://docs.buildbase.app/billing/first-sale-storefront ·
  https://docs.buildbase.app/billing/orders · https://docs.buildbase.app/billing/items ·
  https://docs.buildbase.app/billing/item-types · https://docs.buildbase.app/billing/coupons ·
  https://docs.buildbase.app/tracking/consent · https://docs.buildbase.app/blueprints/file-format ·
  https://docs.buildbase.app/http-api/reference/me/me-files-list ·
  https://docs.buildbase.app/http-api/reference/webhooks/seller-status-changed ·
  https://docs.buildbase.app/webhooks/overview
- BuildBase console (read only, ReelForge production org): webhooks list (endpoint subscribed to `*`);
  `/api/marketplace/settings` refused without an admin key.
- Stripe Connect pricing: https://stripe.com/connect/pricing
- Stripe controller properties: https://docs.stripe.com/connect/migrate-to-controller-properties ·
  account types and liability: https://docs.stripe.com/connect/accounts
- Stripe Tax pricing: https://stripe.com/tax/pricing · Stripe Tax with Connect: https://docs.stripe.com/tax/connect
- Stripe Billing pricing: https://stripe.com/billing/pricing
- Stripe 1099 for platforms: https://support.stripe.com/questions/1099-forms-for-platforms-and-marketplaces ·
  https://docs.stripe.com/connect/tax-reporting
- IRS 1099-K threshold FAQ: https://irs.gov/newsroom/irs-issues-faqs-on-form-1099-k-threshold-under-the-one-big-beautiful-bill-dollar-limit-reverts-to-20000 ·
  1099-NEC USD 2,000 for 2026: https://www.patriotsoftware.com/blog/accounting/1099-reporting-threshold/
- EU VAT Art. 9a Reg. 282/2011: https://www.legislation.gov.uk/eur/2011/282/article/9a/data.htm (retained text; check the EUR-Lex consolidated version)
- DAC7 scope: https://www.belastingdienst.nl/wps/wcm/connect/en/business/content/information-for-platform-operators-dac7
- DSA Art. 29: https://prighter.com/resources/laws/dsa/articles/article-29
- EDPB Guidelines 2/2023 v2: https://edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf
- FTC Endorsement Guides: https://www.ecfr.gov/current/title-16/chapter-I/subchapter-B/part-255 ·
  FAQ: https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking
- DMCA agent fee and renewal: https://www.copyright.gov/dmca-directory/faq.html
- PolyForm Noncommercial 1.0.0: https://polyformproject.org/licenses/noncommercial/1.0.0
- Gumroad pricing and MoR: https://gumroad.com/pricing
- Paddle AUP: https://paddle.com/support/aup/ (marketplaces for non-Paddle sellers barred, per search summary; re-read before relying)
- Lemon Squeezy affiliate fees: https://docs.lemonsqueezy.com/help/affiliates-for-merchants/fees ·
  multi-vendor and Managed Payments status (third party): https://www.turbostarter.dev/blog/lemon-squeezy-vs-stripe
- FastSpring partner payouts: https://developer.fastspring.com/docs
- Affiliate tool prices (third-party comparisons): https://costbench.com/software/affiliate-software/rewardful/ ·
  https://costbench.com/software/affiliate-software/tolt/ · https://thesubscriptionguide.com/software/tolt-vs-firstpromoter/ ·
  https://efficient.app/apps/dub-partners · https://www.costbench.com/software/affiliate-software/partnerstack/
- Etsy fees (third party): https://framekit.ai/blog/gumroad-vs-etsy-for-digital-products-2026 ·
  Envato author terms proposal May 2026: https://help.author.envato.com/hc/en-us/articles/57607655372185-Proposed-amendments-to-Market-Author-Terms-May-2026 ·
  Envato Elements subscriber share: https://help.elements.envato.com/hc/en-us/articles/360000629446-Subscriber-Share
