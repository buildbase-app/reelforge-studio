---
name: sound-and-mix
title: Sound and mix
description: Loudness targets, ducking, dialogue-to-music balance, sound-effect audibility, beat arithmetic and clean endings. Use when adding music, sound effects or voice to a video, and when reading the render's audio checks. (Which music and sound effects suit the video is the user's choice.)
---
# Sound and mix

**Use when:** adding or placing music, sound effects or voice, and when the
render reports audio issues. Which music and sound effects fit, and where
they go, is decided with the user; this skill is about levels and timing.

## Rules
1. Integrated loudness by destination (ITU-R BS.1770 measurement): web and
   social about -14 LUFS with true peak at or under -1 dBTP; European
   broadcast -23 LUFS, -1 dBTP (EBU R 128); US broadcast -24 LKFS (ATSC A/85).
   Deliver one target per file; variants of the same video match each other.
2. Speech must stay clearly above the music: keep the voice at least 7 dB
   above the bed, preferably 12 dB or more. Listeners, including hard-of-
   hearing listeners, rate the larger gap better.
3. Duck the music under speech: 12-20 dB lower; short attack (tens of
   milliseconds) and a release of a few hundred milliseconds; hold the duck
   through pauses shorter than about a second instead of pumping.
4. No sung lyrics under narration.
5. A sound effect lands on its picture event within ±1 frame; audio must
   never arrive more than about 45 ms before the picture (ITU-R BT.1359).
6. Each sound effect must be audible over the bed in its first half second.
   One that sits under the music is noise, not design: raise it, lower the
   music, or remove it.
7. Beat arithmetic: frames per beat = fps × 60 ÷ BPM (120 BPM at 30 fps is
   15 frames). Compute each beat frame from its index and round once; put
   cuts on beats and scene changes on phrase boundaries (4 or 8 bars).
8. Music ends on the end of a phrase, or fades over at least a second. Never
   stop it dead at the last frame.
9. Never clip: if the render reports a peak-limited mix, lower the loudest
    sounds (usually sound effects) rather than pushing the limiter.

## In RenderWeld
- `audio.loudness` picks the preset: `social` (-14 LUFS, -2 dBTP ceiling for
  the AAC encode), `broadcast-ebu`, `broadcast-atsc`, `podcast` or `off`.
  The finished file is measured; misses are in `audio.qa.issues`
  (`render.audio.loudnessQa` decides warn or fail).
- Ducking: `audio.music.ducking: true` or `{ depthDb, attackMs, releaseMs,
  thresholdDb }` (defaults 18 dB, 120 ms, 400 ms, -40 dB). It needs a voice.
- Balance: each track's `volume`, then bus gains `audio.gainDb.{voice,music,sfx}`.
  Fades: `audio.music.fadeInSeconds` and `fadeOutSeconds`.
- Sound effects: `audio.sfx: [{ asset, atFrame, volume }]`; `atFrame` is the
  frame of the picture event.
- Turn buses off for one render without editing the project:
  `render_project { audio: { music: false } }`, or `mute: true`.

## Signs of a generic, machine-made video
- Music louder than the voice; a hard stop at the end.
- Sound effects you can see but not hear; clipped peaks.

## Before you render
- [ ] Loudness preset matches the destination; variants share it.
- [ ] Ducking on wherever music plays under speech.
- [ ] Every sound effect on its frame and audible; music ends on a phrase or fades.

## Sources
- EBU R 128 (tech.ebu.ch/docs/r/r128-2014.pdf); ITU-R BS.1770; ATSC A/85.
- Spotify loudness normalisation (artists.spotify.com/help/article/loudness-normalization).
- ITU-R BT.1359 (detectability of audio ahead of video).
- Journal of Speech, Language, and Hearing Research, 2026, on dialogue-to-background ratios (pubs.asha.org/doi/10.1044/2026_JSLHR-25-00127).
- Audacity Auto Duck defaults (manual.audacityteam.org/man/auto_duck.html).
