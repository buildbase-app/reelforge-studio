# Research Sources

Research date: **2026-11-20**. These are sources consulted for the
knowledge pack. Always re-check live documentation before making
implementation or licensing decisions.

## Official Remotion sources

1.  **License & Pricing** ---
    https://www.remotion.dev/docs/license/pricing\
    Finding used: distinguishes free license eligibility, company
    licensing, and Remotion for Automators pricing/category.

2.  **License FAQ** --- https://www.remotion.dev/docs/license/faq\
    Finding used: explains allowed commercial use and examples
    distinguishing video creation from selling Remotion itself or
    bypassing licensing.

3.  **Render your video** --- https://www.remotion.dev/docs/render\
    Finding used: documents CLI and other render paths. Implementation
    details must be rechecked against the version selected by the repo.

## Official Motion Canvas sources

4.  **Motion Canvas repository** ---
    https://github.com/motion-canvas/motion-canvas\
    Finding used: repository identifies MIT license and TypeScript
    animation framework.

5.  **Motion Canvas introduction** --- https://motioncanvas.io/docs/\
    Finding used: describes library/editor and its use for informative
    vector animations and voiceover synchronization.

## Official FFmpeg source

6.  **FFmpeg License and Legal Considerations** ---
    https://www.ffmpeg.org/legal.html\
    Finding used: most code is LGPL v2.1+; optional components may be
    GPL and distribution/configuration choices matter.

## Official AI provider sources

7.  **Using Codex with your ChatGPT plan** ---
    https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan\
    Finding used: Codex CLI can run from a project directory and support
    ChatGPT account sign-in.

8.  **Codex CLI** --- https://learn.chatgpt.com/docs/codex/cli\
    Finding used: current CLI setup and workflow overview. Re-check
    exact commands for target environment.

9.  **Using Claude Code with your Pro or Max plan** ---
    https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-max-plan\
    Finding used: subscription access and usage-limit distinctions.

10. **How do I pay for my Claude API usage?** ---
    https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage\
    Finding used: API/Console usage billing is distinct from
    subscription usage.

## Competitive reference

11. **OpenMontage repository** ---
    https://github.com/OpenMontageInc/OpenMontage\
    Finding used: an existing project presents itself as an agentic
    video-production system with pipelines, tools, skills, and a
    Remotion composition path. This is a single competitive example, not
    a comprehensive competitor map. Check its current repo/license and
    distinguish it from similarly named repositories before making
    comparisons.

## Source limitations

-   This was a targeted source check, not exhaustive research.
-   No market sizing, price benchmarking, customer interviews, or sales
    validation were performed.
-   Source pages can change; license claims in this pack are dated
    findings and should be revalidated before release.
-   This pack does not establish legal advice or legal clearance.

## Added during implementation (2026-11-21)

12. **npm registry metadata** (registry.npmjs.org), checked 2026-11-21:
    `@motion-canvas/core` 3.17.2 published 2024-12-14 (MIT);
    `@revideo/core` 0.11.0 published 2026-07-10 (MIT);
    `@remotion/renderer` 4.0.545 published 2026-11-18 (Remotion License).
