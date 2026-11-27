# Quality checks: thresholds and their sources

This page lists every automatic check the studio runs on a project or a finished render. For each one it gives the
threshold, where the number comes from and when that source was last read (#313). A number taken from a published
standard or guide cites it. A number the studio chose itself is marked **Studio default**, with the reason.

The numbers here and the numbers in the code must agree. `packages/core/test/qa-doc.test.ts` fails when they differ,
when a row loses its date, or when a row has neither a source link nor the words "Studio default". To change a
threshold, change the code, the row and its date together. Then record what you read in `research/SOURCES.md`.

The checks report; they do not rewrite the video. Each one either warns, recording the issue in the render manifest
and the API answer, or fails the render, as the "On a miss" column says. Settings named below change at runtime
(`update_config`, `PATCH /v1/config`; docs/CONFIG.md).

## Captions

Checked by `validate_project` (warnings, with the cue's path), by `get_captions` and `update_captions` (`qa`), and in
the render manifest (`captions.qa`). On a miss: a warning, never a failure, because a deliberately fast caption is the
author's call. Details: [CAPTIONS.md](CAPTIONS.md#quality-rules).

| Rule | Threshold | Source | Checked |
| --- | --- | --- | --- |
| `lineLength` | at most `captions.maxLineChars` characters per line: 16 to 42, default 42, or 32 on a portrait frame | Netflix English (USA) Timed Text Style Guide: "42 characters per line" (https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977). The portrait 32 is a Studio default: a narrow frame fits fewer characters at a readable size | 2026-11-25 |
| `lineCount` | at most 2 lines | Same guide: "Maximum two lines." | 2026-11-25 |
| `readingSpeed` | at most 20 characters per second | Same guide: "Adult programs: Up to 20 characters per second" (children's programmes: 17, not used) | 2026-11-25 |
| `minDuration` | at least 0.833 s on screen | Netflix Timed Text Style Guide, General Requirements: "Minimum duration: 5/6 (five-sixths) of a second per subtitle event" (https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617). Netflix's Subtitle Timing Guidelines say "20 frames (or 4/5 sec)"; 20 frames at 24 fps is 5/6 s, so the General Requirements figure is used | 2026-11-25 |
| `maxDuration` | at most 7 s on screen | General Requirements: "Maximum duration: 7 seconds per subtitle event" | 2026-11-25 |
| `gap` | at least 2 frames between cues | Netflix Subtitle Timing Guidelines: "Subtitles must have a minimum of 2 frames between them." (https://partnerhelp.netflixstudios.com/hc/en-us/articles/360051554394) | 2026-11-25 |
| `order` | cues in time order | Studio default: a structural check, no number | 2026-11-25 |
| `pastEnd` | no cue ends after the video | Studio default: a structural check, no number (the cue is cut at the end) | 2026-11-25 |
| caption safe area | portrait: 12 % top, 20 % bottom, 8 % sides; other shapes: 10 % on every side | Studio default (D-107): a margin that keeps burned-in captions clear of the common apps' buttons and captions; no platform publishes one | 2026-11-25 |

## Loudness

Measured on the final file after the encode (ITU-R BS.1770, FFmpeg `ebur128`).
Results are in `audio.qa`. On a miss: `render.audio.loudnessQa`, `warn` by default or `fail`. Rules: `loudness.integrated` is the target plus or minus the
tolerance; `loudness.truePeak` is the ceiling; `loudness.lra` is reported and never enforced, because EBU R 128 does not
recommend Loudness Range for programmes under one minute. Details:
[public/manifest/audio.md](public/manifest/audio.md#loudness-presets).

| Preset | Integrated | Tolerance | True peak ceiling | LRA (reported) | Source | Checked |
| --- | --- | --- | --- | --- | --- | --- |
| `social` | -14 LUFS | 1 LU | -2 dBTP | 11 LU | Spotify loudness normalization: "We adjust tracks to -14 dB LUFS" and "If your master is louder than -14dB integrated LUFS, keep True Peak below -2dB" (https://support.spotify.com/us/artists/article/loudness-normalization/). YouTube, TikTok and Instagram publish no target; -14 LUFS for them is a convention | 2026-11-25 |
| `broadcast-ebu` | -23 LUFS | 1 LU | -1 dBTP | 20 LU | EBU R 128-2023: programme loudness -23.0 LUFS, true peak "shall not exceed -1 dBTP" (https://tech.ebu.ch/docs/r/r128.pdf) | 2026-11-23 |
| `broadcast-atsc` | -24 LUFS | 1 LU | -2 dBTP | 20 LU | ATSC A/85:2013 as summarised in ITU-R Report BS.2434-0 (https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BS.2434-2018-PDF-E.pdf); atsc.org refused the download, and a July 2026 revision exists (VERIFY before broadcast delivery) | 2026-11-23 |
| `podcast` | -16 LUFS | 1 LU | -1 dBTP | 11 LU | Apple Podcasts audio requirements: "around -16 dB LKFS, with a +/- 1 dB tolerance" and true peak not above "-1 dB FS" (https://podcasters.apple.com/support/audio-requirements) | 2026-11-25 |

The 1 LU tolerance is Apple's figure. For `broadcast-ebu`, EBU R 128 allows plus or minus 1.0 LU only where the
target "is not achievable practically", so broadcast masters should land on -23.0. The limiter aims 0.5 dB under the
ceiling to leave room for the encoder's overshoot (Studio default, D-116).

## A/V sync

Checked on every render with sound (`checks.avSync`). On a miss: the render fails.

| Rule | Threshold | Source | Checked |
| --- | --- | --- | --- |
| audio start | the audio starts within 1 ms of the video | ITU-R BT.1359-1 puts detectability at "about +45 ms to -125 ms" (https://www.itu.int/rec/R-REC-BT.1359); the studio allows far less because its own files have no reason to drift | 2026-11-23 |
| length | audio and video last the same within one frame | Same source; one frame (33 ms at 30 fps) is inside the detectable range | 2026-11-23 |

## Picture

Every finished render and preview is decoded once more (#294). Results: `checks.freeze`, `checks.black`,
`checks.flash`, `checks.motion`, `checks.loop`, `checks.seek` and `videoQa`. On a miss: `render.qa.video`, `warn` by default, `fail`, or `off`. Details:
[public/manifest/formats.md](public/manifest/formats.md#picture-checks).

| Rule | Threshold | Setting | Source | Checked |
| --- | --- | --- | --- | --- |
| `video.freeze` | a picture unchanged for 3 s or more; noise tolerance -60 dB | `render.qa.freezeSeconds` | Studio default for the duration: a still held that long reads as a stuck video. FFmpeg's `freezedetect` defaults to 2 s, which flags ordinary holds on a title. The -60 dB tolerance is FFmpeg's default ("default 0.001"), read with `ffmpeg -h filter=freezedetect` on FFmpeg 6.1.1 | 2026-11-25 |
| `video.black` | black for 0.5 s or more; a pixel at or under 10 % luma is black, a picture when 98 % of it is | `render.qa.blackSeconds` | Studio default for the duration: a fade through black is shorter. FFmpeg's `blackdetect` defaults to 2 s, which misses a late first element. The pixel and picture levels are FFmpeg's defaults ("default 0.1", "default 0.98"), read with `ffmpeg -h filter=blackdetect` on FFmpeg 6.1.1 | 2026-11-25 |
| `video.flash` | more than 6 transitions (three flashes) in any one second; a transition is a change of at least 0.1 in relative luminance with the darker side below 0.80; saturated red (R/(R+G+B) at least 0.8) changes by more than 20 in (R-G-B) x 320; only flashing over 25 % of the picture counts | fixed | WCAG 2.2 SC 2.3.1 and its glossary: "no more than three general flashes and / or no more than three red flashes within any one-second period", a general flash is "a pair of opposing changes in relative luminance of 10% or more", "where the relative luminance of the darker image is below 0.80", "(25% of any 10 degree visual field on the screen)" (https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html). The red measure is WCAG 2.0's working definition, Note 3: "R/(R+ G + B) >= 0.8, and the change in the value of (R-G-B)x320 is > 20" (https://www.w3.org/TR/UNDERSTANDING-WCAG20/seizure-does-not-violate.html) | 2026-11-25 |
| `video.motion` | no frame differs from the picture a second before by 0.4 or more for 3 s or more (mean change of a 32 x 32 luma grid, 8-bit levels); stretches already frozen are left out | `render.qa.lowMotionSeconds`, `render.qa.motionFloor` | Studio default, measured on 1080 x 1920 H.264 with FFmpeg 6.1.1 (local sandbox): heavy grain on a still 0.31, a blinking cursor 0.14, text drifting at 20 px/s 0.63. The floor sits just above the grain. No published standard sets one | 2026-11-26 |
| `video.loop` | for a project with `output.loop`: the change from the last frame back to the first is over 0.5 levels and over 2 times the 95th percentile of the video's own frame-to-frame change (32 x 32 luma grid) | fixed | Studio default: a seam below 0.5 levels is not visible, and one within twice the video's ordinary motion reads as part of it. No published standard sets one | 2026-11-26 |
| `video.seek` | 2 frames of each render (from scenes whose engine renders frame ranges), rendered again on their own, differ from the same frames of the video by more than 24 levels in any cell of a 64 x 64 luma grid | `render.qa.seekFrames` | Studio default, measured with Remotion's kinetic-title on FFmpeg 6.1.1 (local sandbox): the same frame differs by at most 3 levels at 1080 x 1920 and 10 at 320 x 568 (encoding noise); a frame that moves, by 16 to 71. No published standard sets one | 2026-11-26 |

About the flash check:

- **Red.** WCAG 2.1 and 2.2 replaced the red measure with "more than 0.2 (unitless) in the CIE 1976 UCS chromaticity
  diagram", a note the W3C calls the working definition in the field, not normative text. The studio still uses the
  WCAG 2.0 measure. Measuring the newer one is a follow-up (#294).
- **Area.** WCAG measures a quarter of a 10-degree field (341 x 256 pixels on a 1024 x 768 screen). The studio takes a
  quarter of the whole picture, from an 8 x 8 grid of averaged cells. A small flashing element therefore passes,
  even one that would cover a quarter of a viewer's central vision on a large screen.
- **Not covered.** EA IRIS also marks an "extended flash failure": "between 2-3 flashes per second in any given 5
  consecutive seconds" (https://github.com/electronicarts/IRIS, read 2026-11-25). The studio does not check it, nor
  stripe patterns. Video for broadcast should still go through a dedicated analyser.

## Layout defaults

These shape every built-in template rather than check a result. Details:
[public/manifest/formats.md](public/manifest/formats.md#safe-areas).

| Default | Value | Source | Checked |
| --- | --- | --- | --- |
| action safe area | 3.5 % on every side | EBU R 95 v1.1: "The action safe area is 3.5% and the graphics safe area is 5%" (https://tech.ebu.ch/docs/r/r095.pdf); ITU-R BT.1848-1 gives the same margins | 2026-11-23 |
| title safe area | 5 % on every side | Same sources | 2026-11-23 |
| app overlay zone (tall video) | 14 % top, 35 % bottom, 6 % sides, for frames at least 1.6 times as tall as wide | Studio default: a conservative margin that clears the common social apps' buttons and captions. No platform publishes one, and they change it (VERIFY per platform before quoting a number for one) | 2026-11-23 |
| music ducking | 18 dB under speech, 120 ms attack, 400 ms release, speech above -40 dBFS | Studio default (D-116): no published standard sets a ducking depth; tune `music.ducking` per project | 2026-11-25 |

## Not checked yet

The craft catalogue in #313 lists more gates than the studio measures. These have a source but no check yet, so they
are guidance in the skills, not a gate:

- text contrast at least 4.5:1 (WCAG 2.2 SC 1.4.3);
- a picture-to-sound offset inside the BT.1359-1 range within a scene, not only at the file's start;
- voice-over at most 160 words a minute, motion, camera and physics rules, and text overflow in the final file
  (#294).
