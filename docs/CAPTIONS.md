# Captions

RenderWeld burns captions into the video, writes them as sidecar files, or both
(issue #300, decisions D-107 and D-114). Captions are **off by default**: a project
renders exactly as before until you set `captions.mode`, pass `captions` to
`render_project`, or the operator sets the server default `captions.defaultMode`.

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

Then `get_captions` (show the user, ask for approval), `update_captions`
(`approve: true` once the user agrees), `render_project` (optionally
`captions: "burned"` to override the mode for one render) and
`get_render_output`: `captions.burned`, `captions.files` (SRT, WebVTT, ASS per
language and description tracks, with signed download links) and `captions.qa`.

## Turning captions on and off

| Where | How | Wins over |
| --- | --- | --- |
| One render | `render_project` / `POST /v1/projects/:id/renders` `captions: off \| burned \| sidecar \| both` | everything |
| One project | `captions.mode` (`update_captions { mode }`, `update_project`, `import_captions { mode }`) | the server default |
| The server | `captions.defaultMode` (`RENDERWELD_CAPTIONS_DEFAULT_MODE`, the config file, or at runtime `update_config` / `PATCH /v1/config`, admin) | nothing; default `off` |

`burned` = in the video only; `sidecar` = files only (the video is untouched);
`both`. `get_captions` reports the effective `mode` and `modeSource`
(`render`, `project`, `server` or `default`). The server default is read when a
render is queued, so a queued render is not changed by a later config change.

## Where cues come from

For the primary language, in this order; the first that has any caption cues wins
(other languages come from `captions.tracks`, below):

1. **`captions.cues`**: written by hand, by an agent (`update_captions`), or imported with
   `import_captions` (REST `POST /v1/projects/:id/captions/import`, body
   `{ content, format?, mode?, language? }`). SRT and WebVTT are parsed; tags,
   cue settings, `NOTE`/`STYLE`/`REGION` blocks are dropped, author line breaks
   are kept. A parse error is `422 invalid_captions` with the line number.
2. **The voice's word timestamps** (`audio.voice.words`). `generate_voice` with
   ElevenLabs stores them on the voice track (times relative to the voice start).
   Cues are built from them at validation and render time, so moving the voice
   (`startFrame`) keeps captions in sync. Setting another voice asset drops the
   old words. Cues built this way keep their words, which enables the word
   highlight. **`transcribe_captions`** (speech-to-text of an uploaded voice-over,
   below) stores its words in the same place.
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
| `captions.cues[]` | `{ start, end, text, words?, kind? }`, seconds of video time, in time order per kind, `end > start`. `text` may contain `\n` to force a line break. `words[]` = `{ text, start, end }`. `kind`: `caption` (default) or `description` (audio description, below). |
| `captions.language` | The primary language, a BCP 47 tag (`en`, `pt-BR`); written into the WebVTT and ASS headers and the render manifest. Default: `brief.language` when it is a valid tag. |
| `captions.tracks` | More languages: `{ "<tag>": { cues: [...] } }`, at most 19 (20 languages in all), never the primary one, each tag once (case-insensitive). |
| `captions.burnLanguage` | The one language burned in (modes `burned` and `both`). Default: the primary language. Must be the primary language or a key of `tracks`. |
| `captions.approval` | `{ etag, approvedAt }`, set by `update_captions { approve: true }`. Approved while the captions still have that etag. |
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
| `fontFamily` | theme `fontFamily` | the first family of the list that is a project font asset, a bundled font (Inter, Source Serif 4, JetBrains Mono) or installed; project and bundled fonts go to libass with the burn pass (`fontsdir`). None of them: the closest installed family (`fc-match`), and `validate_project` warns |
| `weight` | `700` | 600 and above draw bold |
| `color` | `#ffffff` | text |
| `background` | `#000000` | box behind each line; `null` or `"none"` = no box, outlined text |
| `backgroundOpacity` | `0.8` | |
| `outline` | `#000000` | outline colour when there is no box; `null` or `"none"` = none |
| `highlightColor` | theme `accent` | the word being spoken |

`update_project` takes a JSON merge patch, where `null` deletes a key (and the
default comes back), so switch the box or outline off with `"none"` there:
`{ "captions": { "style": { "background": "none" } } }`.

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

The render manifest gets a `captions` block: `mode`, `modeSource`, `source`,
`language`, cue count, `burned`, `burnLanguage`, `files`, the resolved `style` (font
actually used, pixel size, safe area), `qa`, `etag`, `approved`, the burn `burnArgs`,
and `tracks` (per language: the cues and descriptions as rendered, `files`, `qa`).
The top-level cue fields describe the primary language. A preview of one scene shows that
scene's cues at preview time.

**Requirements:** an FFmpeg built with libass (`--enable-libass`; the Debian and
Ubuntu `ffmpeg` packages and the release image have it). Without it a burned
render fails with `captions:burn` and the fix; `sidecar` still works. The caption
font is a project font asset or a bundled font (their files are passed to libass
with `fontsdir`), or a system font (the image ships DejaVu, Liberation and Noto).
A family that is none of these falls back to the closest installed family;
`validate_project` warns, and the manifest records the font used
(`style.fontName`) and its source (`style.fontSource`: `project`, `bundled`,
`installed` or `fallback`).

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

## Several languages

The primary language's cues are `captions.cues` (or built from the voice or scene
text); every other language is a key of `captions.tracks`. Add one with
`update_captions { etag, language: "es", cues: [...] }` (`cues: []` removes it).
Tags are validated as well-formed BCP 47 (letters, digits and hyphens, at most 35
characters, accepted by `Intl.getCanonicalLocales`); they are compared without regard
to case.

