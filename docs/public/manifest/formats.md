---
title: "Formats and layouts"
description: "Any output size, aspect ratio and frame rate in ReelForge Studio: exact NTSC rates, the sizes each engine renders, the layout unit, safe areas with their sources, fit-to-box text, how built-in templates reflow, and the contact sheets that prove it."
folder: "manifest"
slug: "formats"
order: 3
tags: [manifest, reference, formats]
---

# Formats and layouts

A project renders at the size in its `output`: any even width and height from
16 to 4096 pixels. Vertical 1080x1920 is the default in the examples, not a
limit. Every built-in template lays itself out for the frame it is given, so
the same scenes work at 16:9, 1:1, 4:5, 9:16, 21:9 and 4K.

| Where the video goes | `output` |
| --- | --- |
| Instagram Reels, TikTok, YouTube Shorts | 1080x1920 (9:16) |
| YouTube, websites, presentations | 1920x1080 (16:9) or 3840x2160 (4K) |
| Square feed posts | 1080x1080 (1:1) |
| Portrait feed posts | 1080x1350 (4:5) |
| Cinema-style banners | 2560x1080 (21:9) |

Width and height must be even (H.264 with yuv420p needs it), and a server can
set lower limits (`limits.maxRenderDimension`, see `get_capabilities`). The
frame rate is any of 23.976, 24, 25, 29.97, 30, 48, 50, 59.94 and 60
([Frame rates](#frame-rates)).

To render several of these sizes from one project in one call, list them as
`variants` in the manifest: `render_project` then starts one render per
variant, laid out again for each size ([Output variants](/docs/manifest/v0-2#output-variants)).

## Frame rates

`output.fps` takes these rates. Every engine renders each of them, and the
final MP4 has exactly that rate: ffprobe reports `r_frame_rate` as
`30000/1001`, not a rounded `2997/100`.

| Rate | Give it as | Stored as | Typical use |
| --- | --- | --- | --- |
| 23.976 | `"24000/1001"`, `{ "num": 24000, "den": 1001 }` or `23.976` | `"24000/1001"` | Film transferred to NTSC video |
| 24 | `24` | `24` | Film, cinematic web video |
| 25 | `25` | `25` | PAL broadcast (Europe, much of Asia and Africa) |
| 29.97 | `"30000/1001"`, `{ "num": 30000, "den": 1001 }` or `29.97` | `"30000/1001"` | NTSC broadcast (Americas, Japan) |
| 30 | `30` | `30` | Social and web video (the default) |
| 48 | `48` | `48` | High-frame-rate film |
| 50 | `50` | `50` | PAL broadcast at full motion, sport |
| 59.94 | `"60000/1001"`, `{ "num": 60000, "den": 1001 }` or `59.94` | `"60000/1001"` | NTSC broadcast at full motion |
| 60 | `60` | `60` | Screen recordings, gaming, smooth motion |

The decimals `23.976` (or `23.98`), `29.97` and `59.94` are read as the NTSC
fractions; a fraction you write out is never rounded (`"2997/100"` is
refused). Integer rates stay plain numbers, so manifests that say `"fps": 30`
are unchanged. Any other rate is refused with the list above.

At NTSC rates a second is not a whole number of frames, so durations are
counted in frames: `durationSeconds: 10` at 29.97 is 299.7 frames, rounded to
300, which last 10.01 s. Scene starts, captions, voice and sound effects use
the same exact timeline (frame `n` starts at `n x 1001 / 30000` s).
`validate_project` warns when `durationSeconds` does not land on a frame.

`get_capabilities` lists the rates under `limits.supportedFps` and, per
engine, `frameRates`; `limits.maxRenderFps` (default 60) can lower the highest
rate a server renders.

## Sizes and rates each engine renders

Before a render or preview is queued, its size and frame rate are checked
against every engine the project uses, for `output` and for each variant:

- **Every engine** writes H.264 with 4:2:0 chroma (yuv420p): width and height
  must be even, a frame may have at most 139,264 macroblocks (about 35.6
  megapixels, H.264 level 6.2) and a side at most 16,880 pixels;
- **an engine plugin** can declare its own frame rates and largest size
  (`EngineCapabilities.output`). The four built-in engines render every rate
  above at every size the manifest allows (up to 4096 pixels on a side).

A render outside them is refused with `422 unsupported_output`, naming the
engine, the variant and the reason, and nothing is queued;
`validate_project` reports the same problems as errors. The manifest itself
already requires even sizes from 16 to 4096 pixels, and a server can set lower
limits (`limits.maxRenderDimension`).

## The layout unit

Templates size everything in **units of 1 % of the shorter side**
(`min(width, height) / 100`). A headline is therefore the same number of pixels
tall at 1080x1920, 1080x1080 and 1920x1080, and it does not grow with the long
side of a wide frame. At 4K every size doubles with the frame.

| Token | Size |
| --- | --- |
| Display (largest headline) | 10.5 units |
| Smallest headline after fitting | 4.5 units |
| Title | 9.5 units |
| Body | 5.6 units |
| Caption (sublines) | 4.8 units |
| Label (kickers) | 4 units |

## Safe areas

Built-in templates keep all text inside the **content safe area**. It is, per
side, the larger of the title-safe margin and, on tall frames, the app-overlay
zone.

| Area | Inset per side | Source |
| --- | --- | --- |
| Action safe | 3.5 % of width (left, right) and height (top, bottom): 93 % of the frame | EBU R 95 v1.1 (June 2017), ITU-R BT.1848-1 (2015) |
| Title (graphics) safe | 5 %: 90 % of the frame | EBU R 95 v1.1, ITU-R BT.1848-1 |
| App overlay zone, tall frames only (height / width of 1.6 or more, such as 9:16) | 14 % top, 35 % bottom, 6 % left and right | Conservative values that clear the buttons, captions and progress bars of the common social apps. **Platforms differ and change their UI;** these are not any platform's published numbers |

At 1080x1920 the content box is 950x979 pixels starting at (65, 269). At
1920x1080 it is 1728x972 starting at (96, 54).

`brief.platform` in the manifest decides the app overlay zone: tall frames get
it unless the platform is `none`, `broadcast`, `web` or `presentation`.

Code that runs outside a template can read the same numbers from
`@reelforge/project-schema`:

```ts
import { safeAreaInsets, frameLayout } from '@reelforge/project-schema';

safeAreaInsets(1080, 1920, 'tiktok');
// { action: {...}, title: {...}, ui: { top: 269, right: 65, bottom: 672, left: 65 }, content: {...} }
frameLayout(1920, 1080).box; // { x: 96, y: 54, width: 1728, height: 972 }
```

## How the built-in templates reflow

- **Wide frames** (4:3 and wider) lay out side by side where a scene has two
  groups: `animated-explainer` puts its title in a left column and the points
  in a right one. Title cards cap their line length at 150 units, so a headline
  does not run across the whole width.
- **Square, portrait and tall frames** stack: title above points, headline
  above subline.
- **Headlines fit their box.** The largest size from 10.5 down to 4.5 units at
  which the headline fits its box is used, so long headlines and long words
  shrink instead of running off the frame. `kinetic-title` (Remotion) measures
  the text with the browser's text metrics; `html-title` and
  `hyperframes-title` shrink the element in the page; `animated-explainer`
  (Motion Canvas) scales its laid-out block down when it is larger than the
  safe area.

## In your own HTML scenes

`html` and `hyperframes` scenes get the layout as CSS variables:

| Variable | Meaning |
| --- | --- |
| `--rf-unit` | 1 % of the shorter side |
| `--rf-unit-w`, `--rf-unit-h` | 1 % of the width, of the height |
| `--rf-safe-top`, `--rf-safe-right`, `--rf-safe-bottom`, `--rf-safe-left` | The content safe area insets |
| `--rf-title-safe-*`, `--rf-action-safe-*` | The broadcast safe areas |
| `--rf-content-w`, `--rf-content-h` | Size of the content box |

In `html` scenes the root element also carries
`data-rf-orientation="portrait|square|landscape"` and
`data-rf-direction="row|column"`, so CSS can switch layouts with
`[data-rf-direction=row] .my-card { ... }`. Media queries such as
`@media (min-aspect-ratio: 4/3)` work too, because the page is exactly the
size of the frame.

Add `data-rf-fit` to a headline (with a `max-height`, or as a shrinking flex
item) and the html engine lowers its font size until it fits. It never goes
below `data-rf-fit-min` pixels (default: 40 % of its CSS size).

```html
<div class="card">
  <h1 data-rf-fit>Your headline</h1>
</div>
```

```css
.card { position: absolute; inset: var(--rf-safe-top) var(--rf-safe-right) var(--rf-safe-bottom) var(--rf-safe-left); }
.card h1 { font-size: calc(var(--rf-unit) * 10.5); max-height: 60%; }
```

## Proof: contact sheets

Every built-in template is rendered on its engine at 16:9, 1:1, 4:5, 9:16 and
4K, and each clip is checked for overflow. The contact sheets show four frames
per template: entry, middle, settled and exit. Rows from top to bottom:
`kinetic-title` (Remotion), `animated-explainer` (Motion Canvas), `html-title`
(HTML) and `hyperframes-title` (HyperFrames). The thin grey outline is the
content safe area.

| 16:9 (1920x1080) | 1:1 (1080x1080) |
| --- | --- |
| ![16:9 contact sheet](../../proofs/formats/16x9.png) | ![1:1 contact sheet](../../proofs/formats/1x1.png) |

| 4:5 (1080x1350) | 9:16 (1080x1920) |
| --- | --- |
| ![4:5 contact sheet](../../proofs/formats/4x5.png) | ![9:16 contact sheet](../../proofs/formats/9x16.png) |

4K (3840x2160), a shorter smoke render:

![4K contact sheet](../../proofs/formats/4k.png)

The measurements behind them, including render times on the machine that made
them, are in `docs/proofs/formats/report.json`. To make them again:

```bash
export REELFORGE_CHROMIUM_PATH=/path/to/chrome-headless-shell
pnpm formats:prove
```

## Tests

`apps/server/test/formats.test.ts` runs with the server tests:

- every built-in template renders at 16:9, 1:1, 4:5 and 9:16 (at a fifth of
  the real size, proportional) and passes the **overflow check**: at the
  settled frame, every pixel that is not background lies inside the content
  safe area (with a tolerance of 1.5 units), nothing touches the frame edge,
  and the text block is not shrunk to nothing. The check fails on the layout
  before this change (10 of 17 renders), and a test makes sure it fails on a
  scene whose text runs off the frame;
- `html-title` and `hyperframes-title` are measured in the browser at the real
  sizes (and 21:9 and 4K), with the longest props the schema allows and with a
  single long word: every text box is inside the safe area and none overflows;
- one 3840x2160 smoke render.

`apps/server/test/fps.test.ts` renders each engine at 23.976, 29.97, 48, 50
and 59.94 fps (exact frame counts, and the exact rate and one-frame timestamp
steps after normalisation) and a four-engine project at 29.97 end to end
(`r_frame_rate` 30000/1001, frames and duration). The fan-out test renders a
29.97 project on three workers and on one: the stream-copy join and the
single render have the same exact rate, frames, timestamps and caption times.

`pnpm formats:prove` renders the same matrix at the real sizes.