13. **Remotion pricing page**, re-checked 2026-11-21: Free ≤3 people;
    Automators $0.01/render with $100/month minimum (covers "video editors,
    prompt-to-video apps"); Creators $25/seat/month; Enterprise from $500/month.
    FAQ: Remotion 5.0 will make telemetry mandatory for Automators customers.
14. **Motion Canvas source** (`@motion-canvas/core/lib/app/Renderer.js`,
    `bootstrap.js`, `@motion-canvas/vite-plugin/lib/plugins.js`, v3.17.2):
    basis for the headless harness (D-008).
15. **npm registry metadata**, checked 2026-11-21 (agent platform v0.1):
    `@modelcontextprotocol/sdk` 1.32.2 (latest dist-tag, published
    2026-10-23, MIT; a split v2 line `@modelcontextprotocol/server` 2.4.0
    also exists and is a candidate for a later upgrade); `hono` 4.13.19 and
    `@hono/node-server` 2.1.11 (MIT); `hyperframes` 0.9.77 (published
    2026-11-21, Apache-2.0; `@hyperframes/core|engine|producer` 0.9.77 exist,
    `@hyperframes/cli` and `@hyperframes/renderer` do not).
16. **MCP SDK source** (`@modelcontextprotocol/sdk` 1.32.2,
    `dist/esm/server/webStandardStreamableHttp.d.ts`, `mcp.d.ts`): stateless
    mode is `sessionIdGenerator: undefined`; `enableJsonResponse`; the
    transport's own Host/Origin validation is deprecated in favour of
    external middleware (done in `apps/server/src/app.ts`).
17. **HyperFrames CLI** 0.9.77 (`hyperframes render --help`, `hyperframes docs
    compositions`, `dist/telemetry-*.js`, `dist/chunk-*.js`): local render with
    `--fps`, `--end`, `--workers`, `--refuse-outside-files`; browser from
    `HYPERFRAMES_BROWSER_PATH`; opt-out PostHog telemetry
    (`HYPERFRAMES_NO_TELEMETRY=1` / `DO_NOT_TRACK=1`), update checks
    (`HYPERFRAMES_NO_UPDATE_CHECK=1`); runtime seeks CSS animations
    (Web Animations), so compositions need no GSAP.
18. **Remotion renderer source** (`@remotion/renderer` 4.0.545,
    `dist/render-media.js`, `dist/browser/get-download-destination.js`):
    usage events to Remotion's licensing service are sent only when a
    `licenseKey` is passed; `ensureBrowser()` downloads Chrome Headless Shell
    from `remotion.media` into `node_modules/.remotion`.
19. **ElevenLabs API reference**, "Text to speech with timestamps"
    (https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps):
    endpoint and response shape used by the provider. Not called live
    (VERIFY with a real key).
20. **npm registry** (checked 2026-11-21, `npm view`): `@prisma/client`,
    `@prisma/adapter-better-sqlite3`, `@prisma/adapter-pg`,
    `@prisma/adapter-mariadb` 7.10.1 (dist-tag `latest` for the client;
    `prisma` CLI 7.10.1 published 2026-10-15, its `latest` tag is an 8.0 RC, so
    7.10.1 is pinned). Adapter dependencies: better-sqlite3 ^12.6.0 (12.11.1
    installed), pg ^8.16.3 (8.23.1), mariadb 3.5.4 (LGPL-2.1-or-later).
21. **Prisma 7 packages as installed** (type definitions and generated code,
    2026-11-21): adapters take a URL/config (`PrismaBetterSqlite3({ url })`,
    `PrismaPg(poolConfig, { schema })`, `PrismaMariaDb(url)` which rewrites
    `mysql://` to `mariadb://`); the `prisma-client` generator emits TypeScript
    that loads the provider's query compiler as base64 WebAssembly from
    `@prisma/client/runtime` (no engine binary at runtime); `prisma migrate diff
    --from-empty|--from-schema --to-schema --script` needs a datasource in
    `prisma.config.ts` but no database connection; the schema-engine binary is
    downloaded by the CLI on first use (it is skipped at install because
    `@prisma/engines` is not in `onlyBuiltDependencies`).
22. **Prisma docs, MongoDB** (https://www.prisma.io/docs/orm/overview/databases/mongodb,
    fetched 2026-11-21): "MongoDB support for Prisma ORM v7 is coming in the
    near future"; use Prisma ORM v6.19 for MongoDB meanwhile.
23. **MySQL 8.4 + MariaDB Connector/Node.js** (observed 2026-11-21 against
    `mysql:8.4` (8.4.13)): `caching_sha2_password` over plain TCP fails with
    "RSA public key is not available client side" unless
    `allowPublicKeyRetrieval=true` (or TLS) is set.
24. **SQLite documentation**, "ALTER TABLE" (the 12-step table rebuild with
    `PRAGMA foreign_keys=OFF` outside the transaction and
    `PRAGMA foreign_key_check` before commit) and "VACUUM INTO" (consistent
    online copy): https://www.sqlite.org/lang_altertable.html,
    https://www.sqlite.org/lang_vacuum.html (from documentation knowledge;
    VERIFY wording).
25. **npm registry, `yaml`** (eemeli/yaml): `pnpm view yaml` on 2026-11-21:
    latest 2.9.1 (published 2026-09-11), ISC licence, no dependencies; used to
    parse `REELFORGE_CONFIG` (D-031). https://www.npmjs.com/package/yaml
26. **Node.js `crypto`**: `createCipheriv('aes-256-gcm')` with a 12-byte IV,
    `setAAD`, `getAuthTag`/`setAuthTag`, and `hkdfSync('sha256', ...)`, as used
    for secrets at rest (D-033). https://nodejs.org/api/crypto.html (Node 22;
    from documentation knowledge, behaviour verified by the round-trip,
    wrong-key and tamper tests in packages/core/test/config.test.ts).
