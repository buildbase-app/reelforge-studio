---
name: voice-over
title: Voice-over
description: Pace, spoken-form text, pronunciation, pauses, emphasis and consent for narration, human or synthetic. Use when writing narration or generating text-to-speech.
---
# Voice-over

**Use when:** writing narration or generating it with a text-to-speech provider.

## Rules
1. Pace about 150 words a minute (140-160); slower (130-150) for explainers;
   never above about 180.
2. Write text as it should be spoken: numbers, dates, units, currencies and
   abbreviations spelled out the way the narrator says them.
3. Keep a pronunciation list for the project: brand and product names,
   people, places and acronyms, with an alias or a phonetic spelling. Listen
   to every name in the generated audio.
4. Pauses: about a quarter second at a comma, 0.4-0.7 s at the end of a
   sentence, 0.8-1.5 s between sections. Use punctuation for pauses; avoid
   long runs of break tags, which make synthetic voices unstable.
5. One emphasised word per sentence, chosen on purpose.
6. Match the voice to the audience and the brand: accent for the audience's
   locale; the tone adjectives of the brief turned into settings and a
   reference read.
7. Generate two or three takes of important lines and keep the best.
8. Keep the word timings of the narration; they drive caption timing and the
   moment each visual appears (see `av-sync`).
9. Takes recorded or generated separately are joined on breaths with very
   short crossfades (5-20 ms) so there are no clicks.
10. A cloned or synthetic voice of a real person needs that person's written
    consent, confirmed by the user.
11. Do not narrate what the picture already says; narration adds what the
    picture cannot.

## In RenderWeld
- `generate_voice` (needs a configured text-to-speech provider and the
  user's agreement to its cost, `acknowledgeCost: true`) stores the audio as
  an asset with word timestamps; `set_audio { voice: { asset, startFrame } }`
  places it.
- Captions can come straight from those word timings (`get_captions`), so
  narration and captions stay in sync.
- One voice track per video: generate the whole narration in one call, or
  join separate takes in an audio editor first (rule 9) and upload the
  result with `upload_asset`.
- A voice longer than the video is cut at the end: fit the script first.
- Ducking (`audio.music.ducking`) keeps the music under the voice.

## Signs of a generic, machine-made video
- Identical intonation and sentence length throughout; a rising list cadence.
- Mispronounced brand names; no breaths, or breaths spliced mid-word.
- Talking wall to wall with no air.

## Before you render
- [ ] Pace measured in words a minute; pronunciation list applied and every name checked by ear.
- [ ] Voice fits the time available; no clicks at joins.
- [ ] Consent confirmed for any real person's voice.

## Sources
- ElevenLabs best practices: normalisation, pronunciation, pauses (elevenlabs.io/docs).
- W3C Pronunciation Lexicon Specification (w3.org/TR/pronunciation-lexicon) and SSML 1.1.
- BBC Subtitle Guidelines (speech rates).
