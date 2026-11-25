---
name: av-sync
title: Audio and video sync
description: Tolerances for sound against picture, frame arithmetic, aligning visuals to narration and beats, and checking the result. Use when timing visuals to voice, music or sound effects, and when checking a render.
---
# Audio and video sync

**Use when:** timing a visual to a word, a beat or a sound, and when checking
a render.

## Rules
1. Tolerances: sound ahead of the picture is noticed at about 45 ms and
   unacceptable at about 90 ms; sound behind is noticed at about 125 ms and
   unacceptable at about 185 ms (ITU-R BT.1359). Aim for zero: audio never
   more than one frame early or three frames late.
2. Keep the timeline in frames, at a constant frame rate, with 48 kHz audio.
   Convert seconds to frames once, from absolute times.
3. A visual that a word names appears at the start of that word, or up to
   about 0.2 s before it, never noticeably after. People tolerate the
   picture leading the sound far better than the reverse.
4. A bullet point appears at the start of its phrase and stays through the
   sentence.
5. Beat frames: round(index × fps × 60 ÷ BPM + offset). Cut on the beat
   frame or one frame before it.
6. After rendering, measure: voice onsets against caption cues and visual
   events, and report the offset in milliseconds.

## In RenderWeld
- Every render checks that audio starts at 0 and that audio and video last
  the same within one frame (`checks.avSync`); a mismatch fails the render.
- `generate_voice` stores word timestamps; use them to place scene starts,
  bullet points and caption cues instead of estimating.
- Voice placement: `audio.voice.startFrame`; sound effects:
  `audio.sfx[].atFrame`. Both are frames, so compute them with rule 2.
- `validate_project` errors when a voice or sound effect starts after the end.

## Signs of a generic, machine-made video
- Narration describing a feature while the previous picture is still up.
- Cuts half a beat late; sound effects trailing the picture.

## Before you render
- [ ] Word timestamps used for every narration-driven visual.
- [ ] Beat grid computed if cutting to music.
- [ ] `checks.avSync` passes; measured offsets within one frame.

## Sources
- ITU-R BT.1359-1, relative timing of sound and vision (itu.int).
- EBU R 37 (broadcast chain targets).
- van Wassenhove et al. (2007), temporal window of audiovisual speech integration (doi.org/10.1016/j.neuropsychologia.2006.01.001).
