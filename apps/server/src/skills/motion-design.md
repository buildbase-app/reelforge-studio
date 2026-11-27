---
name: motion-design
title: Motion design
description: Easing, durations in frames, staggering, springs and holds, so animation reads as designed rather than default. Use when animating text, shapes, UI or whole scenes.
---
# Motion design

**Use when:** animating anything: text, shapes, UI, images or scene entrances.

## Rules
1. Apply the classic principles of animation: slow in and slow out, arcs,
   anticipation, follow-through and overlap, staging, and exaggeration used
   sparingly.
2. Never move things with linear timing, except rotation, progress bars or a
   deliberate constant speed.
3. Ease by role: entrances decelerate (cubic-bezier(0, 0, 0.2, 1)); exits
   accelerate (cubic-bezier(0.4, 0, 1, 1)); moves within the frame use a
   standard curve (cubic-bezier(0.4, 0, 0.2, 1)); camera moves ease in and out.
4. Durations, at 30 fps: small UI changes 6-8 frames (200-270 ms); text and
   object entrances 9-18 frames (0.3-0.6 s); large moves up to 21 frames
   (0.7 s). Over 0.4 s feels slow for small elements.
5. Exits are 40-50 % shorter than entrances.
6. Stagger related items so the next starts while the previous one is
   still moving, never after it has finished: list items 40-80 ms apart
   (one to three frames at 30 fps), words 60-120 ms, letters one frame.
7. Springs: think in damping ratio. 1.0 never overshoots; 0.7-0.85 feels
   premium; 0.4-0.6 playful; below 0.3 cartoonish. Position and scale may
   overshoot; opacity and colour never do.
8. Anticipation: 2-4 frames of counter-movement before a big move.
   Follow-through: parts settle 2-6 frames after the main body stops.
9. When something has arrived, it holds dead still. No drifting, breathing
   or pulsing to fill time.
10. One focal motion at a time. If a scene feels busy, remove about a third
    of the motion.
11. Use a small set of motion tokens per brand (about three durations and
    three curves) and keep them across the video.
12. Vary entrances between scenes. Between scenes, cut (`camera-language`);
    a transition is the exception, from one family (`brand-consistency`
    rule 7) and motivated by something on screen.

## In RenderWeld
- html and hyperframes scenes: CSS animations and the Web Animations API are
  seeked frame by frame, so timing is exact; write durations as CSS times
  computed from frames (frames ÷ fps). `--rf-speed` is the theme's speed
  multiplier (`motionSpeed`); multiply durations by it if you honour it.
- Built-in templates have their own timing; change their pace with the
  theme's `motionSpeed`, not by stretching the scene.
- Look at the motion before the final render: `preview_scene` renders one
  scene at low resolution.

## Signs of a generic, machine-made video
- Every element fades in and slides up the same way.
- Elastic bounce on interface elements; typewriter effect on every line.
- Titles that keep floating after they land; everything starting at once.

## Before you render
- [ ] No linear tweens on position, scale or opacity.
- [ ] Exits shorter than entrances; landed elements hold still.
- [ ] A preview of the busiest scene checked frame by frame around its main move.

## Sources
- Thomas & Johnston, *The Illusion of Life* (1981): the twelve principles.
- Material Design motion: duration and easing (m1.material.io/motion/duration-easing.html).
- IBM Carbon motion guidelines and tokens (carbondesignsystem.com/elements/motion/overview).
