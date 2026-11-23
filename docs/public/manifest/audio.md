---
title: "Audio: loudness, mixing and toggles"
description: "How ReelForge Studio mixes and finishes a render's audio: loudness presets and their sources, platform recommendations, ducking of music under the voice, fades, bus gains, the on/off toggles and muted renders, and the checks after the final encode."
folder: "manifest"
slug: "audio"
order: 4
tags: [manifest, reference, audio]
---

# Audio: loudness, mixing and toggles

Every render mixes its audio once over the whole timeline, normalises it to a
loudness preset, encodes it to AAC and then measures the finished file again.
This page covers what you can set and why the defaults are what they are.

## What happens in a render

1. **Mix.** Music, voice and sound effects are mixed into one 48 kHz stereo PCM
   track as long as the video, before any encoding. Scene joins (and the chunk
   seams of a fanned-out render) never cut the audio, so they cannot click.
2. **Measure and normalise.** FFmpeg's `loudnorm` measures the mix (pass 1),
   then applies the gain that reaches the preset's integrated loudness using the
   measured values (pass 2, `linear=true`). When one gain would push the true
   peak over the ceiling, loudnorm limits the peaks instead (its dynamic mode);
   the render manifest says which happened (`audio.loudness.normalisation`).
   The true-peak target is 0.5 dB under the ceiling to leave room for the AAC
   encoder's overshoot.
3. **Encode** to AAC, 192 kb/s, 48 kHz.
4. **Verify** the delivered `final.mp4` (after the caption burn-in, if any) with
   FFmpeg's `ebur128` meter: integrated loudness, true peak and loudness range
   go into the render manifest (`audio.loudness.measured`) and into
   `get_render_output` (`audio`).

## Loudness presets

| Preset | Integrated | True peak ceiling | LRA guidance | Use it for |
| --- | --- | --- | --- | --- |
| `social` (default) | -14 LUFS | -2 dBTP | 11 LU | Reels, Shorts, TikTok, web players |
| `broadcast-ebu` | -23 LUFS | -1 dBTP | 20 LU | European broadcast, EBU R 128 delivery |
| `broadcast-atsc` | -24 LKFS | -2 dBTP | 20 LU | North American broadcast, ATSC A/85 |
| `podcast` | -16 LUFS | -1 dBTP | 11 LU | Audio-first and podcast video |
| `off` | the mix as it is | | | You master the audio yourself |

LUFS and LKFS are the same unit (ITU-R BS.1770). The **QA rule** checks the
delivered file: integrated loudness within ±1 LU of the target and true peak at
or under the ceiling. By default a miss is a warning in the render manifest
(`audio.qa`); with `render.audio.loudnessQa: fail` it fails the render. The
loudness range is only ever a warning and is never compressed to meet the
guidance: EBU R 128 itself does not recommend LRA for programmes under one
minute, which most reels are.

**Why -2 dBTP for `social`.** Platforms transcode every upload again (AAC or
Opus at their own bitrates), and lossy encoding raises true peaks. Spotify,
the one large platform that publishes its rule, asks for -1 dBTP in general and
-2 dBTP for masters louder than -14 LUFS. -2 dBTP keeps a reel clean after the
platform's encode.

### Where the numbers come from

Read and checked on 2026-11-23; details in the repository's
`research/SOURCES.md` ("Loudness and A/V sync").

- **EBU R 128 (2023)**: target -23.0 LUFS (±1.0 LU where it cannot be met
  exactly, e.g. live), true peak not above -1 dBTP; Loudness Range "not
  recommended" for programmes under one minute. EBU R 128 s2 (2023) for
  streaming: stream at -23 LUFS, or adapt to -20 to -16 LUFS for mobile
  listening.
- **ATSC A/85:2013** (referenced by the US CALM Act rules): -24 LKFS with about
  ±2 dB measurement tolerance, true peak -2 dBTP (from ITU-R BS.2434's summary
  table; the ATSC PDF itself could not be fetched here, and ATSC published an
  A/85 revision in July 2026: VERIFY before relying on it for delivery).
- **Apple Podcasts**: about -16 dB LKFS ±1 dB, true peak not above -1 dBFS,
  measured per BS.1770-5, before encoding.
- **Spotify**: plays back at -14 LUFS by default; masters at most -1 dBTP, -2
  dBTP when louder than -14 LUFS.
- **AES TD1004** (via ITU-R BS.2434): -16 to -20 LKFS for audio streaming.

### Platform recommendations

| Where it goes | Preset | Notes |
| --- | --- | --- |
| Instagram Reels, TikTok, YouTube Shorts, Facebook, X, LinkedIn | `social` | None of these publishes a loudness target. -14 LUFS is the widely used convention, not an official number. Platforms that normalise are reported to turn loud videos down but not quiet ones up (secondary sources, VERIFY per platform), so a render under the target just sounds quiet |
| Your own website or app player | `social` | Browsers do not normalise |
| Spotify video podcasts | `social` or `podcast` | Spotify's published default is -14 LUFS |
| Apple Podcasts, podcast hosts | `podcast` | |
| Broadcast in Europe | `broadcast-ebu` | Delivery specs differ per broadcaster: check theirs |
| Broadcast in the US and Canada | `broadcast-atsc` | Check the network's delivery spec |

