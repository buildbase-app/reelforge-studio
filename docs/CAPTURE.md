# Capture: screenshots, walkthrough videos and console setup for the docs

Visual proof for the docs (#78): every store page, the signed-in flows,
walkthrough videos of whole processes, terminal views of the studio and the
BuildBase console configuration, made by one reproducible command and shown on
four published pages:

| Page | What it shows |
| --- | --- |
| [docs/public/screenshots/store.md](public/screenshots/store.md) | Every store page at 390 and 1440 px, light and dark (test site), signed-in flows and pages, production for comparison |
| [docs/public/screenshots/studio.md](public/screenshots/studio.md) | Terminal sessions (API key, server start, `claude mcp add`, `/readyz`, `/metrics`, a render with progress), template contact sheets, the agent-session replay |
| [docs/public/walkthroughs.md](public/walkthroughs.md) | The walkthrough videos with their steps and what each proves |
| [docs/public/install/buildbase-console-setup.md](public/install/buildbase-console-setup.md) | The BuildBase configuration as code, secrets redacted; screens to photograph by hand: [CONSOLE_SCREENSHOTS.md](CONSOLE_SCREENSHOTS.md) |

The pages are generated from `scripts/capture/assets.json` (and the console
page from the environment's configuration): do not edit them, run the capture.

## Run it

```bash
pnpm i                                                # Playwright 1.63.0 (devDependency) and its Chromium
export BUILDBASE_API_TOKEN_FILE=/path/to/dev-env-token   # development environment token; only for --upload and console
export NODE_USE_ENV_PROXY=1                            # only behind an HTTPS proxy
pnpm capture --dry-run                                 # the plan; nothing captured, written or uploaded
pnpm capture --only pages --upload                     # store pages on both sites, then upload
pnpm capture --only flows,videos --store-dir ../reelforge-selling-public-site --reel final.mp4 --upload
pnpm capture --only studio --upload                    # local studio from this checkout
pnpm capture --only console                            # docs/public/install/buildbase-console-setup.md
pnpm docs:sync --env fsyqdskf                          # publish the pages to BuildBase Docs (docs/DOCS_PUBLISHING.md)
```

`pnpm capture` with no option runs every step against
https://reelforge-dev.buildbase.app and https://reelforge.buildbase.app.

| Option | Meaning |
| --- | --- |
| `--site <url>` | A site to capture (repeatable). Default: the test site and production. Flows and videos use the first test site (they refuse production) |
| `--only pages,flows,videos,studio,console` | Steps to run (comma list). Default: all |
| `--upload` | Upload new or changed images to BuildBase Assets in the development environment (`fsyqdskf`) and update the manifest |
| `--dry-run` | Plan only: lists what would be captured; with `--upload`, what would be uploaded or deleted |
| `--store-dir <dir>` | The store repository: walkthrough files are copied to `<dir>/public/walkthroughs/` (older files of the same walkthrough removed) |
| `--reel <final.mp4>` | The reel the recorded agent session rendered (for the agent-session video) |
| `--blueprint <a.json,b.json>` | Blueprint exports for the console page (default: `out/capture/inputs/*.blueprint.json`) |
| `--routes`, `--widths`, `--themes` | Narrow the pages step, e.g. `--routes /,/pricing --widths 1440 --themes dark` |
| `--out <dir>` | Work directory (default `out/capture`, git-ignored): images, videos, raw recordings, `results.json` |

Needs Node 22, ffmpeg 6+ with libwebp, libx264 and libvpx-vp9, and for the
studio step what the studio needs (`REELFORGE_CHROMIUM_PATH`, or Playwright's
Chromium is used) plus `claude` and `jq` for the `claude mcp add` and REST
views. `CAPTURE_CHROMIUM_PATH` picks another Chromium for the captures. One
browser runs at a time; at most two encodes run beside it.

## What each step does

- **pages** (`steps/pages.mjs`): every route in `targets.mjs` plus any path in
  the site's `/sitemap.xml`, at each width and theme. Waits for network idle
  and web fonts, scrolls the page once so lazy content loads, freezes motion
  (reduced motion, no animations or transitions, no caret) and takes the fold
  crop and the full page at deviceScaleFactor 2. A page marked `optional`
  (the gallery) is skipped when it answers 404; empty states (docs, blog,
  changelog without content) are captured and noted on the page.
- **flows** (`steps/flows.mjs`, test site only): the store's
  `e2e-personal-claim.cjs` and `e2e-buyer-journey.cjs` journeys with fresh
  `+test` accounts (BuildBase test mode: code 424242, no mail) and Stripe's
  test card, recorded as walkthroughs (a) and (b); then the signed-in pages
  (order page, dashboard, licences, ...) at every width and theme with that
  session.
- **videos** (`steps/videos.mjs`): (c) `/agents`, choosing Claude Code and
  copying its snippet (the clipboard is checked); (d) docs and gallery
  browsing, recorded only when they have content (otherwise skipped and noted);
  (e) the replay of a recorded agent session
  (`fixtures/agent-session-multi-engine.json`, built from a real Claude Code
  stream-json transcript by `fixture-from-transcript.mjs`), typed out as a
  terminal page with each tool call and result, then the reel it rendered,
  in 16:9 and 9:16. Recordings are transcoded to H.264 MP4 and VP9 WebM,
  1280x720 (720x1280), at most about 4 MB each, with JPEG and WebP posters;
  raw recordings are deleted.
- **studio** (`steps/studio.mjs`): starts the studio from this checkout
  (licence mode off, a throwaway data directory), runs `pnpm reelforge keys
  create`, `pnpm start`, `claude mcp add` and `claude mcp list` (in a
  throwaway `HOME`), `curl /readyz` and `/metrics`, and a REST render of
  `fixtures/contact-sheet-reel.json` (one scene per built-in template) with
  its progress; renders each session as a terminal page and makes a contact
  sheet per template from the render's clips. `docker compose up` is
  captured when a studio image is present (`REELFORGE_IMAGE`, default
  `reelforge-studio:latest`); otherwise it is skipped and noted.
- **console** (`steps/console.mjs`): merges the blueprint exports with
  read-only org API reads (sign-in methods and clients, hosted page, selling
  settings and go-live list, item type, own-store items, email, docs, blog,
  collections), redacts every secret and renders the console setup page. The
  redacted snapshot stays in `out/`.

## Masking

Before any still or video frame is kept, an init script in every page and
frame (`maskingInitScript` in `lib.mjs`) hides email and password inputs
(`-webkit-text-security`) and rewrites licence keys (`XXXXX-XXXXX-…`),
emails (except allowed public ones) and tokens (`rf_…`, `sk_…`, `whsec_…`,
bearer tokens, `sig=` of signed links) as they appear. Then `assertMasked`
reads the text of every frame and input: if anything is left, the capture
fails and a recording in progress is deleted. Terminal views and the agent
fixture go through `maskText` too; commands show `$REELFORGE_KEY`, never a
key.

## Where the files go

- **Screenshots: BuildBase Assets** in the development environment. Each
  image is uploaded as `rf-capture--<key>--<hash8>.webp`, public. The
  manifest `scripts/capture/assets.json` maps each key to its content hash,
  asset id, URL and docs page. A re-run skips unchanged images, finds an
  existing asset by hash when the manifest was lost, uploads changed ones and
  deletes the asset they replace, so assets never pile up. Budgets: fold crops
  (the grid thumbnails) at most 150 KB, full pages (opened on click) at most
  400 KB at 1x CSS width; the encoder lowers quality, then size, to fit.
- **Videos: the store**, `public/walkthroughs/<slug>.<hash8>.{mp4,webm,jpg}`
  (immutable cache, like `public/reels/`), linked from the walkthroughs page as
  https://reelforge.buildbase.app/walkthroughs/…. BuildBase Assets take images
  only, and R2 is not enabled yet; **once R2 is on (#89) the videos move there**
  and `VIDEO_BASE` in `scripts/capture/docs.mjs` changes. Posters are
  BuildBase assets like the screenshots.

## Tests

`pnpm test:capture` (part of `pnpm test`): unit tests of argument parsing,
names, masking, budgets, the upload plan against a fake asset API
(first run, re-run with no writes, changed image replaced, lost manifest,
duplicates), redaction and the generated pages; and an end-to-end test that
captures two pages from a local static server (skipped without a browser or
ffmpeg unless `REELFORGE_REQUIRE_BROWSER=1`).

## Re-capture later

| When | Run |
| --- | --- |
| The Workers get the content-reader key (#93): docs, blog and changelog show content | `pnpm capture --only pages --upload` then `pnpm capture --only videos --upload --reel …` (records docs navigation) |
| The gallery is deployed | the same two commands (gallery page and gallery walkthrough) |
| R2 is enabled (#89) | move `public/walkthroughs/` to R2 and change `VIDEO_BASE` |
| A page, flow or template changes | the step that shows it, with `--upload`, then `pnpm docs:sync` |

## Known limits

- The captures of 2026-11-22 ran behind an egress proxy that refused
  `www.buildbase.app`, so the store footer's "Built with BuildBase" badge shows
  as its alt text in those images. It loads normally for visitors; a capture
  from an unrestricted network shows it.
- Stills of a page whose data loads slowly can show it before the last request
  finished: the capture waits for network idle (at most 15 s) and, on order and
  licence pages, for the masked key.
- The BuildBase console itself is not captured (no agent signs in as the
  founder): see the console setup page and CONSOLE_SCREENSHOTS.md.
