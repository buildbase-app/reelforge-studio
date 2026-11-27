---
name: brand-consistency
title: Brand consistency
description: Logo rules, colour tokens, type, motion and sound kept identical across scenes, sizes and a series. Use for any branded video, template or series.
---
# Brand consistency

**Use when:** the video belongs to a brand, or is part of a series.

## Rules
1. Collect the brand kit before designing: logo files (light, dark and
   single-colour; vector where possible), clear space and minimum size,
   colours with approved text-on-background pairs, fonts licensed for video,
   motion style, sound logo, tone of voice and anything banned.
2. Never stretch, rotate, recolour or add effects to a logo, and never
   animate it unless the kit supplies an animated version or motion rules.
   A logo the kit lets move is a rigid object: it never squashes
   (`physical-plausibility`).
3. Respect the kit's clear space (often a letter height or half the logo's
   height) and minimum size.
4. The logo keeps the same corner and size in every scene and every size,
   inside the safe area. An end card with logo and call to action holds at
   least 2 s.
5. In ads, show the brand early (within about 5 s), but do not open with a
   logo sting before the subject.
6. Colours come only from the kit's tokens: neutral backgrounds, one accent,
   every text colour checked for contrast against its background.
7. One motion style (fast and subtle, or expressive) with a fixed set of
   durations and curves; the same transition family across a series.
8. One music family, one sound logo and one voice per language for a series.
9. Images keep one grade, one lighting logic and one illustration style.
10. Build reusable scenes from the kit's values; never hard-code a colour or
    font that should come from the brand. Version the kit.

## In RenderWeld
- A theme is the brand kit in the renderer: `create_theme` with
  `colors` (background, surface, text, mutedText, accent, accent2),
  `fontFamily`, `headingWeight`, `motionSpeed` and caption style; apply it
  with `set_theme`. Templates and html scenes read the same tokens
  (`--rf-bg`, `--rf-text`, `--rf-muted`, `--rf-accent`, `--rf-font`,
  `--rf-heading-weight`, `--rf-speed`).
- Fonts: upload the font files as assets and name the family in the theme;
  they render offline in every engine and in burned captions.
- Logos: upload as assets (vector SVG is stored sanitised) and place them in
  the same pane or corner in every scene.
- Every size is a `variant` of the same project, so the brand stays identical
  across sizes.

## Signs of a generic, machine-made video
- Purple-to-blue gradients, glass blobs, neon glows.
- A pulsing or spinning logo; colours that are not in the kit.
- Stock footage of people high-fiving.

## Before you render
- [ ] Logo clear space and size checked; same position in every scene.
- [ ] Only theme colours used; contrast checked.
- [ ] Motion and sound consistent with the rest of the series.

## Sources
- W3C WCAG 2.2, 1.4.3 contrast.
- IBM Carbon motion: productive and expressive motion (carbondesignsystem.com).
- Google ad creative guidance on early branding (support.google.com/google-ads/answer/14783551).
