---
name: script-timing
title: Script timing
description: Fit words, reading and scenes into the time available, in frames. Use when writing or editing on-screen text, voice-over lines or scene durations. (What the video says, and its structure, is the user's decision.)
---
# Script timing

**Use when:** writing on-screen text or voice-over, or setting scene lengths.
This skill is arithmetic, not taste: what the video says and how it is
structured come from the brief and the user.

## Rules
1. Work in frames. frames = round(seconds × fps), converted once from
   absolute times; never add up rounded scene lengths and convert again.
2. Voice-over budget: words = seconds × words-per-minute ÷ 60. At 150 wpm
   that is 2.5 words a second (a 30 s video holds about 75 words; at an
   explainer's 130 wpm, 65: `voice-over` rule 1). Leave 10-15 % of the
   running time without narration.
3. On-screen text needs time to be read: at least 0.33 s per word, and at
   least characters ÷ 20 seconds, whichever is longer, counted from when the
   text has finished arriving, not from when it starts to animate. (Captions
   have their own limits: `captions-and-accessibility`.)
4. The first frame is never empty: platforms use it as a thumbnail and a
   scroll decision is made on it.
5. One idea per scene. If a scene needs two sentences of explanation, it is
   two scenes.
6. Do not leave more than about 3 s without a visible change (new text, a
   cut, a move), unless the stillness is the point.
7. The last line or card holds still for at least 2 s.
8. Write for the ear: active voice, one claim per sentence, sentences of 20
   words or fewer; numbers and abbreviations written as they are spoken.
9. Read the script aloud with a timer before rendering; the measured time,
   not the estimate, decides the scene lengths.

## In RenderWeld
- Scene length: `durationSeconds` (rounded to frames) or `durationFrames`;
  every edit returns `timing` with each scene's start frame and length.
- Template minimum and maximum durations come from `list_templates`; out of
  range is a validation error.
- A voice-over with word timestamps (`generate_voice`) gives exact speech
  times; set scene lengths from them instead of from estimates.
- `validate_project` warns about scenes under 0.25 s and about a total more
  than 10 % (at least 1 s) away from `brief.targetSeconds`.

## Signs of a generic, machine-made video
- Text that disappears before it can be read; a wall of words on one card.
- Narration that runs over the end, or describes exactly what is on screen.
- An empty or logo-only first frame.

## Before you render
- [ ] Words fit the budget at the chosen pace; the script was read aloud and timed.
- [ ] Every text line has its reading time after it has fully appeared.
- [ ] First frame shows the subject; final card holds 2 s.

## Sources
- BBC Subtitle Guidelines (reading rates; bbc.co.uk/accessibility/forproducts/guides/subtitles).
- Netflix Timed Text Style Guide (20 characters a second; partnerhelp.netflixstudios.com).
- Voice-over pacing of 140-160 wpm is common practitioner guidance; measure your own voice.