27. **`@buildbase/sdk` 1.8.0, `LicensesApi`** (read 2026-11-21 in
    `node_modules/@buildbase/sdk/dist/index.d.ts` and `dist/index.mjs` of the
    store repo; npm `pnpm view @buildbase/sdk` 1.8.0): `new LicensesApi({ serverUrl,
    version, orgId })`; `validate(key, instance?)`, `activate(key, instance)`,
    `deactivate(key, instance)` each `POST {serverUrl}/api/{version}/licenses/{orgId}/{op}`
    with JSON `{ key, instance }` and no auth headers (`getAuthHeaders()`
    returns `{}`); the answer is `LicenseCheckView` `{ valid, reason, key?:
    { status, activations, activationLimit, expiresAt }, item?: { id, title },
    instance?: { instance, activatedAt } | null }`; reasons `LICENSE_REASON`:
    not_found, revoked, expired, not_yet, limit_reached, not_activated; keys are
    25 characters of `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` in groups of 5; a
    non-2xx answer throws with `status`, `code` (429 → `LICENSE_CHECKS_LIMITED`)
    and `retryAfterSeconds` from `Retry-After`. The package's dependencies
    include React UI libraries and peer dependencies on `next`, `react` and
    `react-dom` (17 MB unpacked), which is why the studio speaks the same HTTP
    contract itself (D-035).
28. **BuildBase licence API, live** (2026-11-21, development environment
    `6b01478bb42d2c444e99fcd8-fsyqdskf`, a key from a test purchase with
    `activationLimit: 1`): validate/activate/deactivate behave as above;
    activate is idempotent per instance; a second instance gets
    `limit_reached`; an unknown key `not_found`; too many checks 429
    `LICENSE_CHECKS_LIMITED`. Our client against it from a real server process:
    activate → `valid`, `activations 1/1`, item "ReelForge Studio" →
    `DELETE /v1/licence` → `activations 0/1`; cross-checked afterwards with the
    SDK's `LicensesApi.validate(key)`: `valid: true, activations: 0`.
