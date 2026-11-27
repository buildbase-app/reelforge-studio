---
name: physical-plausibility
title: Physical plausibility
description: Gravity, arcs, inertia, contact, squash limits, human gait, blinking and lip sync in frames, plus the artefact sweep for generated footage. Use when animating objects, people or animals, when choosing or prompting generated clips, and in review.
---
# Physical plausibility

**Use when:** anything falls, bounces, walks, talks or is pushed; when you use
generated footage; when reviewing.
Viewers judge weight and timing instantly. Motion that breaks physics reads
as fake even when every frame looks sharp.

## Rules
1. Falling: time = √(2 × height ÷ 9.81). From 0.5 m that is about 0.32 s
   (10 frames at 30 fps), from 1 m 0.45 s (14 frames), from 2 m 0.64 s
   (19 frames). The distance covered grows every frame: never fall at a
   constant speed.
2. Thrown objects follow a parabola: constant horizontal speed, slowest at
   the top. Each bounce is lower and shorter than the one before, then the
   object rests.
3. Bigger things move more slowly: timing grows roughly with the square root
   of size.
4. Inertia: heavy objects start and stop on long eases; light ones react
   quickly and overshoot more. A push has a reaction and a recoil.
5. Contact: nothing passes through anything; feet stay planted while they
   carry weight (no sliding); resting objects have a contact shadow.
6. Squash and stretch keeps volume. Rigid objects (phones, cars, logos)
   never squash; soft ones stay within about 20 % in a realistic style.
7. Hair, cloth and straps lag the body by a few frames, then settle.
8. Walking is about 100-120 steps a minute (a step about every 12 frames at
   24 fps); running 160-180. Arms swing opposite to the legs.
9. Eyes: about 10-20 blinks a minute, each 0.1-0.4 s (3-12 frames at
   30 fps), at uneven intervals; the eyes lead a head turn and always look
   at something.
10. Lip sync: lips close fully on M, B and P; mouth shapes lead the sound by
    one or two frames.
11. Animals: copy the order of their legs from reference footage (the
    Muybridge photographs are in the public domain).
12. One lighting logic per scene: shadows agree in direction and softness
    across shots.
13. Generated footage: keep clips short, with one action and one camera move;
    avoid hands handling objects, liquids, breaking glass and crowds; cut
    away before a failure. Current models still fail physical tests often
    while looking realistic.
14. Sweep every generated clip frame by frame: count fingers, check objects
    stay the same through occlusion, check faces, clothes and logos do not
    drift between shots, look for garbled text on signs, flicker, floating,
    sliding and morphing, and unnatural blinking or skin.

## In RenderWeld
- Compute fall and bounce timings in frames before writing CSS keyframes;
  give each segment its own curve (ease-in on the way down, ease-out on the
  way up), not one linear keyframe list.
- Use `preview_scene` and check the frames around the contact moment.
- Generated clips are assets: record their source and licence, and log the
  artefact sweep in your review notes.

## Signs of a generic, machine-made video
- Floaty, weightless motion; bounces that get higher.
- Skating feet; melting or extra fingers; wobbling logos.
- Shadows that disagree; people who never blink.

## Before you render
- [ ] Fall and arc timings computed, not guessed.
- [ ] Planted frames locked; rigid objects never squash.
- [ ] Artefact sweep done on every generated clip.

## Sources
- NIST, standard acceleration of gravity, 9.80665 m/s² (physics.nist.gov).
- Thomas & Johnston, *The Illusion of Life*; Richard Williams, *The Animator's Survival Kit* (gait and timing).
- Eye-blink rate studies (pubmed.ncbi.nlm.nih.gov/18565090).
- "Do generative video models understand physical principles?" (arxiv.org/abs/2501.09038); VideoPhy (arxiv.org/abs/2406.03520); VBench (arxiv.org/abs/2311.17982).
- OpenAI, "Video generation models as world simulators" (known failures such as shattering glass).
- MIT Media Lab, Detect Fakes (artefact checklist).
