# Showcase gallery

119 short vertical reels made with ReelForge Studio, the pipeline that renders
them, and how they reach the store's `/gallery` pages. Issue #43; plan in
`docs/research/SITE_PLAN.md` §B.7.

```
scripts/gallery/src/catalog/   reel specs + scene designs (TypeScript)  ──pnpm gallery build──▶  examples/gallery/<slug>.json
examples/gallery/<slug>.json   { gallery: {...}, manifest: <v0.2 manifest> }
pnpm gallery render            studio over MCP  ──▶  <out>/<slug>/final.mp4, render-manifest.json, meta.json
pnpm gallery check             ffprobe + black/freeze/silence + contact sheet  ──▶  <out>/quality.json, <out>/<slug>/contact.png
pnpm gallery transcode         720p H.264 + VP9 + AVIF/JPEG posters, hashed names  ──▶  <out>/web/
pnpm gallery upload            R2 bucket reelforge-media, immutable cache headers  ──▶  <out>/web/urls.json
pnpm gallery publish           BuildBase Collection "gallery" (Records API)  ──▶  store /gallery
```

`<out>` is `$REELFORGE_GALLERY_OUT` (or `--out`), default `./gallery-out`
(git-ignored). Renders never go into git; they go to R2.

## Reproduce every reel

```bash
pnpm i
export REELFORGE_CHROMIUM_PATH=/path/to/chrome-headless-shell
export REELFORGE_CHROMIUM_NO_SANDBOX=1        # only in a container without user namespaces
export REELFORGE_GALLERY_OUT=/tmp/gallery
pnpm gallery render                            # all 119; or: pnpm gallery render <slug> <slug>
pnpm gallery check && pnpm gallery transcode
```

`render` starts a local studio for the job (`apps/server/src/main.ts`, its own
data directory under `<out>/.studio`, `REELFORGE_LICENCE_MODE=off` for this
local job only, a key with `read,write,render` made by the CLI) and talks to it
over **MCP**, the way an agent does. To use a studio that is already running,
pass `--server http://host:4321 --key-file key.txt`.

Per reel the "agent" calls: `create_project` (with an idempotency key from the
slug and manifest hash; an older version of the project is replaced with
`delete_project`), `upload_asset` + `set_audio` when the reel has music,
`validate_project`, `render_project` (idempotency key), `get_job` with
`waitSeconds: 45` until it finishes, `get_render_output`, then the MP4 and the
render manifest are downloaded and the project is deleted to free the studio's
disk. The tools a reel used are recorded in its `meta.json` and shown on its
page.

It is resumable: a reel whose `meta.json` carries the same manifest hash is
skipped. Two renders run at a time (`--concurrency`). A render that fails (for
example a browser killed by the out-of-memory killer on a busy machine) is
retried once, one at a time, at the end.

Fonts: the scenes use `"Inter Display", Inter, "Noto Sans", "DejaVu Sans"` and
`"JetBrains Mono", "DejaVu Sans Mono"`. The published renders were made on a
host with Inter and JetBrains Mono installed; the release image ships Noto and
DejaVu, so a render there uses those. No font is downloaded.

### meta.json

`slug, title, description, category, tags, engines, theme, palette, featured,
music, durationSeconds, frames, fps, width, height, renderSeconds` (the studio's
wall clock from `render-manifest.json` `wallClockMillis`), `jobSeconds` (as the
client saw it, with queueing), `hardware` (CPU model, cores, RAM, OS),
`studioVersion, engineVersions, ffmpeg, renderedAt, manifestHash` (sha256 of
the manifest JSON), `prompt` (what the agent was asked), `toolsCalled`,
`mcpCalls, bytes, checks`.

## Add a reel

