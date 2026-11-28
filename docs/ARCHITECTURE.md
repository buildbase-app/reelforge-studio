# Proposed Architecture

**Status (2026-11-23): superseded; kept for its reasoning.** This was the
proposal written before the build. The implemented architecture is the agent
platform in [AGENT_PLATFORM.md](AGENT_PLATFORM.md) (D-014): a self-hosted
server offering REST `/v1` and MCP `/mcp` over one service, where the agent
plans the scenes and the server validates, renders with four engine plugins
(Remotion, Motion Canvas, HTML, HyperFrames), assembles with FFmpeg and checks
the output; no built-in planner and no web UI in v0.1. Where things stand:
the STATUS table of [AGENT_PLATFORM.md](AGENT_PLATFORM.md). Code layout: AGENTS.md, "Working in this repo".

## 1. High-level flow

``` text
Web UI / Local UI
      |
Project API + Validation
      |
Canonical Project Manifest (versioned JSON)
      |
Planner / Agent Orchestrator ---- Optional external CLI agent adapters
      |                           (supported auth and explicit permissions)
      |
Scene Planner
   /          \
Remotion      Motion Canvas
Adapter       Adapter
   \          /
Rendered scene/video artifacts
      |
Media Assembly Pipeline (FFmpeg or compatible system)
      |
Validation (ffprobe + frame/audio checks)
      |
Preview + MP4 export + project bundle
```

## 2. Major modules

### UI

-   Create/edit brief.
-   Project settings: aspect ratio, dimensions, frame rate, target
    duration, language, brand settings.
-   Storyboard preview and approval.
-   Render queue/progress, cancel/retry, logs, output folder.
-   Provider/settings panel that clearly shows local versus external
    services and possible costs.

### Project service

-   Validates schema and asset references.
-   Saves project manifest and version.
-   Maintains project state and render job state.
-   Never stores provider secrets in project files.

### Planner / agent layer

Agent roles may include: - Creative Director: brief interpretation,
audience, hook, pacing, tone. - Scriptwriter: script, narration,
on-screen copy, captions. - Storyboard Planner: scene breakdown,
durations, transitions, asset needs. - Motion Designer: chooses/creates
reusable animation components. - Sound Designer: voice/music/SFX plan
and synchronization. - Quality Reviewer: checks consistency,
readability, timing, safe margins, and delivery requirements.

These roles can be prompt/skill profiles; do not assume they require
separate models or concurrent agents. Begin with a small number of
reliable steps.

### Engine adapters

**Remotion adapter** - Owns React-based composition templates and
Remotion-specific props. - Renders scenes or compositions to
deterministic video artifacts. - Captures package version, render
settings, logs, and exit status.

**Motion Canvas adapter** - Owns TypeScript/generator-based motion
scenes. - Renders designated scenes/visualizations. - Captures project
settings, output, logs, and exit status.

Both engines are required. Assign scenes by template capability and
tested output needs, not by an unverified claim that one engine is
universally better.

### Media assembly

-   Normalize scene dimensions, frame rate, pixel format, time base, and
    audio policy.
-   Join clips and mix audio.
-   Apply captions if they are not already rendered into scenes.
-   Produce MP4 with configurable encoding settings.
-   Use a manifest to record exact inputs and output settings.
-   Detect missing media and fail clearly instead of silently producing
    a broken video.

### Asset library

-   Asset metadata: unique ID, path/URI, media type, source, author,
    license, attribution, allowed uses, redistribution status, checksum.
-   Distinguish bundled assets from user-provided assets and fetched
    assets.
-   Do not bundle unlicensed music, fonts, video, sound effects, or
    models.
-   Provide placeholder/sample assets that are safe to redistribute only
    after verification.

### Local job runner

-   Queues render jobs and tracks progress.
-   Supports cancellation and retries.
-   Uses bounded concurrency to avoid exhausting RAM/CPU/GPU.
-   Stores logs and job outputs locally.
-   Makes no hidden network calls.

## 3. Suggested repository structure

Adapt to an existing repository rather than forcing a restructure.

``` text
reelforge-studio/
├── AGENTS.md
├── README.md
├── docs/
│   ├── PRODUCT_BRIEF.md
│   ├── DECISIONS.md
│   ├── ARCHITECTURE.md
│   ├── REQUIREMENTS.md
│   ├── TEST_PLAN.md
│   └── ROADMAP.md
├── research/
│   ├── RESEARCH_FINDINGS.md
│   └── SOURCES.md
├── apps/
│   └── web/                    # local-first UI
├── packages/
│   ├── project-schema/          # canonical versioned schema
│   ├── planner/                 # plan validation and scene planning
│   ├── engine-remotion/         # Remotion scenes and adapter
│   ├── engine-motion-canvas/    # Motion Canvas scenes and adapter
│   ├── media-pipeline/          # assembly and media validation
│   ├── asset-registry/          # metadata and license tracking
│   └── agent-adapters/          # supported external/local agent adapters
├── templates/
│   ├── kinetic-typography/
│   ├── product-showcase/
│   └── educational-explainer/
├── examples/
├── tests/
├── deployment/
│   ├── docker/
│   └── scripts/
└── LICENSES/
```

## 4. Canonical project manifest --- illustrative shape

This is a starting concept, not a finalized schema:

``` json
{
  "schemaVersion": "0.1",
  "projectId": "example-project",
  "title": "Example Reel",
  "output": {
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "format": "mp4"
  },
  "audio": {
    "voiceTrack": null,
    "musicTrack": null,
    "soundEffects": []
  },
  "scenes": [
    {
      "id": "scene-001",
      "engine": "remotion",
      "template": "kinetic-title",
      "startFrame": 0,
      "durationFrames": 90,
      "props": {
        "headline": "A clear hook"
      },
      "assets": []
    },
    {
      "id": "scene-002",
      "engine": "motion-canvas",
      "template": "animated-explainer",
      "startFrame": 90,
      "durationFrames": 120,
      "props": {},
      "assets": []
    }
  ]
}
```

The real schema must validate timing, engine-specific props, asset IDs,
frame-rate assumptions, text limits, transitions, audio overlaps, and
schema migrations. Use a formal validator such as Zod or JSON Schema,
chosen consistently with the codebase.

## 5. Rendering boundary: critical spike

Do not assume seamless engine interoperation. First prove: 1. Remotion
renders a 3-second vertical scene. 2. Motion Canvas renders a 3-second
vertical scene. 3. Both outputs can be normalized to compatible media
parameters. 4. FFmpeg assembles them in correct order. 5. Audio does not
drift; scene durations and frame boundaries are exact. 6. A fresh
machine can repeat the render. 7. License requirements are compatible
with the intended distribution model.

If alpha-channel overlays are required, test them explicitly. Do not
assume the default outputs preserve transparency.

## 6. Security and privacy

-   Keep credentials in OS environment/secret storage, not JSON
    manifests.
-   Do not transmit project media without explicit consent.
-   Do not execute arbitrary generated shell commands without user
    approval and isolation.
-   Restrict file access to project/work directories.
-   Sanitize filenames and reject path traversal.
-   Treat imported agent plans and external assets as untrusted input.
-   Document all network egress and make provider usage visible.
-   Never commit auth caches or `.env` secrets.
