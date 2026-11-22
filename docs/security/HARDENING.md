# Security hardening: defaults and how to configure them

This page lists the security-relevant defaults of ReelForge Studio and the
settings that change them. The changes in this version come from a private
security review (findings SEC-01 to SEC-20; details are not published). The
decisions are D-085 to D-089 in [DECISIONS.md](../DECISIONS.md). To report a
problem, follow [SECURITY.md](../../SECURITY.md).

## Agent-supplied scenes (html, hyperframes)

Agents can send their own HTML for `html` and `hyperframes` scenes. ReelForge
treats that markup as untrusted.

| Layer | Default | Setting |
| --- | --- | --- |
| Markup parsing | Scene markup is parsed with a standards-compliant HTML parser (parse5), never edited with regular expressions. ReelForge's head, with a Content-Security-Policy, is inserted as the first child of the parsed `<head>`. The result is parsed again to check that this policy comes first and is the only one. | always on |
| Policy elements | Markup with `<meta http-equiv>` (a CSP, a refresh) or `<base>` is refused (the render fails with an error naming the element), also inside `<template>` and `iframe srcdoc`. Comments, `<noscript>`, `<noembed>`, `<noframes>` and attributes with unusual names are dropped. | always on |
| External scripts | `<script src>` with a scheme or `//` is refused. Inline the code instead. | always on |
| Outbound network (hyperframes) | All outbound connections are refused outside the page: HyperFrames' restricted network mode routes the browser and the renderer's own downloads through a local proxy whose upstream refuses everything. QUIC is off and WebRTC may only use proxied connections (so no UDP). WebRTC constructors are also removed from the page. | always on |
| Outbound network (html) | The browser context is offline, every request is aborted, page scripts are blocked by the CSP, and WebRTC is limited to proxied connections. | always on |
| Network attempts | A hyperframes scene that tries to reach the network (navigating away, or a remote image or font the renderer would download) fails the render at once with `the scene tried to reach the network (...)`. An html scene that navigates away from its document fails the same way. Put files in the project's assets and reference them locally. | always on |
| Time limit | Each html or hyperframes scene has a hard time limit: the engine's per-frame estimate, never more than `render.sceneTimeoutSeconds`. | `REELFORGE_RENDER_SCENE_TIMEOUT_SECONDS`, default `900`, allowed `30` to `3600` |

What changes for agents: a scene that pointed at remote images, fonts or
stylesheets used to render silently without them. Now the render fails and the
error says what to do.

## Chromium's own sandbox

| | Default | Setting |
| --- | --- | --- |
| html, hyperframes, motion-canvas | Chromium's sandbox is **on**, the release image included | `REELFORGE_CHROMIUM_NO_SANDBOX=1` turns it off (explicit opt-out) |
| remotion | always off: `@remotion/renderer` hard-codes `--no-sandbox` on Linux. Remotion renders only ReelForge's built-in templates (agents send props, not code) | none |

In Docker the sandbox needs user namespaces. Docker's default seccomp profile
blocks them, so run the image with the profile shipped in this repository:

```bash
docker run ... --security-opt seccomp=deployment/seccomp/chrome.json reelforge-studio
```

`docker-compose.yml` and the Kubernetes example in
[DEPLOY.md](../DEPLOY.md#hardening) do this. Without the profile, html,
hyperframes and motion-canvas renders fail with a message that names it.

The opt-out `REELFORGE_CHROMIUM_NO_SANDBOX=1` is for hosts that cannot allow
user namespaces. When it is set:

- the server logs a warning at start;
- `get_capabilities` (`security.warning`) and the admin view of `/readyz`
  (`security.warnings`) report it;
- agent-supplied scenes then run in a browser with the server's privileges.
  The container (non-root, read-only, no capabilities) is the only boundary.

## Secrets and render processes

Render child processes never get the server's secrets.

- Engines that start a process (the html and Motion Canvas browsers, the
  HyperFrames CLI and its browser) pass an allowlisted environment: `PATH`,
  `HOME`, locale, time zone, temp directories, fonts and the tool paths. A
  database URL, `REELFORGE_SECRET_KEY`, provider keys, the licence key, storage
  credentials or cloud SDK credentials are never passed.
- At start the server reads its configuration from a copy of the environment,
  then removes every ReelForge secret variable (with its aliases and `_FILE`
  form) from its own process environment. Libraries that spawn processes with
  the server's environment (Remotion's browser, FFmpeg) therefore do not see
  them.
- Limit: a process running as the same user without a sandbox could still read
  the server's memory. That is why the sandbox is on by default.

## Operational endpoints

| Endpoint | Default | Setting |
| --- | --- | --- |
| `GET /metrics` | needs `Authorization: Bearer <observability.metrics.bearerToken>`. Without a configured token it answers `401` | `REELFORGE_METRICS_TOKEN` (or `_FILE`). `REELFORGE_METRICS_ALLOW_ANONYMOUS=true` serves it without a token, for a scraper on a private network |
| `GET /readyz` | anonymous callers and non-admin keys get only `ok`, `checks` (`ok` / `error`), each dependency's `status` and `required`, and each engine's `ok`. An admin API key (`Authorization: Bearer rf_...`) gets the full report: paths, versions, free space, error text and the Chromium sandbox per engine | none; probes only need the status code |
| `/mcp` `Origin` | when a browser sends `Origin`, its scheme, host and port must match the public URL's origin or the host the request was sent to | `REELFORGE_PUBLIC_URL`, `REELFORGE_ALLOWED_HOSTS` |

