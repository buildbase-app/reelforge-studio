---
title: "Isolation guarantees"
description: "What a self-hosted ReelForge Studio sends where, why one installation never talks to another, how to run it offline and what stops after the 14-day licence grace, and how to verify the egress with network policies."
folder: privacy
slug: isolation
order: 2
tags: [privacy, security, deploy]
---

# Isolation guarantees

Each ReelForge Studio installation belongs to one customer and holds that
customer's projects, media, keys and provider credentials. This page states what
the software guarantees about that, how the guarantees follow from the code, how
to check them yourself, and what is not covered yet (issue #291). The full
connection list, with what each request carries, is
[PRIVACY.md](PRIVACY.md); this page does not repeat its details.

## The guarantees

1. **One outside service is required: the BuildBase licence server.** Every
   other connection goes to a service the operator configured. All of the
   studio's APIs (REST `/v1`, MCP `/mcp`, the CLI) are served by the
   installation itself from this repository; nothing is proxied through a
   ReelForge or BuildBase service.
2. **No telemetry.** No analytics, crash reports, update checks or usage
   reports, from the server or from the bundled tools (HyperFrames, Remotion,
   Prisma), which are run with their telemetry off.
3. **Installations never talk to each other.** There is no peer discovery, no
   shared cache or CDN, no relay and no shared state between customers.
   Instances of one deployment (api and workers) share only the database,
   storage and broker that the operator gave them.

## What an installation sends, and where

| Destination | When | What | Without it |
| --- | --- | --- | --- |
| `api.console.buildbase.app` (licence) | from `api` / `all` instances only: activation, then once a day per deployment, plus retries | the licence key and the installation's random instance id (`rf-<UUID>`), nothing else | renders keep working for 14 days after the last successful check ([offline](#offline)) |
| Your database (`database.url`) | always (SQLite is a local file) | all metadata | — |
| Your object storage (`storage.driver` `s3`, `azure`, `gcs`) and the cloud's identity endpoints | only if selected | asset and render files | `local` (default) sends nothing |
| Your broker (`queue.dispatch` `sqs`, `redis`) | only if selected | job ids | `poll` / `notify` use only the database |
| ElevenLabs (`api.elevenlabs.io`) | only with a key **and** a call that acknowledged the cost | the text, voice and model ids | no key: no request |
| Your webhook, Slack, Discord, Teams and email endpoints | only for endpoints an admin created | event facts (ids, statuses, setting names); never keys, manifests, prompts or media | no endpoint: nothing |
| Your OTLP collector (`observability.otlp.endpoint`, `audit.otlpEndpoint`) | only if set | traces, metrics, redacted logs, audit entries | unset: nothing; Prometheus pulls `/metrics` |
| A URL an agent passes to `add_asset_from_url` | only on that call | an HTTPS GET of that file (private addresses refused) | do not grant `write` |

At build and install time the image build fetches from Docker Hub, the Debian
snapshot archive, `registry.npmjs.org` and `remotion.media`; a pulled release
image needs none of them. Inside a render, scene code has no network at all
(PRIVACY.md, "Inside renders").

**How this follows from the code.** The runtime source has exactly two kinds of
built-in hosts: the licence server, and the default base URLs of providers you
have to configure first (ElevenLabs, Resend, Postmark, SendGrid, the AWS and
Google endpoints). Reproduce the list:

```bash
grep -rhoE --include=*.ts "https?://[a-zA-Z0-9.-]+\.[a-z]{2,}" apps/server/src packages/*/src \
  | grep -v -e example -e localhost -e prisma.io -e pris.ly -e github.com | sort | uniq -c
```

Run on `main` on 2026-11-24, it prints the licence server, the provider base
URLs (`api.elevenlabs.io`, `api.resend.com`, `api.postmarkapp.com`,
`api.sendgrid.com`, `api.eu.sendgrid.com`, `storage.googleapis.com`) and names
that are never connected to: documentation links in comments (`elevenlabs.io`,
`www.standardwebhooks.com`, and in Prisma's generated client `stackoverflow.com`
and `google.github.io`), example values in setting descriptions
(`hooks.slack.com`, `sqs.eu-west-1.amazonaws.com`) and the Adaptive Card schema
identifier in Teams messages (`adaptivecards.io`). `prisma.io`, `pris.ly` and
`github.com` are filtered out above because they appear only in generated
comments and documentation links. A new outbound connection must be listed in PRIVACY.md
before it is merged (AGENTS.md, "Conventions").

## Why installations cannot reach each other

- **Nothing to connect to.** An installation opens no listener except its own
  HTTP port, discovers no peers and has no address of any other installation.
  The only shared endpoint is the licence server, which answers licence checks
  and passes nothing between customers.
- **Nothing shared.** Caches (engine bundles, provider results, asset copies)
  are files in the installation's own `storage.cacheDir`. Identical provider
  requests are served from that local cache, never from a shared one.
- **Its own identity and keys.** The instance id is random, created once and
  stored in the installation's database. Secrets stored over the API are
  encrypted with the installation's own `REELFORGE_SECRET_KEY`; signed download
  links use a key in its own data directory (or derived from that secret key
  with several instances). A database copied to another installation does not
  decrypt there without the key, and its licence state does not verify there.
- **Deployments that share infrastructure.** Two deployments on one PostgreSQL
  server are separated by database or by schema (`?schema=`), and every query,
  raw SQL included, names its schema; give each deployment its own database user
  for a real boundary ([HARDENING.md](security/HARDENING.md#deployments-sharing-a-postgresql-database)).
  On one Redis server use different `queue.redis.stream` keys; on one bucket
  different prefixes; for SQS one queue per deployment.

**What is verified, and what is not yet.** PRIVACY.md was checked against the
code and dependencies on 2026-11-21. Automated tests prove the render engines
stay offline: a HyperFrames render under `strace` makes no connection outside
loopback, and the font guard refuses Google Fonts before any DNS lookup
(SECT-41..43, `packages/engine-hyperframes/test/egress.test.ts`); html, Remotion
and Motion Canvas renders with a missing web font made 0 connections outside
loopback under `strace` (2026-11-23). A dev-edition container with
`--network none` rendered a four-engine project (DEPLOY.md).

**The whole server, end to end** (`apps/server/test/egress.e2e.test.ts`, #291).
The test starts the server as `pnpm start` does, under `strace -f`, so it covers
the server and every process it starts (FFmpeg, Chromium, the engine CLIs). It
drives a full journey over REST and MCP: a project across the four engines with
uploaded music and burned captions, a preview, a render, the download, the
dashboard, analytics and a storage cleanup. The licence is enforced as in the
sold image, against a local mock of the licence server.

The test fails on any connect() or send outside loopback, and on any DNS query.
It also checks two things about the licence calls:

- they went only to the configured licence server;
- each carried only the key and an instance id.

A control run of a process that connects to `192.0.2.1` proves the recorder
catches a leak.

It needs `strace` and a browser, and skips without them; its header says how to
make a missing one fail the run instead. The network-level checks
below are how you verify the same on your own installation.

## Offline

What needs the network: only the licence check (and the providers you chose).
The licence rules (D-028, DEPLOY.md "Licence"):

- The server never waits for the licence server at start. Activation needs one
  successful request; after that, an `api` or `all` instance checks once a day
  per deployment.
- If the licence server cannot be reached, everything keeps working, renders
  included, for **14 days after the last successful check** (status `grace`,
  with a warning in `get_capabilities`, `get_licence` and the log, and a
  `licence.state_changed` event). `licence.offlineGraceDays` can only shorten
  it.
- **After the 14 days, only new renders stop:** `render_project`,
  `preview_scene` and `retry_job` answer `403` with what to do, and workers claim
  no render job. Projects, edits, validation, assets, existing renders and their
  downloads, keys, configuration, webhooks, audit and metrics keep working.
  The next successful check (daily, or at once with `activate_licence {}` /
  `POST /v1/licence` with an empty body) restores renders.
- Setting the clock back does not extend the grace: a clock more than 10
  minutes behind the latest time the installation has seen gets no grace.

**Running without internet.** Load the image from a file
(`docker save` / `docker load`, or your private registry); rendering needs no
network. Give only the `api` instances a path to `api.console.buildbase.app`
on 443 at least once every 14 days, for example an HTTPS proxy that allows that
one host (`HTTPS_PROXY=http://proxy:3128` **and** `NODE_USE_ENV_PROXY=1`;
`NODE_EXTRA_CA_CERTS` for a TLS-inspecting proxy). A fully air-gapped release
installation that never reaches the licence server is not supported today:
there is no offline activation file yet (BuildBase's answers are not signed;
see docs/research/BUILDBASE_SIGNED_LICENCE_REQUEST.md).

## What the licence controls, and nothing else

The licence decides one thing: whether new renders and previews may start. It
does not limit features, API calls, users, keys, projects, storage, engines or
providers, and it does not report usage. Every other limit is the operator's
own setting with a default (`limits.*`, `storage.retention.*`, per-key quotas),
changeable over the API. Exception today: the render limits have upper bounds
in the schema (180 s, 10 800 frames, 50 scenes, 4096 px, 60 fps); turning them
into configurable bounds is issue #302.

## Verify it with network policies

**Kubernetes.** `deployment/kubernetes/base/networkpolicy.yaml` denies all
ingress and egress in the namespace and then allows DNS, the database, Redis,
and HTTPS to public addresses (DEPLOY.md, "Network policy"). To prove the
"licence server plus your providers" claim, narrow the HTTPS rules: route the
api's egress through an egress gateway or proxy that allows only
`api.console.buildbase.app` and the hosts you configured, or use FQDN policies
(Cilium `toFQDNs`, Calico DNS policy). Workers need only the database, storage
and the broker (and your webhook / email / OTLP endpoints, since workers deliver
events too); they never call the licence server. NetworkPolicy matches
addresses, needs a CNI that enforces it, and blocks link-local addresses in the
shipped file (cloud identity endpoints: see the cloud guides).

**Docker.** Put the studio on an internal network with a proxy as its only way
out, and read the proxy's log:

```bash
docker network create --internal rf-internal
docker network create rf-egress
docker run -d --name egress --network rf-egress <an HTTP proxy image allowing only api.console.buildbase.app:443>
docker network connect rf-internal egress
docker run -d --name reelforge --network rf-internal \
  -e HTTPS_PROXY=http://egress:3128 -e NODE_USE_ENV_PROXY=1 \
  -e REELFORGE_SECRET_KEY_FILE=/run/secrets/secret_key -v $PWD/secret_key:/run/secrets/secret_key:ro \
  -v reelforge-data:/data reelforge-studio
# render a project, then: every CONNECT in the proxy log names api.console.buildbase.app or a host you configured
```

This recipe is a pattern, not a tested script (VERIFY with your proxy). Node's
`fetch` uses the proxy only with `NODE_USE_ENV_PROXY=1`; connections that do not
honour the proxy (database, Redis, SMTP) fail on the internal network, which is
what you want to see if you did not configure them. To watch the process
directly: `strace -f -e trace=connect` on the server process lists every
outbound address.

**On a host firewall.** Allow outbound 443 only to the licence server's
addresses and your providers' endpoints, plus the database and broker ports, and
log drops.
