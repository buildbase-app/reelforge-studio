---
title: "Licence key"
description: "How RenderWeld activates with your BuildBase licence key: what is sent, the daily check, 14 days offline, moving servers, and what happens without a key."
folder: install
slug: licence
order: 2
tags: [install, licence]
---

# Licence key

RenderWeld is **source-available**: the code is public to read, and the licence
decides how you may use it.

| You want to... | You need |
| --- | --- |
| Run it for yourself as a hobby, for study, research or evaluation | A free **Personal** key (PolyForm Noncommercial 1.0.0) |
| Make videos for anything that earns money: a monetised channel, client work, ads, a business | A **Commercial** licence (one-time, per seat or server) |
| Resell, rebrand or offer RenderWeld as a hosted service | Not permitted under either licence |

Both keys come from <https://renderweld.com/pricing> and are delivered
through BuildBase. Remotion, one of the four engines, is not covered by either
RenderWeld licence: companies of more than three people need their own Remotion
licence (<https://www.remotion.dev/license>).

## What the key unlocks

Without a valid licence everything works except **new renders and previews**:
`render_project`, `preview_scene` and `retry_job` answer `403 licence_required`
or `licence_invalid` with what is wrong and how to fix it. Projects, past renders
and downloads stay available.

## Activate it

Any one of these (each needs `RENDERWELD_SECRET_KEY` set, because the key is
stored encrypted):

```bash
# an admin agent over MCP:
#   activate_licence { "key": "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2" }

# REST, with an admin key:
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"key":"ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2"}' http://127.0.0.1:4321/v1/licence

# the CLI in the container (a running server reads it after a restart):
docker compose exec renderweld renderweld licence activate ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2

# or before the start: RENDERWELD_LICENCE_KEY / RENDERWELD_LICENCE_KEY_FILE
```

`GET /v1/licence`, `get_licence` and `renderweld licence status` show the status
(`valid`, `grace`, `invalid`, `unlicensed`), the reason, the last check, how long
the server keeps working offline and the activations used. The key itself is only
ever shown as its first group.

## What is sent, and when

- The server calls `api.console.buildbase.app` to activate, then **once a day**.
  It never waits for that call at start.
- With several instances on one database (api + workers), that is still **one
  activation and about one call a day** for the whole deployment: only api
  instances call, one at a time; workers never do. A second database (another
  region, staging) is a second activation.
- The request body is `{ "key": "<licence key>", "instance": "<instance id>" }`
  and **nothing else**: no hostname, no project, asset or usage data. The
  instance id is random (`rf-<UUID>`), created once and stored in the database.
- Behind an HTTPS proxy set `HTTPS_PROXY=http://proxy:3128` **and**
  `NODE_USE_ENV_PROXY=1`, plus `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` for a
  proxy that re-signs TLS.

The complete list of connections the server can make is on
[Privacy and network egress](/docs/privacy/network-egress).

## Offline

If the licence server cannot be reached, renders keep working for **14 days
after the last successful check** (`grace`, with a warning in `get_capabilities`,
`/v1/licence` and the log). After that they are refused until a check succeeds;
`POST /v1/licence` with an empty body (or `activate_licence {}`) checks at once.
Setting the system clock back does not extend the period.

## Moving to another server

The activation belongs to the database, so moving the data volume or database
moves it. For a new installation, free the old one first with
`deactivate_licence`, `DELETE /v1/licence` or `renderweld licence deactivate`,
then activate on the new server. A key over its activation limit answers
`limit_reached`.

## Builds from source

A build from source needs a licence key, like the image. Commercial use always
needs a Commercial key.