1. Add a spec to one of `scripts/gallery/src/catalog/reels-*.ts`:
   ```ts
   {
     slug: 'my-reel', title: 'My reel', category: 'Product launch', tags: ['launch'],
     palette: 'ember', music: 'drive',
     prompt: 'The natural-language request an agent would have been given.',
     scenes: [
       R(2.5, 'Remotion kinetic title', 'subline'),           // Remotion template
       X('stat', 4, { value: 72, suffix: 'h', label: '…' }),  // agent-written HTML scene
       CV('globe', 4, { lines: ['HyperFrames canvas'] }),    // generative HyperFrames scene
       MC(4, 'Motion Canvas list', ['one', 'two']),          // Motion Canvas template
     ],
   }
   ```
   `X` renders a design with the html engine, `XF` the same design as a
   HyperFrames composition, `CV` a generative canvas design (HyperFrames
   only), `R`/`MC` the Remotion and Motion Canvas templates, `HT`/`HFT` a title
   card (hero design), `HTT`/`HFTT` the built-in `html-title` /
   `hyperframes-title` templates.
2. `pnpm gallery build` writes and validates `examples/gallery/my-reel.json`
   (manifest schema, 8–25 s, a prompt).
3. `pnpm gallery sketch my-reel` shows the agent-written scenes in a PNG
   without a render; then `pnpm gallery render my-reel && pnpm gallery check my-reel`.
4. Look at `<out>/my-reel/contact.png` against the design rules below before
   it ships. `pnpm --filter @renderweld/gallery test` checks the rules that can
   be checked mechanically.

### Scene designs

`scripts/gallery/src/catalog/designs.ts` (html or HyperFrames): hero, stat,
bars, line, donut, checklist, quote, phone, browser, code, countdown, versus,
beforeAfter, recipe, route, listing, ticket, role, lyric, podcast, timer,
scoreboard, changelog, outro, notifications, featureGrid, manifesto, timeline,
pricing, tip, step, product. `canvas.ts` (HyperFrames, inline script seeked by
the runtime through its `__hfAnime` adapter): flow (silk lines), globe,
equalizer, burst, orbit, liveChart. Counters in html scenes are CSS (a
registered `@property` integer drives a CSS counter, seeked like any
animation); HyperFrames does not seek those, so its scenes update the numbers
from the same seek script.

Scenes are cut back to back (manifest v0.2 has only `cut`), so a transition is
drawn as two halves: the end of one scene and the start of the next draw the
same thing (a surface panel wipe, a push, a zoom, an iris), and the cut lands
where they meet. Next to a Remotion or Motion Canvas template the halves fade
through the background, which is how those templates exit.

Every visual is procedural: CSS, SVG and canvas. No image, video, font or
audio file is downloaded or bundled; brands, people, places and numbers are
fictional or labelled as sample data. Music beds come from
`scripts/gallery/src/music.ts`, a small deterministic synthesiser (no samples),
uploaded with licence `CC0-1.0`.

### Design rules

