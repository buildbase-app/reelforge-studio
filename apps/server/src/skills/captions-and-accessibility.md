---
name: captions-and-accessibility
title: Captions and accessibility
description: Caption length, reading speed, timing, placement, line breaks, sound descriptions, audio description and flashing limits. Use for any video with speech, and any video with flashing or high-contrast patterns.
---
# Captions and accessibility

**Use when:** a video has speech, or contains flashes, strobes or striped
patterns.

## Rules
1. Every video with speech has captions (WCAG 2.2, 1.2.2). Give a sidecar
   file (WebVTT or SRT) where the platform takes one; burn them in as well for
   social video that autoplays without sound. Long-form video is never
   burned-in only.
2. Line length at most 42 characters, 32 on tall (portrait) frames; at most
   two lines.
3. Reading speed at most 20 characters a second for adults, 17 for children.
4. Each caption stays at least 5/6 s (0.83 s: 25 frames at 30 fps) and at
   most 7 s, longer than 5/6 s when rule 3 needs it, with a gap of at least
   two frames between captions; snap starts and ends to nearby cuts.
5. Sync: a caption appears with its speech, not before it by more than a
   moment, and never trails it by more than about 1.5 s.
6. Break lines at natural points: after punctuation, before conjunctions and
   prepositions; never split an article from its noun or a first name from a
   last name; the lower line may be longer.
7. Placement: bottom centre by default; move up for on-screen text, lower
   thirds and faces; on tall frames keep clear of the app's interface.
8. Style: a box or a strong outline behind the text, at least 4.5:1
   contrast. Identify speakers with labels or consistent colours.
9. Hard-of-hearing captions (SDH): speaker names and sounds in lowercase
   brackets ("[door slams]"), music described by mood; describe what is
   heard, not what is seen.
10. When the picture carries information that the audio does not, give an
    audio description (WCAG 1.2.5), or write the narration so it describes
    what matters.
11. Flashing: no more than three flashes in any one second, unless the
    flashing area is small (under about 25 % of a 10° field of view). Red
    flashes count separately and are worse. Avoid high-contrast stripes over
    large areas and long flashing sequences altogether (WCAG 2.2, 2.3.1).
12. Test anything that flashes with a photosensitivity analyser before
    publishing.

## In RenderWeld
- `captions.mode`: `off`, `burned`, `sidecar` or `both`; override for one
  render with `render_project { captions }`. Sidecars are SRT, WebVTT and ASS.
- Cues come from voice word timings (`generate_voice`), local speech-to-text
  (`transcribe_captions`), `import_captions` (SRT or WebVTT) or your own text.
- Caption QA follows the rules above (42 characters, 32 on portrait, two
  lines, 20 characters a second, 5/6 s to 7 s, two-frame gaps) and is
  reported by `get_captions` and in the render; fix every issue.
- Show the user the cue texts and times, ask for approval, then
  `update_captions { approve: true }`; never assume approval.
- Several languages: `update_captions { language, cues }`; `burnLanguage`
  picks the one burned in. Audio description: cues with `kind: "description"`
  (a WebVTT sidecar, never burned).
- Caption style (font, size, colours, box, outline) comes from the theme.

## Signs of a generic, machine-made video
- Bouncing word-by-word captions with emoji; captions over faces or the product.
- Blocks of uppercase text; no sound labels.
- Strobing "energy" transitions.

## Before you render
- [ ] Caption QA clean; names spelled correctly; the user approved the cues.
- [ ] Placement checked on every size; nothing under the platform interface.
- [ ] Audio description decided; no flashing over the limits.

## Sources
- Netflix Timed Text Style Guide and timing guidelines (partnerhelp.netflixstudios.com; backlothelp.netflix.com).
- BBC Subtitle Guidelines (bbc.co.uk/accessibility/forproducts/guides/subtitles).
- DCMP Captioning Key (dcmp.org/learn/captioningkey).
- US FCC caption quality standards, 47 CFR 79.1.
- W3C WCAG 2.2: 1.2.2, 1.2.5, 1.4.3, 2.3.1 (w3.org/TR/WCAG22).
- ITU-R BT.1702 (photosensitive epilepsy).
