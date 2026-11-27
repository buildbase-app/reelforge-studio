---
name: camera-language
title: Camera language
description: Shot sizes, framing, camera moves with speed limits, parallax, motion blur and cutting rules. Use for virtual camera moves (pan, zoom, Ken Burns), for prompts to video generators, and when deciding where to cut.
---
# Camera language

**Use when:** moving a virtual camera, panning or zooming an image or clip,
writing a prompt for a video generator, or editing cuts.

## Rules
1. Name each shot: extreme wide, wide, medium, medium close-up, close-up,
   extreme close-up. Plan the sequence of sizes; avoid two near-identical
   framings in a row.
2. Between two shots of the same subject, change the angle by at least 30°
   or the shot size clearly; otherwise the cut looks like a jump.
3. Keep the camera on one side of the line of action, so movement and gaze
   keep the same screen direction.
4. Composition: rule of thirds or a deliberate centre; eyes on the upper
   third in close shots; leave room in the direction of gaze or movement.
5. One camera move per shot. Combining push, pan, tilt and zoom at once
   looks unstable, and video generators handle it poorly.
6. Pan speed: at 24 fps with a 180° shutter, an object should take at least
   about 7 seconds to cross the frame at the move's fastest point, or it
   judders; higher frame rates judder less. Whip pans are the deliberate
   exception.
7. Motion blur follows the 180° shutter: exposure is 1 ÷ (2 × fps), so
   1/48 s at 24 fps and 1/60 s at 30 fps. Synthetic blur is about half the
   distance moved in one frame.
8. Push-ins and pan-and-zoom on stills: ease in and out, with a reason for
   the start and end framing; scale change of 20 % or less per 5 s; never
   zoom past the image's native resolution.
9. Parallax: two or three layers, speed in proportion to depth, never on
   text.
10. Avoid motion that causes discomfort: constant rotation, large fast
    full-frame movement, shake on graphics. Non-essential motion is an
    accessibility concern (WCAG 2.3.3).
11. Cut on action, in the middle of a movement, with matching direction and
    speed; keep the next point of interest near the last one.
12. Hard cuts by default. A dissolve says time has passed; do not crossfade
    between unrelated scenes.

## In RenderWeld
- Scenes play back to back with hard cuts; motivated transitions inside a
  scene are your own HTML/CSS.
- A camera move on an image or clip in an html scene: animate `transform`
  (translate and scale) of the media element with an ease-in-out curve over
  the scene; keep the scale change within rule 8.
- When prompting a generative video provider, write one shot size, one angle
  and one move with its speed per clip.

## Signs of a generic, machine-made video
- A slow push on every shot; drone-style orbits on everything.
- Random tilted angles; whip pans between every scene.
- Jump cuts between near-identical framings; zooming into static UI.

## Before you render
- [ ] A shot list with size, angle, move and speed for each shot.
- [ ] Screen direction consistent; pan speeds within the limit.
- [ ] Frames just before and after each cut checked.

## Sources
- Christopher J. Bowen, *Grammar of the Edit* and *Grammar of the Shot* (30-degree and 180-degree rules).
- RED, camera panning speed and shutter angle guides (red.com/red-101).
- Walter Murch, *In the Blink of an Eye* (cutting priorities).
- W3C WCAG 2.2, 2.3.3 Animation from Interactions.