The reels follow "Design and UI/UX rules" in AGENTS.md, built on the unslop
skill by Damir Sokolovsky ([@heydamir](https://x.com/heydamir), CC BY 4.0):
one idea per scene and one bright element (the number, the chart line, the
product, the ticket); palettes are a neutral ramp tinted toward the brand's
world with one accent (`palettes.ts`); headings at 600, sentence case, no
uppercase tracked labels; one ease-out curve, no overshoot, no looping pulses;
no gradient text, glows, blurred blobs, glass or conic gradients; key content
between y = 240 and y = 1520, clear of the platform UI. The catalog test fails
on the mechanical signs (gradient text, `filter: blur`, `backdrop-filter`,
glows, uppercase, 800/900 weights, overshoot easing, emoji).

The four built-in templates got the same pass while the gallery was made:
Remotion `kinetic-title` and Motion Canvas `animated-explainer` lost their
background glow and circles and their overshoot, `html-title` its blurred
blobs, `hyperframes-title` its spinning ring. Their layout, timing and props
are unchanged.

## Quality gate

`pnpm gallery check` per reel: ffprobe (exactly 1080×1920, 30 fps, frame count
and duration from the manifest, H.264), one decode pass with `blackdetect`
(0.5 s where 98% of pixels are under 4% luminance: a dark theme is not black)
and `freezedetect` (2.5 s without change), `volumedetect` (a reel with music
must not be silent), a 6×2 contact sheet (`contact.png`) and a poster frame
from the end of the first scene (everything revealed). Results:
`<out>/quality.json`. Then a person or the agent looks at every contact sheet
and moves reels that fail the review into `<out>/rejected.json`
(`{ "slug": "why" }`); `transcode` skips them. `examples/gallery/QUALITY.md`
records the last run.

## Transcode

720×1280, no audio: H.264 High (`-preset slow`, CRF from 20 up in steps of 2
until it fits), `+faststart`, keyframe every 2 s; VP9 WebM (CRF from 31); AVIF
and JPEG posters at 720×1280 and 360×640. Budgets (§B.6): 800 KB for a reel up
to 15 s, scaled with length above that (at most 1.2 MB), 1.5 MB for featured
reels. Each name carries the first 12 hex digits of its sha256:
`gallery/<slug>/<slug>.<hash>.mp4`. `<out>/web/media.json` lists every file.

## Upload (R2)

```bash
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm gallery upload [--dry-run]
```

Creates the bucket `reelforge-media` when it does not exist, then PUTs each
file through the Cloudflare REST API with `Cache-Control: public,
max-age=31536000, immutable` and its content type, plus each reel's manifest
as `gallery/<slug>/manifest.<hash>.json`. Hashed keys never change, so the
step skips what its ledger (`<out>/web/r2-uploaded.json`) says is uploaded and
can be re-run. `<out>/web/urls.json` has every public URL under
`REELFORGE_GALLERY_MEDIA_URL` (default `https://media.reelforge.buildbase.app`,
the planned custom domain on the bucket).

Behind an HTTPS proxy, run Node with `NODE_USE_ENV_PROXY=1` so `fetch` uses
it. Status 2026-11-21: R2 is not enabled on the Cloudflare account yet (API error
10042, "enable R2 through the Cloudflare Dashboard"). The upload waits on that
founder action, then the custom domain `media.reelforge.buildbase.app` on the
bucket.

## Publish (BuildBase Collection)

```bash
BUILDBASE_API_TOKEN_FILE=dev-env.key pnpm gallery publish [--dry-run] [--base-url https://media.reelforge.buildbase.app]
```

Creates the Collection `gallery` (live version v1 with the fields below) when
it is missing, then upserts one record per transcoded reel, matched by `slug`;
only changed fields are sent, so a second run changes nothing. A record is
`published` when its MP4 and poster answer at the media base URL (HEAD),
otherwise `hidden`, so nothing broken shows while R2 is not live.

Fields: `title, slug, description, category, tags, engines` (multi-select),
`theme, durationSeconds, frames, fps, renderSeconds, hardware, studioVersion,
engineVersions, renderedAt, prompt, tools, mcpCalls, manifestHash,
manifestPath, posterPath, posterAvifPath, posterSmallPath,
posterSmallAvifPath, mp4Path, webmPath, mp4Bytes, status` (published/hidden),
`featured, order`.

Records hold media **paths**, not URLs: the store joins them with its
`GALLERY_MEDIA_URL`, so moving the media (custom domain, Worker route, a local
server for a preview) never means rewriting records. Posters stay on R2 next
to the videos rather than in BuildBase assets: assets take images only, not
video, and not AVIF, and one hashed, immutable media origin keeps the store's
CSP to one extra host.

The store reads the collection with `content.collections.data('gallery')`
(cached); the content webhook (`/api/webhooks/content`, subscribed to
`collection.record_*` and `collection.version_published`) revalidates it, so an
edit in the console (hide a reel, change its order) shows on the next request.

## Tests

`pnpm --filter @renderweld/gallery test`: the catalog (100+ valid manifests,
four engines, both themes, no network in scenes, the design rules,
determinism, the committed files match the catalog), the quality-gate parsers,
budgets, the music synthesiser, rendering over a fake MCP studio (idempotency
keys, replace, resume, retry), publishing to a fake Records API (create,
idempotent upsert, hidden → published) and the R2 upload against a fake
Cloudflare API. `test/e2e.test.ts` renders two short reels end to end against
a real studio process (skips without `REELFORGE_CHROMIUM_PATH` unless
`REELFORGE_REQUIRE_BROWSER=1`).