- **Burned:** exactly one language, `captions.burnLanguage` (default the primary one).
- **Sidecars** (modes `sidecar` and `both`): one set per language. The primary
  language keeps the names `captions.srt`, `captions.vtt`, `captions.ass`; the others
  are `captions.<tag>.srt`, `.vtt` and `.ass` (for example `captions.pt-BR.vtt`).
- **Headers:** each WebVTT file starts with `Language: <tag>` and each ASS file has
  `Language: <tag>` in `[Script Info]` (libass ignores it; editors show it).
- **Quality rules** run per language (`validate_project` warnings name the track, e.g.
  `captions.tracks.de.cues.0`; `get_captions` and the render manifest have `qa` per
  language).

The line breaker's word lists are English; other languages get the punctuation and
balance rules. CJK text is broken at spaces only (TODO: per-character breaking).

## Audio description (text track)

A cue with `kind: "description"` describes what is on screen for people who cannot
see it. It is **never burned** and never part of the SRT or ASS files: each language's
descriptions are written to `descriptions.vtt` (primary) or `descriptions.<tag>.vtt`,
a WebVTT file with the headers `Kind: descriptions` and `Language: <tag>`, in every
mode except `off` (it has no other way to reach the viewer). `get_render_output`
lists it with `kind: "descriptions"`; a web player attaches it as
`<track kind="descriptions" srclang="en" src="descriptions.vtt">`, which screen
readers can announce. Descriptions may overlap captions; they are kept in time order
among themselves and are not checked by the caption quality rules.

## Speech-to-text

`transcribe_captions` (REST `POST /v1/projects/:id/captions/transcribe`, scope
`render`) transcribes the project's voice track with a **local** speech-to-text
provider and stores the word timings on `audio.voice.words`, so cues are built from
them exactly as from TTS timestamps (`buildCuesFromWords`, above). Manual caption
cues take precedence; `replaceCues: true` removes them (description cues are kept).
The detected language becomes `captions.language` when that is not set.

1. Upload the voice-over: `upload_asset` (or `POST /v1/assets`) with `projectId` and
   `assetId: "voice"`, then `set_audio { voice: { asset: "voice" } }`.
2. `transcribe_captions { projectId, language?: "auto" | "<tag>" }`.
3. `get_captions`, show the user, `update_captions` to fix words, approve, render.

The default provider is **faster-whisper** (MIT, by SYSTRAN; CTranslate2 Whisper
models), run as an external program, `reelforge-whisper`
([deployment/stt/reelforge-whisper](../deployment/stt/reelforge-whisper)). It is
**not in the release image** (Python, faster-whisper and a model add about 800 MB
with the `tiny` model and more with larger ones): build the optional layer
[deployment/stt/Dockerfile](../deployment/stt/Dockerfile) on top of the image, which
downloads the model at **build** time
([deployment/stt/README.md](../deployment/stt/README.md)). Without the program,
speech-to-text is off and `get_capabilities` says so (`captions.stt.available: false`
with the reason); `transcribe_captions` answers `409 stt_unavailable`.

| Setting | Default | |
| --- | --- | --- |
| `captions.stt.provider` | `faster-whisper` | provider id (plugins: `SpeechToTextPlugin`) |
| `captions.stt.command` | `reelforge-whisper` | a name on `PATH` or an absolute path |
| `captions.stt.model` | `small` | a pre-downloaded model name or a model directory |
| `captions.stt.modelDir` | (Hugging Face cache) | where the models were downloaded (`/opt/reelforge/whisper-models` in the layer) |
| `captions.stt.language` | `auto` | or a tag; Whisper gets its primary subtag (`pt` for `pt-BR`) |
| `captions.stt.computeType` | `int8` | CTranslate2 compute type (`float16` needs a GPU) |
| `captions.stt.device` | `cpu` | `cpu`, `cuda`, `auto` |
| `captions.stt.timeoutSeconds` | `600` | the program is killed after it |

All are runtime settings (`update_config`, admin, audit-logged; docs/CONFIG.md).

