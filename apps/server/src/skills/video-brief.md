---
name: video-brief
title: Video brief
description: Turn a request into a written brief before building anything, so the manifest comes from the user's answers, not from guesses. Use when a new video starts, or when its goal, platform or length changes.
---
# Video brief

**Use when:** a new video starts, or the goal, platform or length changes.
A model fills every gap you leave with a default, and defaults are what make
videos look generic. Ask, or write the default down and mark it assumed.

## Rules
1. Never infer the goal, audience, platform or length from style words
   ("modern", "engaging"). Ask, or state the default and label it *assumed*.
2. Ask only what the request has not already answered, in one message: at
   most about eight questions (group related topics), each with a suggested
   default the user can accept with "yes". The topics:
   goal (one sentence: "after watching, <who> will <do what>"), audience and
   language, where it is posted (platform, organic or paid), size or sizes,
   length, tone (three adjectives, each turned into something measurable such
   as pace or colour), brand (logo, colours, fonts), the one call to action,
   captions (burned, sidecar file, both, which languages), voice (human or
   synthetic, accent, pace), music (licence source) and anything that must
   appear word for word.
3. Take sizes and limits from the platform's current spec, not from memory.
   Size is never assumed: if the user did not say, ask; there is no "usual"
   aspect ratio.
4. Every factual claim in the video traces to a source the user gave you;
   otherwise leave it out. Never invent numbers, quotes or testimonials.
5. Record the licence of every asset you add (music, fonts, footage, images,
   a voice or likeness). A cloned or synthetic voice of a real person needs
   that person's consent, from the user.
6. If the video shows realistic synthetic people or events, decide with the
   user how it will be disclosed on the platform it goes to.
7. List the deliverables: every size, language, caption file and cut-down.
8. Read the brief back as a short table and wait for an explicit yes before
   writing scenes. Keep open questions listed; do not resolve them yourself.

## In RenderWeld
- The `brief_intake` prompt asks the open questions in one message; use it.
- Store the answers in the manifest `brief`: `goal`, `audience`, `style`,
  `platform`, `targetSeconds`. `validate_project` warns when the total length
  is more than 10 % off `targetSeconds`.
- `brief.platform` changes the safe areas of tall frames (see
  `layout-and-type`). Extra sizes are `variants`; each may set its own
  `platform`.
- Asset licences go in `upload_asset` / `add_asset_from_url` (`license`);
  `validate_project` warns about assets without one.
- Captions: `update_captions { mode }`; voice: `generate_voice` needs the
  user's agreement to the cost (`acknowledgeCost: true`).

## Signs of a generic, machine-made video
- A silent default size and length nobody asked for.
- Tone words with no numbers behind them; invented statistics.
- Default "upbeat" music chosen without the user.

## Before you render
- [ ] Goal sentence, audience, platform, size(s), length and the call to action are the user's, or marked assumed and confirmed.
- [ ] Caption mode, voice and music decided with the user; every asset has a licence.
- [ ] Every claim has a source; disclosure decided where it applies.
- [ ] The user said yes to the brief.

## Sources
- OpenAI, Sora 2 prompting guide: unstated details are invented by the model (developers.openai.com/cookbook/examples/sora/sora2_prompting_guide).
- US FTC, advertising substantiation policy (ftc.gov).
- YouTube and TikTok policies on labelling realistic synthetic content (support.google.com/youtube/answer/14328491; tiktok.com/transparency).
