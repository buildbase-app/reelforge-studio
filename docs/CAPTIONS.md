# Captions

ReelForge burns captions into the video, writes them as sidecar files, or both
(issue #300, decision D-107). Captions are **off by default**: a project renders
exactly as before until you set `captions.mode` or pass `captions` to
`render_project`.

## Quick start

```jsonc
// in the manifest (update_project), or import_captions with an SRT/VTT file
"captions": {
  "mode": "both",            // off | burned | sidecar | both
  "language": "en",
  "cues": [
    { "start": 0.5, "end": 2.5, "text": "Made on your own machine." },
    { "start": 3.0, "end": 5.0, "text": "Two engines, one timeline." }
  ]
}
```

Then `render_project` (optionally `captions: "burned"` to override the mode for
one render) and `get_render_output`: `captions.burned`, `captions.files` (SRT,
WebVTT, ASS with signed download links) and `captions.qa`.

## Where cues come from

In this order; the first that has any wins:

1. **`captions.cues`**: written by hand, by an agent, or imported with
   `import_captions` (REST `POST /v1/projects/:id/captions/import`, body
   `{ content, format?, mode?, language? }`). SRT and WebVTT are parsed; tags,
   cue settings, `NOTE`/`STYLE`/`REGION` blocks are dropped, author line breaks
   are kept. A parse error is `422 invalid_captions` with the line number.
2. **The voice's word timestamps** (`audio.voice.words`). `generate_voice` with
   ElevenLabs stores them on the voice track (times relative to the voice start).
   Cues are built from them at validation and render time, so moving the voice
   (`startFrame`) keeps captions in sync. Setting another voice asset drops the
   old words. Cues built this way keep their words, which enables the word
   highlight.
3. **Scene `captions.text`** (`source: "text"`): spread over the scene's time in
   cues of at most `maxCharsPerCue` characters (no word highlight).

`validate_project` warns when cues exist but `mode` is `off`, and when a mode is
on but there are no cues. The old `captions.enabled` flag does nothing (warning).

### Building cues from words

A cue ends at a sentence end, at a pause of 0.7 s or more, at `maxCharsPerCue`
(default: two lines, `2 × maxLineChars`) or at 7 s, and at a clause break
(`,` `;` `:` dash) once it is half full. When a cue is full it ends at its last
clause break if that leaves at least a third of it, and never on an article. A
cue too short to read that runs straight into the next one is joined with it
when both fit. Timing: at least 0.833 s on screen (extended into the silence
after it), at most 7 s, at least two frames before the next cue, and gaps under
half a second closed to two frames.

## Model

| Field | Meaning |
| --- | --- |
| `captions.mode` | `off` (default), `burned`, `sidecar`, `both`. `render_project`'s `captions` overrides it per render. |
| `captions.cues[]` | `{ start, end, text, words? }`, seconds of video time, in time order, `end > start`. `text` may contain `\n` to force a line break. `words[]` = `{ text, start, end }`. |
| `captions.language` | BCP 47; written into the WebVTT header and the render manifest. Default: `brief.language`. |
| `captions.highlight` | `word` (default; used when a cue has words that match its text) or `none`. |
| `captions.maxLineChars` | Line length for the line breaker, 16-42. Default 42, or 32 for portrait output. |
| `captions.maxCharsPerCue` | For cues built from words or scene text, 16-84. Default `2 × maxLineChars`. |
| `captions.style` | Partial caption style on top of the theme's `captionStyle` tokens (below). |
| `audio.voice.words[]` | Word timestamps relative to the voice start (stored by `generate_voice`). |

## Style

From the theme's `captionStyle` tokens, then `captions.style`:

| Token | Default | |
| --- | --- | --- |
| `position` | `bottom` | `bottom`, `top` or `center`, inside the safe area |
| `fontScale` | `0.05` | font size as a fraction of `min(width, height)` |
| `fontFamily` | theme `fontFamily` | the first installed family of the list is used (`fc-match`) |
| `weight` | `700` | 600 and above draw bold |
| `color` | `#ffffff` | text |
| `background` | `#000000` | box behind each line; `null` = no box, outlined text |
| `backgroundOpacity` | `0.8` | |
| `outline` | `#000000` | outline colour when there is no box; `null` = none |
| `highlightColor` | theme `accent` | the word being spoken |

**Safe area** (a local helper until the shared one of #287 lands): portrait
12 % top, 20 % bottom (platform buttons, caption and progress bar), 8 % sides;
landscape and square 10 % on every side. Bottom captions sit on the bottom edge
of the safe area, top captions on its top edge. The font shrinks when a full line
of `maxLineChars` would not fit the safe width.

## Rendering

After the scenes are assembled with audio:

- **sidecar / both:** `captions.srt`, `captions.vtt` (WebVTT with inline word
  timestamps such as `<00:00:01.200>` when cues have words) and `captions.ass` are
  written next to `final.mp4`.
- **burned / both:** one FFmpeg pass with the libass `ass` filter over the
  generated ASS (PlayRes = output size). Video is re-encoded with the assembly's
  H.264 settings, audio is copied, every frame is kept; the usual ffprobe and
  full-decode checks then run on the burned file. With word timings, a second ASS
  layer draws only the word being spoken in `highlightColor`.

The render manifest gets a `captions` block: `mode`, `source`, `language`, cue
count, `burned`, `files`, the resolved `style` (font actually used, pixel size,
safe area), `qa` and the burn `burnArgs`. A preview of one scene shows that
scene's cues at preview time.

**Requirements:** an FFmpeg built with libass (`--enable-libass`; the Debian and
Ubuntu `ffmpeg` packages and the release image have it). Without it a burned
render fails with `captions:burn` and the fix; `sidecar` still works. Fonts come
from the system (the image ships DejaVu, Liberation and Noto); a theme font that
is not installed falls back to the closest installed family, and the manifest
records which one.

## Quality rules

Checked by `validate_project` (warnings with the cue's path) and recorded in the
render manifest (`captions.qa`). Defaults from the Netflix Timed Text Style Guide
(sources in research/SOURCES.md):

| Rule | Limit |
| --- | --- |
| `lineLength` | ≤ `maxLineChars` (≤ 42) characters per line after the line break |
| `lineCount` | ≤ 2 lines |
| `readingSpeed` | ≤ 20 characters per second (text with whitespace collapsed, line breaks count as a space) |
| `minDuration` / `maxDuration` | 0.833 s to 7 s on screen |
| `gap` | ≥ 2 frames between cues (overlaps reported too) |
| `order` | cues in time order |
| `pastEnd` | cue ends after the video (it is cut there) |

They are warnings, not errors: a deliberately fast caption is the author's call.

**Line breaking:** one line when it fits; otherwise the best two-line split:
after sentence or clause punctuation, before a conjunction or preposition, never
after an article or possessive (English word list), the most even shape with a
slight preference for a longer bottom line, and not one or two words alone on the
top line. Text that cannot fit in two lines is wrapped greedily and reported.
Nouns and adjectives are not told apart (no part-of-speech tagging).

## Accessibility

Burned or sidecar captions cover WCAG 2.2 SC 1.2.2 (Captions, prerecorded) for
the speech in a reel when the cues match the voice-over; sound effects and music
are not described automatically. Sidecars let players show captions on demand.
SC 1.2.4 (live) does not apply (no live output). Audio description (SC 1.2.5) is
not built yet: an optional second voice track is a follow-up of #300.

## Not yet

- Speech-to-text for an uploaded voice-over (an optional local provider such as
  faster-whisper; follow-up PR on #300).
- Caption approval tools: `get_captions`, `update_captions`, then render.
- Several languages per render; animated "social" caption styles beyond the word
  highlight.