Prometheus scrape configuration:

```yaml
scrape_configs:
  - job_name: reelforge
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/reelforge-metrics-token
    static_configs:
      - targets: ['reelforge:4321']
```

## Keys, imports and logs

| | Default |
| --- | --- |
| `REELFORGE_BOOTSTRAP_KEY` | at least 32 random URL-safe characters after `rf_` (`rf_$(openssl rand -hex 24)`). Values that are short, repetitive or low in entropy stop the server at start with an error naming the setting. API keys made by the server are 32 random bytes |
| URL imports (`import_asset`) | HTTPS only. The address that is connected to is checked: private, loopback, link-local, CGNAT, multicast and documentation ranges, and the IPv6 transition ranges (IPv4-compatible `::/96`, IPv4-mapped, SIIT, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4 `2002::/16`, Teredo and other `2001::/23` assignments, site-local `fec0::/10`) are refused, also after each redirect |
| Stored asset `source` | scheme, host and path of the import URL only. User names, passwords, the query string (where presigned URLs carry signatures) and the fragment are dropped |
| Logs | besides secret settings and API keys, signature parameters are redacted: `X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`, `X-Goog-Signature`, `X-Goog-Credential`, Azure SAS `sig`, `se`, `sv`, `sp`, `st`, and any parameter whose name contains `signature`, `sig`, `token`, `key`, `credential`, `password` or `secret` |

## Licence enforcement: what is and is not protected

ReelForge is self-hosted and source-available, so it cannot fully stop its own
operator from bypassing the licence check: whoever runs it can change the
code. The aim is that a bypass needs a code change (which plainly breaks the
licence terms), not a database edit or a configuration line.

- **Release images fail closed.** The release image marks its code as a
  release build in the same image layer that writes `build-info.json`. If that
  file is missing or describes a dev build, the server refuses to start; it
  never falls back to the dev edition.
- **The stored licence state is sealed.** The last licence answer, its times
  and the instance id are stored with an HMAC. Its key is derived from
  `REELFORGE_SECRET_KEY` and the instance id (a fixed label when no secret key
  is set). A state changed outside ReelForge is not trusted: renders need a
  successful online check again (`reason: state_untrusted`). This also happens
  once after upgrading to this version, and after `REELFORGE_SECRET_KEY`
  changes.
- **Clock rollback.** The highest clock time seen is recorded, and the licence
  server's own time (its HTTP `Date` header) is stored with each answer. A
  system clock more than 10 minutes behind either gets no offline grace
  (`reason: clock_skew`) until the clock is right or a check succeeds.
- **Not covered:** someone who patches the code, builds their own image, knows
  `REELFORGE_SECRET_KEY` and writes a valid seal, or runs a fake licence server
  with their own CA. BuildBase's answers are not signed yet (see
  docs/research/BUILDBASE_SIGNED_LICENCE_REQUEST.md). The licence terms are the
  real protection.

## Tests

Unit and integration tests are named `SECT-xx` (`security` in the test name):

| Id | Where | What |
| --- | --- | --- |
| SECT-01..04 | `packages/core/test/security.test.ts` | markup parsing: the CSP stays first in `<head>` against comment, title, attribute, noscript and case tricks; policy elements refused; normalisation |
| SECT-05 | same | SSRF guard, table of IPv4/IPv6 ranges |
| SECT-06 | same | stored asset `source` without credentials or query |
| SECT-07..08 | same | a spawned render process sees no secret; the process environment is scrubbed |
| SECT-09 | same | bootstrap key strength (config and key store) |
| SECT-10 | same | per-scene time limit, clamped |
| SECT-11 | same | release image without, or with a dev, `build-info.json` refuses to start |
| SECT-12..15 | same | sealed licence state (edited row rejected, other secret key rejected), licence server time and clock rollback, Date header recorded |
| SECT-20..25 | `apps/server/test/security.test.ts` | `/metrics` needs a token; minimal anonymous `/readyz`, full for admins; `/mcp` Origin with scheme and port; presigned URL redaction |
| SECT-30..37 | `packages/engine-hyperframes/test/hyperframes.test.ts` | CSP placement and refusals; CLI environment; deny-all sink; with a browser: no request or UDP packet reaches a local canary from a document, navigation, WebRTC or a remote asset; navigation fails fast |
| SECT-40 | `packages/engine-html/test/html.test.ts` | html scenes: policy elements refused, CSP first in `<head>` |

The Docker end-to-end test (`e2e/docker/run.sh`, `e2e/docker/security.mjs`)
checks the release image with its hardened flags: Chromium's sandbox active by
default, scene network attempts blocked or failing the render, a minimal
anonymous `/readyz`, `/metrics` needing its token, and a release image with a
dev `build-info.json` refusing to start.