**No network at run time.** The server starts the program with `HF_HUB_OFFLINE=1`
(and the program sets it itself before loading the library) and the model is
loaded with `local_files_only`, so a model that was not pre-downloaded fails with
exit 3 and a message rather than being fetched. **Safety:** the program is started
directly with a fixed argument array (never a shell); the input is the voice asset's
file from the asset store (an absolute path); its environment is the render
allowlist (no server secrets) plus the Hugging Face offline switches; it is killed
after `timeoutSeconds` or when it prints more than 16 MB; its JSON is validated and
every word is reduced to plain text (control characters removed, at most 100
characters). One transcription runs at a time per server process (`429 stt_busy`
otherwise). Results are cached by the file's sha256, model, compute type, device and
language under `<cacheDir>/stt/`.

Another engine (whisper.cpp, a cloud API) is a `SpeechToTextPlugin`
(`packages/core/src/plugins.ts`: `availability(settings)` and `transcribe(req, ctx)`
returning `{ language, words: [{ text, start, end }] }`) registered with
`registry.registerStt()`; a cloud one must be listed in docs/PRIVACY.md.

## Glossary

Brand and product names are the captions' most visible errors. A project's `glossary` (#486) gives each term its
exact spelling, how the voice should say it, and the spellings speech-to-text tends to produce. The user or their
agent writes every entry; the studio only applies them.

```json
"glossary": [
  { "term": "RenderWeld", "spoken": "render weld", "alternatives": ["render weld", "rendaweld"] },
  { "term": "Claude Code", "doNotTranslate": true }
]
```

- **Speech-to-text** (`transcribe_captions`): the terms are the transcription's prompt (faster-whisper
  `initial_prompt`). Afterwards, each term in any letter case and each listed alternative becomes the term's exact
  spelling, matched as whole words (never fuzzy, which would rewrite real words). The answer lists every replacement
  in `glossaryReplacements`.
- **Voice** (`generate_voice` or `run_provider` with a `projectId`): the provider reads each term's `spoken` form,
  while the voice track keeps the script's text and its word timings turn the spoken form back into the term, so the
  captions spell it right.
- **Caption QA**: when the project has a voice script, a term the script says more often than the cues spell it
  exactly (`missingFromCaptions`), or the other way round (`notInScript`), is an issue under `qa.glossary` and makes
  `qa.ok` false.
- **`doNotTranslate`** is stored for agents and translation tools: the studio translates nothing itself.

Up to 200 terms; a term appears once (letter case ignored).

## Review and approval

Captions are words in the user's video, so an agent shows them before the final
render and **asks**; it never assumes approval (the MCP workflow guide and the
`make_reel` prompt say so).

- **`get_captions`** (`GET /v1/projects/:id/captions`, scope `read`; or
  `GET /v1/renders/:id/captions` for a finished render): every language's caption
  cues (`{ start, end, text, words? }`) and description cues, `qa` per language, the
  effective `mode` and `modeSource`, `burnLanguage`, an `etag`, and `approved`.
  `?language=` (or `language`) returns one language.
- **`update_captions`** (`PATCH /v1/projects/:id/captions`, scope `write`): needs the
  `etag` (in the body, or `If-Match` over REST); if the captions changed since
  (another edit, a new voice, a moved voice track), it answers `409
  captions_conflict` with the current etag: read again and show the user. It
  replaces one language's cues (`cues`), or edits some by their index in
  `get_captions` (`edits: [{ index, kind?, text?, start?, end?, delete? }]`), and sets
  `mode`, `burnLanguage` and `highlight`. Editing cues that were built from the voice
  saves them as manual cues (they no longer follow the voice); an edited text drops
  that cue's word timings (no wrong highlight). Each kind is kept in time order. The
  quality rules run again and come back in the answer. `approve: true` stores
  `captions.approval` with the etag after the update; any later change to the
  captions voids it (`approved: false`), and `approve: false` withdraws it.
- **Audit:** every update writes `captions.update` (or `captions.approve`) with the
  language, cue and edit counts, the etag before and after and the new version.
- **Renders** record `captions.etag` and `captions.approved` in the render manifest
  and in `get_render_output`. Rendering does not require approval: that is the
  agent's and the user's call.

The etag covers what the captions show: mode, burn language, highlight, style and
every language's resolved cues (built from the voice or scenes included), not the
approval itself.

## Accessibility

Burned or sidecar captions cover WCAG 2.2 SC 1.2.2 (Captions, prerecorded) for
the speech in a reel when the cues match the voice-over; sound effects and music
are not described automatically. Sidecars let players show captions on demand.
SC 1.2.4 (live) does not apply (no live output). For SC 1.2.3 / 1.2.5 (audio
description) RenderWeld writes a **text** description track (`kind: "description"`
cues, above) that a player exposes as `<track kind="descriptions">`; whether that
satisfies 1.2.5 depends on the player announcing it (browser support for description
tracks is limited). A recorded description voice track (extended audio description)
is not built.

## Not yet

- A recorded audio-description voice track mixed into the audio (only the text
  track exists).
- Machine translation of cues into other languages (the agent writes them).
- Animated "social" caption styles beyond the word highlight; per-character line
  breaking for CJK.
- Speech-to-text as a background job with progress (it runs inside the request, up to
  `captions.stt.timeoutSeconds`).
