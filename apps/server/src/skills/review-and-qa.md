---
name: review-and-qa
title: Review and QA
description: The professional editor's pass before a video is called final: technical checks, frames to look at, creative checks, findings and variants. Use before any render is delivered, and after any change to a delivered video.
---
# Review and QA

**Use when:** before you call a render final, and after every change.
The renderer checks the file; you check whether the video works.

## Rules
1. Each output matches its spec: size, aspect ratio and a constant frame
   rate; duration within one frame of the plan.
2. Loudness and true peak on target; sound in sync within a frame; no
   flashing over the limits (see `captions-and-accessibility`).
3. Captions pass their checks, names are spelled right, and the user
   approved the cues.
4. Automatic checks: the first frame is not empty; no stretch over about 3 s
   without change; no text smaller than 2.6 % of the short side; no line on
   screen too briefly to read; a video over 15 s is not silent unless that
   was asked for.
5. Look at frames, not only reports: each scene at its start and middle,
   the frames on both sides of every cut, and the last frame, at phone size
   (360 px wide).
6. Creative checks: the subject is clear from the first frame; one message
   and one call to action; with text and sound off, the pictures still tell
   the story; a stranger could describe each key frame in one sentence.
7. Run the artefact sweep from `physical-plausibility` on every generated
   clip.
8. Every claim traces to the brief's sources; every asset has its licence;
   disclosure is applied where needed.
9. Write findings ranked P0 (must fix), P1 (should fix), P2 (nice to have),
   each with the time, the problem, the exact change, and what to keep. No
   scores.
10. Variants: re-lay out each size instead of cropping; an A/B test changes
    one thing (the opening, the call to action or the thumbnail).
11. Name outputs so they sort and explain themselves, e.g.
    `project_v003_9x16_en_hookB.mp4`; keep the project version each render
    was made from.

## In RenderWeld
- `validate_project`: errors block the render; read every warning.
- `preview_scene`: a low-resolution render of one scene or the whole
  project (per variant) to look at before the final render.
- `get_render_output`: `checks` (metadata, decode, duration, avSync,
  loudness), `audio.qa.issues`, caption QA, the poster image, the storage
  location and a download link.
- `get_captions`: cue QA. `list_project_versions`: what changed; each render
  records the project version it was made from.
- The `review_reel` prompt walks through this checklist with the manifest
  and the validation report.
- Every size is a `variant`: `render_project { variants: [...] }` renders
  them in one call.

## Signs of a generic, machine-made video
- Never watched at phone size; auto-crops cutting off heads.
- Juddering from a frame-rate mismatch; loudness that differs between variants.

## Before you deliver
- [ ] Technical: spec, checks, loudness, sync, captions, flashing.
- [ ] Frames: start, middle, cuts, last frame, at phone size.
- [ ] Creative: subject from frame one, one message, one call to action.
- [ ] Findings written as P0/P1/P2 and all P0s fixed.

## Sources
- YouTube recommended upload encoding settings (support.google.com/youtube/answer/1722171).
- Netflix, BBC and WCAG references in `captions-and-accessibility`.
- EBU R 128 and ITU-R BT.1359 references in `sound-and-mix` and `av-sync`.
