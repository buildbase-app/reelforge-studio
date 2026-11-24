---
title: "Images, video and audio in scenes"
description: "How ReelForge Studio scenes use uploaded assets on every engine: asset ids in template props and asset:<id> in html, fit modes, frame-accurate video, SVG sanitising, the audio bed, limits and which project may use which asset."
folder: "manifest"
slug: "assets"
order: 4
tags: [manifest, reference, assets]
---

# Images, video and audio in scenes

Uploaded files reach every engine: Remotion, Motion Canvas, html and
HyperFrames. A scene names an asset by the `id` it has in the manifest's
`assets`, never by a path or a URL, and a render reads the files from the
server's asset store only. Nothing is downloaded while a render runs.

## 1. Put the file in the project

Upload it with `projectId` and an `assetId`, which adds it to the manifest:

```json
{ "tool": "upload_asset", "projectId": "launch", "assetId": "hero", "filename": "hero.jpg", "dataBase64": "..." }
```

For large files, use `POST /v1/assets` (multipart, with `projectId` and
`assetId`) or `add_asset_from_url` (https only). You can also write the entry
yourself:

```json
"assets": [
  { "id": "hero", "uri": "asset://ast-0123456789abcdef", "mediaType": "image" },
  { "id": "broll", "uri": "asset://ast-89abcdef01234567", "mediaType": "video" },
  { "id": "logo", "uri": "asset://ast-fedcba9876543210", "mediaType": "image" },
  { "id": "bed", "uri": "asset://ast-0011223344556677", "mediaType": "audio" }
]
```

The store accepts these file types. The type is decided from the bytes, not
from the file name:

