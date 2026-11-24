---
title: "Fonts"
description: "Custom and bundled fonts in ReelForge Studio: upload a TTF, OTF, WOFF or WOFF2 file, name its family in the theme, and every engine renders with it offline. The bundled OFL font set, the fallback chain and how font loading is made deterministic."
folder: "manifest"
slug: "fonts"
order: 5
tags: [manifest, reference, fonts, assets]
---

# Fonts

Every engine (Remotion, Motion Canvas, html and HyperFrames) renders text in
the fonts your theme names, from your project's font files or from the fonts
bundled with ReelForge. Fonts never come from the network: the Google Fonts
fetches some tools make are blocked (#318, D-111).

## Use your own font

1. Upload the file to the project. The file types are TTF, OTF, WOFF and
   WOFF2; variable fonts work too.

   ```json
   { "tool": "upload_asset", "projectId": "launch", "assetId": "brand-sans", "filename": "BrandSans.woff2", "dataBase64": "..." }
   ```

   The upload is refused if the file is not a font that parses. The answer
   (and `get_asset`) shows what was read from the file in `metadata.font`: the
   family name, style, weight, variation axes and the licence note stored in
   the font:

   ```json
   "metadata": { "font": { "family": "Brand Sans", "subfamily": "Regular", "weight": 400, "italic": false,
     "axes": [{ "tag": "wght", "min": 100, "default": 400, "max": 900 }], "format": "woff2",
     "licenceUrl": "https://openfontlicense.org" } }
   ```

2. Name that family in the theme:

   ```json
   "theme": { "base": "default", "tokens": { "fontFamily": "\"Brand Sans\", Inter, sans-serif" } }
   ```

That's all. Each project font asset is registered under the family name
inside the file, with its own weight and style. For a family with several
files (Regular, Bold, Italic), upload each one; the engines pick the face that
matches the weight and style the template uses. A variable font covers its
whole weight (and width) range. Html and HyperFrames scenes can also name the
family in their own CSS (`font-family: "Brand Sans"`).

Family names are used with the characters theme tokens allow: letters,
digits, spaces, `-`, `_` and `.`. Other characters are dropped from the
registered name (`metadata.font.family`; the name as written in the file is
`familyInFile`).

## Bundled fonts

These fonts ship with ReelForge. Themes that name them render the same on
every machine, whatever is installed:

| Family | Style | Files | Licence |
| --- | --- | --- | --- |
| Inter | Sans serif, variable weight 100-900, roman and italic | `@fontsource-variable/inter` 5.3.0 | SIL Open Font License 1.1. Copyright 2016 The Inter Project Authors |
| Source Serif 4 | Serif, variable weight 200-900, roman and italic | `@fontsource-variable/source-serif-4` 5.3.1 | SIL Open Font License 1.1. © 2014-2021 Adobe Systems Incorporated, Reserved Font Name "Source" |
| JetBrains Mono | Monospace, variable weight 100-800, roman and italic | `@fontsource-variable/jetbrains-mono` 5.3.0 | SIL Open Font License 1.1. Copyright 2020 The JetBrains Mono Project Authors |

Each covers Latin, Latin Extended, Cyrillic, Greek and Vietnamese (the
packages' subsets; only the subsets a text needs are loaded). The built-in
`default` theme names Inter first, so it now renders with the bundled Inter.
The `midnight` theme names "Avenir Next", which cannot be bundled, so it falls
back as described below.

## Fallback chain

For each character, a font is chosen in this order:

1. **Project fonts:** the project's font assets, by the family name inside the
   file, if the theme or the scene names that family.
2. **Bundled fonts:** Inter, Source Serif 4 and JetBrains Mono, if named. A
   project font of the same family replaces the bundled one.
3. **Installed fonts:** the fonts installed in the image (DejaVu, Liberation,
   Noto core and emoji in the release image), found by fontconfig. Common
   names map to them: Arial and Helvetica to Liberation Sans, for example.
4. **The generic family** at the end of the list (`sans-serif`, `serif`,
   `monospace`).

Always end a `fontFamily` list with a generic family.

## Deterministic loading

No frame is captured before the fonts it uses have loaded:

- **html:** the faces are `@font-face` rules with `font-display: block`. The
  renderer lays out the page and waits for `document.fonts.ready`. A face that
  fails to load fails the render with its name. There is a time limit of 15 s,
  shorter than any scene timeout.
- **Remotion:** the faces are added with the FontFace API and the composition
  renders nothing until all of them have loaded (`delayRender`). The headline
  is measured for fit-to-box in the right font. A failed face cancels the
  render with its name.
- **Motion Canvas:** the faces load before the renderer starts, because canvas
  text uses only fonts that have loaded. A failure fails the render.
- **HyperFrames:** `@font-face` rules point at files in the composition folder,
  and HyperFrames waits for `document.fonts.ready` before capturing. Fonts are
  checked when they are staged: a file that does not parse fails the render
  before HyperFrames starts.

Only the families a scene names are staged and declared, not every font of
the project. For the canvas engines, every face of a named family is loaded;
variable files cover all weights in one file.

## Not yet

- No CJK, Arabic, Hebrew or Devanagari fonts are bundled. Upload a font for
  those scripts; the image's Noto core fonts cover some of them.
- Burned-in captions (libass) use the installed fonts, not project fonts.
- Font collections (`.ttc`) are refused.
- Missing glyphs are not reported yet: a character that no font in the chain
  has shows as a fallback glyph or a box.