## Setting the preset

The preset of a render is, first found wins:

1. `render_project`'s `audio.loudness` (REST: `POST /v1/projects/:id/renders`
   with `{ "audio": { "loudness": "broadcast-ebu" } }`);
2. the manifest's `audio.loudness`;
3. the server setting `render.audio.loudness` (`REELFORGE_RENDER_AUDIO_LOUDNESS`,
   or at runtime with `update_config` / `PATCH /v1/config`), default `social`.

## Mixing

```json
"audio": {
  "music": { "asset": "music", "volume": 0.8, "fadeInSeconds": 0.25, "fadeOutSeconds": 1,
             "ducking": { "depthDb": 18, "attackMs": 120, "releaseMs": 400 } },
  "voice": { "asset": "voice", "startFrame": 15 },
  "sfx": [{ "asset": "whoosh", "atFrame": 90 }],
  "gainDb": { "music": -3, "voice": 0, "sfx": -2 },
  "loudness": "social"
}
```

- **Buses.** `voice`, `music` and `sfx` each have a gain in dB (`gainDb`,
  -60 to +12, default 0), applied after each track's own `volume`. The loudness
  preset then sets the level of the whole mix, so bus gains set the balance,
  not the final loudness.
- **Fades.** Music fades in over `fadeInSeconds` (default 0.25 s) and out over
  `fadeOutSeconds` (default 1 s). The voice and every sound effect get short
  edge fades (10 ms and 5 ms), and the whole mix 10 ms at both ends, so a sound
  that starts or stops on a non-zero sample, or a player that loops the reel,
  does not click.

### Ducking

`music.ducking: true` lowers the music while someone speaks, with the defaults
below; an object tunes it; `false` (default) leaves the music alone.

| Setting | Default | Meaning |
| --- | --- | --- |
| `depthDb` | 18 | How far the music goes down under speech (0 to 40 dB) |
| `attackMs` | 120 | Ramp down; it ends where the speech starts |
| `releaseMs` | 400 | Ramp back up after the speech ends |
| `thresholdDb` | -40 | Voice level (dBFS) under which the voice counts as a pause |

How it works: the voice file is scanned for speech (FFmpeg `silencedetect`,
pauses of at least 0.2 s under `thresholdDb`), and the music gets a volume
curve that goes down by `depthDb` over each speech segment. Because the whole
voice is known before mixing, the ramp down finishes *before* the first
syllable, which a live sidechain compressor cannot do; and the depth is exactly
what you set, whatever the voice's level. Pauses shorter than attack + release
keep the music down, so it does not pump between words. The segments are in
the render manifest (`audio.ducking.windows`). The threshold is in dBFS of the
voice file as uploaded; a very quiet voice file may need a lower threshold.

## Toggles and mute

Turn a bus off without removing it from the manifest, for the project or for
one render:

```json
"audio": { "enabled": { "music": false }, "mute": false }
```

`render_project` takes the same as `audio: { mute, voice, music, sfx, loudness }`,
which wins over the manifest. Examples: `{ "music": false }` for a voice-only
cut, `{ "sfx": false }`, `{ "mute": true }` for a silent autoplay version.
Captions are switched separately (`captions`).

**A muted render** carries, depending on the server setting
`render.audio.mutedTrack`:

- `silent` (default): a valid silent AAC track. Safest: some players, editors
  and upload pipelines expect an audio stream, and it keeps every render of a
  project the same shape.
- `none`: no audio stream. Smaller and honest about having no sound; most
  social platforms accept it, but some ad and broadcast ingest specs require a
  stream (VERIFY with the destination).

A silent or muted track is not normalised (there is nothing to measure), and the
loudness QA rule is skipped (`checks.loudness: "skipped"`).

## A/V sync

Every render checks that the audio starts at 0 like the video (no start offset
or edit-list shift) and that audio and video last the same within one frame.
ITU-R BT.1359-1 puts the detectability of a sound/picture offset at about
+45 ms (sound early) to -125 ms (sound late); one frame (33 ms at 30 fps) is
inside it. A mismatch fails the render (`checks.avSync`).

## In the render manifest

`audio` in `render-manifest.json` has the tracks that played, `toggles`,
`gainDb`, `ducking` (with the speech windows), `loudness` (`preset`, `target`,
`input` as measured before normalisation, `normalisation`, `gainDb`, `measured`
after the final encode), `avSync` and `qa` (`ok`, `mode`, `issues`).
`get_render_output` repeats the essentials as `audio`.
