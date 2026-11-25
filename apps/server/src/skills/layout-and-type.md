---
name: layout-and-type
title: Layout and type
description: Safe areas for every aspect ratio, type sizes relative to the frame, contrast, line length and lower thirds. Use whenever you place text, a logo or interface elements.
---
# Layout and type

**Use when:** placing any text, logo or UI, at any size or aspect ratio.

## Rules
1. Keep text inside the title-safe area and important action inside
   action-safe. On 16:9, graphics-safe is 5 % from each edge and action-safe
   3.5 % (EBU R 95). Square and 4:5: keep text inside the central 90 % × 90 %.
2. Tall frames (9:16) on social platforms are covered by the app's own
   buttons, captions and account name. Use the platform's published overlay
   for the exact zones; when one video goes to several platforms, stay inside
   all of them. A conservative fallback for 1080×1920: about 14 % clear at
   the top, 35 % at the bottom and 6 % at each side.
3. Size type from the frame's height, not in fixed pixels: titles about
   4-9 % of the frame height, secondary text 3-4 %, and nothing smaller than
   2.6 % of the shorter side (which decides on landscape frames). Check a copy scaled to 360 px wide: if you
   cannot read it there, it is too small for a phone.
4. Titles: at most two lines and about 37 characters a line. Avoid
   paragraphs on screen.
5. Contrast: at least 4.5:1 for text and 3:1 for large text (WCAG 2.2,
   1.4.3), measured against the busiest frame behind it. Over video or
   photos, put the text on a solid box or a dark scrim.
6. One focal point per frame; at most two type families and three sizes per
   scene; no uppercase text with wide letter-spacing as decoration.
7. Use a grid: margins equal to the safe area, and recurring elements
   (lower thirds, captions, logo) in the same place in every scene.
8. A lower third sits inside the safe area and stays for its reading time
   (`script-timing` rule 3) plus about 0.5 s. Captions move up while a lower third is on screen.
9. Wider than 16:9 (21:9): compose so the important part also works in a
   16:9 crop.
10. Re-lay out each size; never centre-crop one size into another.

## In RenderWeld
- `--rf-unit` is 1 % of the shorter side; size and space everything in it so
  scenes reflow for every output and variant.
- `--rf-safe-top/right/bottom/left` are the safe insets for this output and
  platform (`--rf-title-safe-*`, `--rf-action-safe-*` too); keep text inside
  them. `brief.platform` (or a variant's `platform`) is free text: `none`,
  `broadcast`, `web` or `presentation` turn the app-interface zone of tall
  frames off; any other value (`tiktok`, `reels`) keeps it on.
- Layout templates (`html-layout` and its twins on the other engines) give
  split screen, picture-in-picture, grids and a lower third that reflow for
  every size.
- Built-in templates fit text to their boxes; long text gets smaller, so
  keep it short instead of relying on the fit.

## Signs of a generic, machine-made video
- Text under the app's buttons or touching the frame edge.
- Gradient text, glows, stacked drop shadows, emoji used as icons.
- Five fonts; everything centred with no grid.

## Before you render
- [ ] Every size checked on a frame with the platform overlay in mind.
- [ ] Contrast measured on the worst frame; text readable at 360 px wide.
- [ ] Reading times met (see `script-timing`).

## Sources
- EBU R 95, safe areas for 16:9 production (tech.ebu.ch/docs/r/r095.pdf); ITU-R BT.1848.
- W3C WCAG 2.2, success criterion 1.4.3 (w3.org/TR/WCAG22).
- BBC Subtitle Guidelines (line lengths and regions).
- TikTok, YouTube and Meta safe-zone overlays (ads.tiktok.com; services.google.com/fh/files/misc/universalsafezones-youtube.pdf).