| Media type | Formats |
| --- | --- |
| image | PNG, JPEG, WebP, GIF, SVG (sanitised, see [Security](#security)) |
| video | MP4, MOV, WebM |
| audio | MP3, WAV, AAC, M4A, OGG, FLAC |
| font | TTF, OTF, WOFF, WOFF2 (stored now; using them in themes comes with #303) |

## 2. Use it in a scene

### Templates: `media` and `logo`

Every built-in template (`kinetic-title`, `animated-explainer`, `html-title`,
`hyperframes-title`) takes two optional props:

```json
"props": {
  "headline": "Launch week starts now",
  "media": { "asset": "broll", "fit": "cover", "focus": { "x": 50, "y": 30 }, "start": 2.5, "dim": 0.45 },
  "logo": { "asset": "logo", "corner": "top-right", "size": 14 }
}
```

| Prop | Meaning |
| --- | --- |
| `media.asset` | An image or video asset, shown behind the text over the whole frame |
| `media.fit` | `cover` (default): fill the frame and crop. `contain`: show all of it, letterboxed. `blur-fill`: contained over a blurred, cropped copy of itself |
| `media.focus` | The point kept in view when `cover` crops, in percent of the media (default `50, 50`) |
| `media.start` | Video only: the in-point, in seconds into the clip, shown at the first frame of the scene |
| `media.dim` | How much of the background colour covers the media so the text stays readable, from 0 to 0.9 (default 0.45) |
| `logo.asset` | An image asset (PNG with transparency or SVG work best) |
| `logo.corner` | `top-left`, `top-right` (default), `bottom-left` or `bottom-right` of the content safe area ([Formats](/docs/manifest/formats)) |
| `logo.size` | Width of the logo's square box in layout units (1 % of the shorter side), from 4 to 40 (default 14). The logo is contained in it and pushed into the corner |

### Your own html: `asset:<id>`

In `html` and `hyperframes` scenes, write `asset:<id>` where a URL goes:

```html
<img src="asset:logo" style="position:absolute;top:40px;right:40px;width:160px">
<video src="asset:broll" data-media-start="2.5" muted playsinline data-start="0"
       style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>
<div style="background:url(asset:hero) center/cover"></div>
```

The renderer replaces each reference with a URL on the render's own local
origin. References work in `src`, `srcset`, `poster`, `style` attributes,
`<style>` and the scene's `css`. For videos, use `<video src="asset:...">` and
add `data-media-start` for an in-point. HyperFrames compositions also need
`data-start` on the video (see the HyperFrames docs).

These are refused when the manifest is saved or validated:

- ids that are not in this manifest's `assets`;
- raw store ids (`asset://ast-...`), paths (`asset:../x`), upper case and query
  strings;
- audio in markup (sound goes in `audio`);
- references inside `<iframe>`, `<object>`, `<embed>`, `<a>`, `<link>` and
  `<script>`, because those elements would open the file as a document.

## 3. Sound: the audio bed

Audio assets are mixed by the media pipeline, not drawn by an engine. Put
music in `audio.music`, a voice-over in `audio.voice` and effects in
`audio.sfx` ([Manifest v0.2: audio](/docs/manifest/v0-2)). The sound inside a
video clip is not used.

## Video is frame-accurate

A video is never played in real time. Before a scene renders, the clip is
turned into the exact picture for each output frame:

- Picture `k` is the clip at `start + k / fps`, from its first frame. FFmpeg's
  `fps` filter samples it on an exact grid, so it is the source frame within
  half a frame of that time.
- Frame rates are exact fractions: 23.976 is 24000/1001 and 29.97 is
  30000/1001. A clip never drifts against the scene, however long it is,
  whatever its rate and the scene's.
- Rotation (phone video) is applied, and variable frame rate clips are
  resampled onto the same grid.
- A clip shorter than the scene holds its last frame.

Remotion, Motion Canvas and the html engine then show picture `k` at frame
`k` as an image. A Remotion frame-range chunk shows the same pictures as the
whole render. HyperFrames seeks `<video>` elements itself, frame by frame. The
tests check the frame numbers burnt into a test clip at 30, 29.97 and 23.976
fps, from in-points and inside frame ranges.

## Security

- **Your project's files only.** A scene can use only the assets listed in its
  own manifest. The renderer copies just the files the scene uses into the
  scene's work folder, under names it makes up, and serves them by exact name.
  Path traversal has nothing to act on. An upload or import made with a
  `projectId` belongs to that project, and another project that lists its
  store id is refused (`asset_not_in_project`). Uploading the same bytes with
  that project's `projectId` adds it to the project too. Uploads made without
  a `projectId` are shared by every project in the workspace, like a brand
  kit. Workspaces never see each other's assets.
- **Checked again at render time.** The bytes are sniffed again and must match
  the manifest's `mediaType`. Sizes are limited: images to 16384 px a side and
  100 megapixels, videos to 8192 px a side and 3 hours. Files whose decoding
  fails, or that start after their end, fail the render with the asset's id.
- **SVG is rewritten** from an allowlist when it is uploaded, and again when it
  is rendered. Drawing elements and attributes stay. These are removed:
  scripts, event handlers, `<foreignObject>`, animation, links (the drawing
  inside is kept), references outside the file, and styles that load
  anything. Engines show SVG only as an image, where browsers run no scripts.
  The asset origin also sends `Content-Security-Policy: script-src 'none'`.
- **Decoded away from the server.** FFmpeg and ffprobe run as child processes
  without the server's secrets and with a time limit. Pictures are decoded by
  the engine's Chromium, which uses its sandbox where it is on (Remotion turns
  it off). In the release container, the container is the outer sandbox.
- **No network.** The html engine answers asset requests itself by request
  interception from an origin that never resolves (`rf-assets.invalid`), with
  no socket. Motion Canvas uses its loopback bundle server under a random
  path. Remotion gets a loopback server for the length of the render.
  HyperFrames reads files from the composition folder, behind its deny-all
  network sink. A test runs a whole four-engine render with assets under
  `strace` and finds no connection outside loopback.

## Limits

| What | Limit |
| --- | --- |
| Upload size | `limits.maxUploadBytes` (see `get_capabilities`) |
| SVG | 2 MB, 50 000 nodes |
| Image | 16384 px a side, 100 MP |
| Video | 8192 px a side, 3 hours |
| Video pictures | Scaled to at most 1.5 times the frame's longer side (room for `cover`), never enlarged |
