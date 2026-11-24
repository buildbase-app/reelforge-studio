---
title: "Web dashboard"
description: "Turn on the dashboard that ReelForge Studio serves at /dashboard: sign in with an API key, watch render jobs live, cancel and retry them, and browse every project and render with its player, checks and download."
folder: install
slug: dashboard
order: 5
tags: [install, dashboard, security]
---

# Web dashboard

ReelForge Studio can serve a small web dashboard from the same server and the
same Docker image. It runs on your machine, like the rest of the studio, and
it uses the same REST API as your agents, with an API key you choose.

![The jobs page of the dashboard, light theme](../../proofs/dashboard/jobs-desktop-light.png)

What it shows today:

| Page | What you see | What you can do |
| --- | --- | --- |
| **Jobs** | The newest 50 jobs: status, progress with the current scene and frame, project, age and run time; counts of running, queued, failed and succeeded | Open a job |
| **Job** | Live progress over the job's event stream, queue position, attempts, worker, the error of a failed job, each fan-out unit with its scene and progress, the log | **Cancel** a queued or running job, **retry** a failed or cancelled one (keys with the `render` scope) |
| **Library** | Every project with its scene count and length; the renders and previews of a project with their poster and format | Open a render |
| **Render** | The player, size, frame rate, length, render time, quality checks, scenes with engine, template and time, versions, files, storage driver and path | **Download** the MP4 (signed link) and the render manifest |

Analytics, the settings view and the audit log viewer are planned (#292).

## Turn it on

The dashboard is **off by default**. Turn it on with any of these (see the
[configuration reference](../../CONFIG.md#dashboard)):

```bash
# environment
docker run ... -e REELFORGE_DASHBOARD_ENABLED=true reelforge-studio

# config file (REELFORGE_CONFIG)
dashboard:
  enabled: true

# at runtime, no restart (admin key)
curl -X PATCH https://studio.example.com/v1/config \
  -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"settings": {"dashboard.enabled": true}}'
```

Then open `https://<your studio>/dashboard`. While it is off, every
`/dashboard` path answers `404`.

The dashboard answers only on the studio's own host names, the same check as
`/mcp`: `localhost`, the host of `REELFORGE_PUBLIC_URL`, and
`REELFORGE_ALLOWED_HOSTS`. If you reach the studio by another name, set one of
those, or you get `403 forbidden_host`.

## Sign in

Sign in with an API key. Give the dashboard its own key, with only the scopes
the people using it need:

```bash
reelforge keys create --name dashboard --scopes read          # watch jobs, browse and download
reelforge keys create --name dashboard-ops --scopes read,render   # also cancel and retry
```

| Key scopes | Jobs and library | Cancel and retry |
| --- | --- | --- |
| `read` | yes | no (buttons disabled; the server refuses them too) |
| `read`, `render` | yes | yes |
| `admin` | yes | yes, and the render page also shows the bucket or folder |

The key stays in the browser tab. By default it is kept in memory only, so a
reload asks for it again; tick **Keep me signed in until this tab closes** to
keep it in the tab's `sessionStorage`. It is never put in a cookie or a URL,
and it is sent only to the studio, in the `Authorization` header. Every call
the page makes goes through the normal key checks: scopes, expiry, IP
allowlist, rate limit and the audit log. A key that is revoked or expires signs
the page out.

## Security

- **Same origin, no third party.** The page, its script and stylesheet are
  served by the studio. It loads no fonts, scripts or images from anywhere
  else and makes no request to another host.
- **Strict Content-Security-Policy** on every dashboard response:
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; manifest-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
  No inline script or style. Also `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`.
- **No session of its own.** There is no login cookie and no server-side
  session; the API key is the only credential.
- **Only the public API.** The dashboard has no private endpoint. What it can
  read, any client with the same key can read.
- **Not on workers.** Instances with `server.role` `worker` never serve it.

Put the studio behind TLS (a reverse proxy) before you open it to a network:
the key travels in a header on every request.

## Live updates

The jobs list refreshes every 3 seconds while the tab is visible. A job's page
follows the job's event stream (`GET /v1/jobs/:id/events`) for progress and log
lines, and refreshes its fan-out units every 3 seconds while it runs. One open
page makes about 20 requests a minute, which counts towards the key's rate
limit (`limits.rateLimitPerMinute`, 300 by default).

## API used

Everything the dashboard shows comes from these endpoints
([REST reference](../api/endpoints.md)):

| Endpoint | Used for |
| --- | --- |
| `GET /v1/me` | Check the key at sign-in; its name and scopes |
| `GET /v1/jobs`, `GET /v1/jobs?parentId=` | The jobs list; fan-out units |
| `GET /v1/jobs/:id`, `GET /v1/jobs/:id/events`, `GET /v1/jobs/:id/logs` | One job, live |
| `POST /v1/jobs/:id/cancel`, `POST /v1/jobs/:id/retry` | Cancel and retry |
| `GET /v1/projects`, `GET /v1/projects/:id/renders` | The library |
| `GET /v1/renders/:id`, `GET /v1/renders/:id/output` | A render, its poster, video and manifest |
| `GET /v1/storage` | The bucket or folder, for admin keys |

`GET /v1/me` (MCP `get_me`) and the `storage` field of a render (`driver` and
the render's `prefix` in storage) were added for the dashboard; both work for
any client.

## Build from source

The Docker image builds the dashboard for you. From a checkout:

```bash
pnpm --filter @reelforge/dashboard build   # writes apps/dashboard/dist
REELFORGE_DASHBOARD_ENABLED=true pnpm dev
```

The build fails if the JavaScript and CSS together are over 150 KB gzipped.

## Screenshots

Light and dark, desktop (1440 px) and phone (390 px):
[docs/proofs/dashboard](https://github.com/buildbase-app/reelforge-studio/tree/main/docs/proofs/dashboard).