29. **Node.js 22 `NODE_USE_ENV_PROXY`**: Node's built-in `fetch` ignores
    `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` (added in Node 22.21 / 24.5;
    observed 2026-11-21 on Node 22.23.5: the live licence check went through
    the sandbox proxy only with it, with the warning "EnvHttpProxyAgent is
    experimental"). https://nodejs.org/api/cli.html#node_use_env_proxy1
30. **OpenTelemetry JS 3.x / exporters 0.301.x** (npm registry, read
    2026-11-21): `@opentelemetry/api` 1.10.0, `sdk-trace` / `sdk-metrics` /
    `sdk-logs` / `core` / `resources` / `context-async-hooks` 3.1.1 (3.0.0
    released 2026-10-20; 3.x replaces `sdk-trace-base` with `sdk-trace` and
    folds the logs API into `@opentelemetry/api`), `exporter-prometheus` and
    `exporter-{trace,metrics,logs}-otlp-{http,proto}` 0.301.2 (2026-11-12).
    Behaviour read from the installed code: the OTLP exporters retry
    429/502/503/504 and network errors up to 5 times with exponential backoff
    (1 s initial, ×1.5, max 5 s, ±20 % jitter) inside `timeoutMillis`
    (`otlp-exporter-base/dist/retrying-transport.mjs`); `PrometheusSerializer`
    adds `_total` to monotonic sums but no unit suffix (we add `_seconds`).
    OTLP/HTTP paths `/v1/traces`, `/v1/metrics`, `/v1/logs` and the
    `OTEL_EXPORTER_OTLP_*` variable names: https://opentelemetry.io/docs/specs/otel/protocol/exporter/
    HTTP semantic conventions (`http.server.request.duration`, `http.route`,
    `http.request.method`, `http.response.status_code`):
    https://opentelemetry.io/docs/specs/semconv/http/http-metrics/
31. **OpenTelemetry Collector contrib 0.140.0** (`mirror.gcr.io/otel/opentelemetry-collector-contrib:0.140.0`,
    pulled 2026-11-21) and **Prometheus v3.7.3** `promtool check metrics`
    (`mirror.gcr.io/prom/prometheus:v3.7.3`): the receivers used by the
    Docker e2e (OTLP/HTTP on 4318 with `http/protobuf`, the Prometheus
    receiver scraping `/metrics`, the file exporter).
32. **Vendor OTLP endpoints** (documentation, read 2026-11-21; not tested
    against the vendors): Grafana Cloud OTLP gateway
    `https://otlp-gateway-<zone>.grafana.net/otlp` with
    `Authorization=Basic <base64 instance-id:token>`
    (https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/);
    Honeycomb `https://api.honeycomb.io` with `x-honeycomb-team=<key>`
    (https://docs.honeycomb.io/send-data/opentelemetry/); Datadog through the
    Datadog Agent's OTLP receiver on `http://<agent>:4318`
    (https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent/).

33. **Storage SDKs and services** (consulted 2026-11-21, for #27, D-065..D-069):
    npm registry metadata for `@aws-sdk/client-s3` / `s3-request-presigner`
    (3.1164.0 published 2026-11-06, Apache-2.0), `@azure/storage-blob` 12.34.0
    (2026-09-24, MIT), `@azure/identity` 4.14.1 (2026-10-29, MIT),
    `@google-cloud/storage` 8.4.0 (2026-10-09, Apache-2.0; 9.0.0 of 2026-11-12
    not taken). Behaviour verified in this repo's tests rather than from docs:
    `@smithy/node-http-handler` only *warns* when `requestTimeout` is exceeded
    unless `throwOnRequestTimeout` is set, and aborts on `socketTimeout`
    (inactivity) — observed with a hanging stub server; SigV4 presigned URLs
    last at most 7 days (AWS S3 docs, "Sharing objects with presigned URLs");
    `requestChecksumCalculation: WHEN_REQUIRED` restores the pre-2025 checksum
    behaviour that S3-compatible services expect (AWS SDK for JavaScript v3
    "Data integrity protections" announcement). MinIO no longer publishes
    container images (Docker Hub `minio/minio` answered "repository does not
    exist", `mirror.gcr.io/minio/minio` "not found", quay.io not reachable from
    the build sandbox on 2026-11-21); its source builds with `go install
    github.com/minio/minio@v0.0.0-20260212201848-7aac2a2c5b7c` (Go 1.24.7).
    Emulators: Azurite (`mcr.microsoft.com/azure-storage/azurite:latest`),
    fake-gcs-server (`mirror.gcr.io/fsouza/fake-gcs-server:latest`).

34. **OTLP/HTTP logs, JSON encoding** (read 2026-11-21: OpenTelemetry protocol
    specification, https://opentelemetry.io/docs/specs/otlp/#otlphttp, and the
    logs data model, https://opentelemetry.io/docs/specs/otel/logs/data-model/):
    `POST <endpoint>` (default path `/v1/logs`, port 4318) with
    `Content-Type: application/json`, body `ExportLogsServiceRequest`
    (`resourceLogs[].scopeLogs[].logRecords[]`, `timeUnixNano` as a decimal
    string, attributes as `{key, value: {stringValue|intValue|boolValue}}`).
    Verified 2026-11-21 against `otel/opentelemetry-collector:0.140.0`
    (reports 0.140.1) with the `otlp` receiver and `debug` exporter: our
    records arrive with scope `reelforge.audit`, event name, body and
    attributes (D-058).
35. **HyperFrames 0.9.77 restricted render network** (read from the installed
    package `hyperframes@0.9.77`, `dist/`, 2026-11-21; D-085):
    `PRODUCER_RESTRICT_PAGE_NETWORK=true` starts a local capture proxy and
    launches Chrome with `--proxy-server=<proxy>`,
    `--proxy-bypass-list=<-loopback>;<page server host:port>`, `--disable-quic`,
    `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` and a profile
    preference `webrtc.ip_handling_policy=disable_non_proxied_udp`; the CLI's
    own asset downloads use the same policy. `HYPERFRAMES_CAPTURE_PROXY` (an
    `http://` URL) is the proxy's upstream; `PRODUCER_NON_PUBLIC_CIDRS` adds
    ranges treated as non-public (refused, logged as
    `[CaptureProxy:REFUSED] class=...`). Verified with local TCP/UDP canaries
    (SECT-34..37): no request or packet arrives.
36. **parse5 8.1.1** (npm registry, 2026-11-21): MIT, ESM, WHATWG-compliant
    HTML parser and serializer (`parse`, `parseFragment`, `serialize`,
    `defaultTreeAdapter`).
