import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { isLanguageTag } from '@reelforge/project-schema';
import { weakKeyReason } from '../keyStrength';

/**
 * The configuration schema: every setting of ReelForge Studio in one typed Zod
 * object, with per-key metadata (environment variables, start-up only or
 * runtime-changeable, secret or not, default, description).
 *
 * Sources, lowest to highest precedence (docs/DECISIONS.md D-029):
 *   1. defaults (below)
 *   2. the config file (REELFORGE_CONFIG: YAML or JSON, same nesting as here)
 *   3. environment variables (REELFORGE_*, aliases such as DATABASE_URL; every
 *      secret also as <NAME>_FILE)
 *   4. runtime settings set over REST/MCP (PATCH /v1/config, update_config),
 *      stored in the database; only keys with scope "runtime"
 *
 * docs/CONFIG.md is generated from this file (`pnpm docs:config`).
 */

export type SettingScope = 'startup' | 'runtime';
/** How an environment variable's text is turned into a value. */
export type SettingKind = 'string' | 'integer' | 'number' | 'boolean' | 'list' | 'enum' | 'path' | 'url';

export interface SettingMeta {
  kind: SettingKind;
  description: string;
  /** "startup": read once when the server starts; "runtime": PATCH /v1/config applies it immediately. */
  scope: SettingScope;
  /** Primary environment variable (REELFORGE_*). */
  env: string;
  /** Other accepted names, lower precedence than `env` (existing names keep working). */
  aliases?: string[];
  /** Never returned, logged or put in errors; shown as "set" / "not set". Read from <NAME>_FILE too. */
  secret?: boolean;
  /** Static default, or computed from other effective values. */
  default?: unknown | ((get: (key: string) => unknown) => unknown);
  /** How docs show a computed default. */
  defaultText?: string;
  /** Providers/backends read this name from their environment object; runtime values are written there. */
  providerEnv?: string;
  /** Code outside the server reads this name from process.env; values from the file or REELFORGE_* are exported to it. */
  processEnv?: string;
  /** Reserved for a feature that is not built yet (the issue that builds it). */
  placeholder?: string;
  example?: string;
}

type Getter = (key: string) => unknown;
const META = new Map<z.ZodType, SettingMeta>();

function setting<T extends z.ZodType>(schema: T, meta: SettingMeta): T {
  META.set(schema, meta);
  return schema;
}

// Factories, not shared instances: each setting needs its own schema object (metadata is keyed by it).
const port = () => z.number().int().min(0).max(65535);
const nonNegative = () => z.number().int().min(0);
const positive = () => z.number().int().min(1);
const hostName = () => z
  .string()
  .min(1)
  .max(253)
  .regex(/^(\[[0-9a-f:.]+\]|[a-z0-9.:-]+)$/i, 'a host name such as studio.example.com (no scheme, path or port)');
const httpUrl = () => z
  .string()
  .regex(/^https?:\/\/[^\s/]+(\/[^\s]*)?$/, 'must start with http:// or https://')
  .transform((s) => s.replace(/\/+$/, ''));
const nonEmpty = () => z.string().min(1);

export const ConfigSchema = z.object({
  server: z.object({
    host: setting(nonEmpty(), {
      kind: 'string',
      scope: 'startup',
      env: 'REELFORGE_HOST',
      default: '127.0.0.1',
      description: 'Bind address. Keep loopback unless a TLS proxy is in front (`0.0.0.0` in the Docker image).',
    }),
    port: setting(port(), { kind: 'integer', scope: 'startup', env: 'REELFORGE_PORT', default: 4321, description: 'TCP port (`0` picks a free one).' }),
    publicUrl: setting(httpUrl().optional(), {
      kind: 'url',
      scope: 'startup',
      env: 'REELFORGE_PUBLIC_URL',
      example: 'https://studio.example.com',
      description: 'Public base URL: used in output links and allowed as Host on `/mcp`.',
    }),
    allowedHosts: setting(z.array(hostName().transform((h) => h.toLowerCase())).max(100), {
      kind: 'list',
      scope: 'runtime',
      env: 'REELFORGE_ALLOWED_HOSTS',
      default: [],
      example: 'reelforge,studio.internal',
      description: 'Extra host names accepted on `/mcp` (DNS-rebinding protection), besides localhost and the public URL host. Comma-separated in the environment.',
    }),
    trustProxy: setting(z.boolean(), {
      kind: 'boolean',
      scope: 'runtime',
      env: 'REELFORGE_TRUST_PROXY',
      default: false,
      description:
        'Take the client address from the last entry of `X-Forwarded-For` (set by your reverse proxy) instead of the TCP peer, for the audit log and per-key IP allowlists. Only turn it on behind a proxy that sets that header.',
    }),
    role: setting(z.enum(['all', 'api', 'worker']), {
      kind: 'enum',
      scope: 'startup',
      env: 'REELFORGE_ROLE',
      default: 'all',
      description:
        'What this instance does (D-076). `all`: serve REST/MCP and render (one instance). `api`: serve REST/MCP and enqueue jobs, never render. `worker`: claim and render jobs from the database queue; serves only `/healthz`, `/readyz` and `/metrics`. `api` and `worker` need PostgreSQL or MySQL and remote storage (or `storage.localShared`); see docs/providers/queue-and-scaling.md.',
    }),
    workerConcurrency: setting(z.number().int().min(1).max(64).optional(), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_WORKER_CONCURRENCY',
      defaultText: '`limits.renderConcurrency`',
      description:
        'Jobs one `worker` (or `all`) instance claims and renders at the same time. Unset: `limits.renderConcurrency` (which can then be changed at runtime). Scale out with more worker instances rather than a high value here.',
    }),
    workerOnce: setting(z.boolean(), {
      kind: 'boolean',
      scope: 'startup',
      env: 'REELFORGE_WORKER_ONCE',
      default: false,
      description:
        'Run as `reelforge worker --once` (D-100): claim at most one job, render it and exit (0 succeeded, cancelled or nothing queued; 1 failed; 75 handed back, lease lost, or the `--job` still queued; see docs/providers/backends.md). For job platforms that start one container per unit (KEDA ScaledJob, Azure Container Apps event jobs, AWS Batch, Cloud Run Jobs, ECS RunTask). Implies `server.role` `worker` (same database and storage rules); serves no HTTP.',
    }),
  }),
  dashboard: z.object({
    enabled: setting(z.boolean(), {
      kind: 'boolean',
      scope: 'runtime',
      env: 'REELFORGE_DASHBOARD_ENABLED',
      default: false,
      description:
        'Serve the web dashboard at `/dashboard` (D-115; docs/public/install/dashboard.md): live jobs with cancel and retry, and the library of projects and renders. Off: `/dashboard` answers 404. It is a client of the public REST API: people sign in with an API key, and every call is checked against that key\'s scopes. Same Host check as `/mcp` (`server.publicUrl`, `server.allowedHosts`), a strict Content-Security-Policy, no cookies and no external hosts. Not served by `worker` instances.',
    }),
  }),
  queue: z.object({
    driver: setting(z.enum(['auto', 'inprocess', 'database']), {
      kind: 'enum',
      scope: 'startup',
      env: 'REELFORGE_QUEUE_DRIVER',
      default: 'auto',
      description:
        'Job queue (D-075). `inprocess`: the instance runs the jobs it accepted (one instance; jobs interrupted by a restart are marked failed). `database`: jobs are claimed from the database with leases (`SELECT ... FOR UPDATE SKIP LOCKED` on PostgreSQL/MySQL, an atomic update on SQLite), so several workers share them and a crashed worker\'s job is retried. `auto`: `database` for the `api` and `worker` roles, else `inprocess`.',
    }),
    leaseSeconds: setting(z.number().int().min(2).max(3600), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_QUEUE_LEASE_SECONDS',
      default: 60,
      description:
        'Database queue: how long a claimed job belongs to its worker without a heartbeat. Workers renew the lease every quarter of this; a job whose lease ran out (the worker crashed or lost the database) is queued again, or failed after `queue.maxAttempts`.',
    }),
    maxAttempts: setting(z.number().int().min(1).max(20), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_QUEUE_MAX_ATTEMPTS',
      default: 3,
      description: 'Database queue: claims per job. A job whose lease expired this many times is failed with `lease_expired` instead of being queued again.',
    }),
    pollIntervalMs: setting(z.number().int().min(50).max(60_000), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_QUEUE_POLL_INTERVAL_MS',
      default: 1000,
      description:
        'Database queue: how often an idle worker looks for queued jobs, and how often `get_job waitSeconds` re-reads a job running on another instance. Empty polls back off up to `queue.pollMaxIntervalMs`; on database errors the interval backs off exponentially up to 30 s.',
    }),
    pollMaxIntervalMs: setting(z.number().int().min(50).max(300_000), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_QUEUE_POLL_MAX_INTERVAL_MS',
      default: 5000,
      description:
        'Database queue, `queue.dispatch` `poll` (D-105): after each poll that finds nothing, an idle worker waits twice as long as the last time, from `queue.pollIntervalMs` up to this; a poll that claims a job goes back to `queue.pollIntervalMs`, so a busy queue is polled as before. It bounds the extra queue wait after an idle period (a job enqueued then waits at most this long for a worker with a free slot) and cuts idle database load. Set it to `queue.pollIntervalMs` for no backoff. Also the poll while a `notify` listener is disconnected.',
    }),
    dispatch: setting(z.enum(['poll', 'notify', 'sqs', 'redis']), {
      kind: 'enum',
      scope: 'startup',
      env: 'REELFORGE_QUEUE_DISPATCH',
      default: 'poll',
      description:
        'How workers of the database queue learn that a job is ready (D-105; the database stays the queue of record either way). `poll`: idle workers look every `queue.pollIntervalMs`, backing off to `queue.pollMaxIntervalMs`. `notify` (PostgreSQL only): the transaction that queues a job sends `NOTIFY` and workers `LISTEN` on one direct session connection each, so idle workers stop polling and are woken within milliseconds; a fallback poll every `queue.dispatchFallbackSeconds` claims anything a lost message did not announce. `LISTEN` does not work through PgBouncer in transaction or statement mode: set `database.directUrl` then (a worker checks delivery at start and refuses to start without it). Refused at start on MySQL and SQLite. `sqs` (Amazon SQS standard queue, `queue.sqs.*`) and `redis` (Redis Streams with a consumer group, `queue.redis.*`), on every database: the transaction that queues a job writes an outbox row, each instance\'s relay publishes the job id, one worker receives it, wakes its normal fair claim and acknowledges the message after that claim; idle workers wait on the broker instead of the database, and the broker\'s queue depth can drive an autoscaler. A broker that is down never blocks an enqueue (the outbox keeps the row and retries) and workers poll until it answers. Set the same value on every instance. NATS JetStream is planned (docs/providers/queue-and-scaling.md).',
    }),
    dispatchFallbackSeconds: setting(z.number().int().min(1).max(3600), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_QUEUE_DISPATCH_FALLBACK_SECONDS',
      default: 30,
      description:
        '`queue.dispatch` `notify`, `sqs`, `redis`: how often an idle worker still polls while its listener is connected, so a job whose message was lost (a dropped connection, a job queued by a process without the dispatch setting) waits at most this long. Lower values cost one claim transaction per idle worker per interval. With `sqs` and `redis` also how often each instance\'s outbox relay looks for rows it did not publish at once (another instance stopped before publishing).',
    }),
    sqs: z.object({
      queueUrl: setting(httpUrl().optional(), {
        kind: 'url',
        scope: 'startup',
        env: 'REELFORGE_QUEUE_SQS_QUEUE_URL',
        example: 'https://sqs.eu-west-1.amazonaws.com/123456789012/reelforge-jobs',
        description: '`queue.dispatch` `sqs`: the URL of an SQS **standard** queue (not FIFO) that only this deployment uses. Required with `sqs`. The api and workers need `sqs:SendMessage`; workers also `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility` and `sqs:GetQueueAttributes`.',
      }),
      region: setting(nonEmpty().optional(), {
        kind: 'string',
        scope: 'startup',
        env: 'REELFORGE_QUEUE_SQS_REGION',
        defaultText: 'the region in `queue.sqs.queueUrl`, else the AWS default (`AWS_REGION`)',
        example: 'eu-west-1',
        description: '`queue.dispatch` `sqs`: AWS region of the queue.',
      }),
      endpoint: setting(httpUrl().optional(), {
        kind: 'url',
        scope: 'startup',
        env: 'REELFORGE_QUEUE_SQS_ENDPOINT',
        description: '`queue.dispatch` `sqs`: SQS API endpoint override (a VPC endpoint, or LocalStack in tests). Empty: the regional AWS endpoint.',
      }),
      accessKeyId: setting(nonEmpty().optional(), {
        kind: 'string',
        scope: 'runtime',
        env: 'REELFORGE_QUEUE_SQS_ACCESS_KEY_ID',
        secret: true,
        description: '`queue.dispatch` `sqs`: access key id. Leave unset to use the ambient AWS identity (IAM role, IRSA / web identity, `AWS_*` variables). A change at runtime applies to the next SQS call.',
      }),
      secretAccessKey: setting(nonEmpty().optional(), { kind: 'string', scope: 'runtime', env: 'REELFORGE_QUEUE_SQS_SECRET_ACCESS_KEY', secret: true, description: '`queue.dispatch` `sqs`: secret access key (with `accessKeyId`).' }),
      sessionToken: setting(nonEmpty().optional(), { kind: 'string', scope: 'runtime', env: 'REELFORGE_QUEUE_SQS_SESSION_TOKEN', secret: true, description: '`queue.dispatch` `sqs`: session token for temporary keys (optional).' }),
      visibilityTimeoutSeconds: setting(z.number().int().min(5).max(43_200), {
        kind: 'integer',
        scope: 'startup',
        env: 'REELFORGE_QUEUE_SQS_VISIBILITY_TIMEOUT_SECONDS',
        default: 30,
        description:
          '`queue.dispatch` `sqs`: visibility timeout set on every receive. A message received by a worker that stops before deleting it (deleted after the claim it woke) becomes visible to the other workers after this long; its claim is then a no-op. Shorter: a lost message wakes another worker sooner; it must stay longer than a claim takes (milliseconds) plus network hiccups.',
      }),
    }),
    redis: z.object({
      url: setting(nonEmpty().regex(/^rediss?:\/\//, 'must start with redis:// or rediss://').optional(), {
        kind: 'string',
        scope: 'startup',
        env: 'REELFORGE_QUEUE_REDIS_URL',
        secret: true,
        example: 'rediss://reelforge@redis.internal:6380/0',
        description: '`queue.dispatch` `redis`: the Redis server (6.2 or later; Streams, XAUTOCLAIM). `rediss://` connects with TLS. Required with `redis`. Secret because the URL may hold a password (prefer `queue.redis.password`).',
      }),
      password: setting(nonEmpty().optional(), {
        kind: 'string',
        scope: 'runtime',
        env: 'REELFORGE_QUEUE_REDIS_PASSWORD',
        secret: true,
        description: '`queue.dispatch` `redis`: password (Redis AUTH; the user name comes from the URL). Overrides a password in `queue.redis.url`. A change at runtime reconnects.',
      }),
      tlsCaFile: setting(nonEmpty().optional(), {
        kind: 'path',
        scope: 'startup',
        env: 'REELFORGE_QUEUE_REDIS_TLS_CA_FILE',
        description: '`queue.dispatch` `redis` with `rediss://`: a PEM file with the CA that signed the server certificate (private CAs). Unset: the system CAs.',
      }),
      stream: setting(nonEmpty().max(200), {
        kind: 'string',
        scope: 'startup',
        env: 'REELFORGE_QUEUE_REDIS_STREAM',
        default: 'reelforge:jobs',
        description: '`queue.dispatch` `redis`: stream key. Deployments sharing a Redis server need different keys.',
      }),
      group: setting(nonEmpty().max(200), {
        kind: 'string',
        scope: 'startup',
        env: 'REELFORGE_QUEUE_REDIS_GROUP',
        default: 'reelforge-workers',
        description: '`queue.dispatch` `redis`: consumer group the workers read through (created with the stream if missing).',
      }),
      claimIdleSeconds: setting(z.number().int().min(5).max(86_400), {
        kind: 'integer',
        scope: 'startup',
        env: 'REELFORGE_QUEUE_REDIS_CLAIM_IDLE_SECONDS',
        default: 30,
        description:
          '`queue.dispatch` `redis`: an entry delivered to a worker that stopped before acknowledging it (acknowledged after the claim it woke) is reclaimed by another worker with XAUTOCLAIM after it was pending this long; its claim is then a no-op.',
      }),
      maxLength: setting(z.number().int().min(1000).max(100_000_000), {
        kind: 'integer',
        scope: 'startup',
        env: 'REELFORGE_QUEUE_REDIS_MAX_LENGTH',
        default: 100_000,
        description: '`queue.dispatch` `redis`: the stream is trimmed to about this many entries (XADD MAXLEN ~). Entries trimmed before a worker read them are covered by the fallback poll.',
      }),
    }),
    notifyJitterMs: setting(z.number().int().min(0).max(5000), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_QUEUE_NOTIFY_JITTER_MS',
      default: 50,
      description:
        '`queue.dispatch` `notify`: a message wakes every idle worker, so each waits a random delay of up to this long before it claims, and skips the claim when other workers already claimed the announced jobs meanwhile (each claim is announced too). Larger: fewer empty claims per job when many workers are idle; smaller: less added queue wait (on average this divided by the number of idle workers, plus one).',
    }),
    shutdownGraceSeconds: setting(z.number().int().min(0).max(3600), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_QUEUE_SHUTDOWN_GRACE_SECONDS',
      default: 30,
      description:
        'On SIGTERM a worker stops claiming and waits this long for its running jobs; jobs still running then are stopped and handed back to the queue (database queue), so another worker takes them at once. Keep the orchestrator\'s grace period (Kubernetes `terminationGracePeriodSeconds`) longer.',
    }),
    onceWaitMs: setting(z.number().int().min(0).max(600_000).optional(), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_QUEUE_ONCE_WAIT_MS',
      defaultText: '3 × `queue.pollIntervalMs`',
      description:
        '`worker --once`: how long to wait for a queued job before exiting 0 with nothing done, so a job platform does not pay for an idle container. `reelforge worker --once --wait-ms N` overrides it.',
    }),
    priorityAgingSeconds: setting(z.number().int().min(0).max(86_400), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_QUEUE_PRIORITY_AGING_SECONDS',
      default: 600,
      description:
        'Job priorities (D-103): jobs are claimed `interactive` (previews) first, then `standard` (renders), then `batch`. A `batch` job that has waited this long is claimed as `standard` (never as `interactive`), so a steady stream of renders cannot starve batch work. `0`: strict classes (batch waits while any higher job can be claimed).',
    }),
  }),
  limits: z.object({
    rateLimitPerMinute: setting(nonNegative(), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_RATE_LIMIT_PER_MINUTE',
      default: 300,
      description: 'Requests per minute per API key (`0` disables the limit).',
    }),
    rateLimitStore: setting(z.enum(['auto', 'memory', 'database']), {
      kind: 'enum',
      scope: 'startup',
      env: 'REELFORGE_RATE_LIMIT_STORE',
      default: 'auto',
      description:
        'Where per-key request counts live (D-078). `memory`: a token bucket per instance (with several API instances each allows the full limit). `database`: a sliding 60-second window from one counter per key and minute in the database, shared by every instance. `auto`: `database` when the job queue is `database`, else `memory`.',
    }),
    preAuthPerMinute: setting(nonNegative(), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_PRE_AUTH_RATE_LIMIT_PER_MINUTE',
      default: 1200,
      description:
        'Requests per minute per client address (`server.trustProxy` decides which one; IPv6 per /64), checked before the API key is looked up, so a flood costs no database work. Per instance, in memory. Several keys behind one address share it, so keep it above `limits.rateLimitPerMinute`. `0` disables it.',
    }),
    authFailuresPerMinute: setting(nonNegative(), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_AUTH_FAILURES_PER_MINUTE',
      default: 20,
      description:
        'Failed authentications (missing, unknown, revoked or expired key) per minute per client address; the one that uses them up locks the address out (`limits.authLockoutSeconds`). While locked out, its requests get `429` without a key lookup. Per instance, in memory. `0` disables the lockout.',
    }),
    authLockoutSeconds: setting(positive(), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_AUTH_LOCKOUT_SECONDS',
      default: 60,
      description: 'The first lockout after too many failed authentications; each further lockout of the same address doubles, up to `limits.authLockoutMaxSeconds`.',
    }),
    authLockoutMaxSeconds: setting(positive(), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_AUTH_LOCKOUT_MAX_SECONDS',
      default: 3600,
      description: 'The longest lockout. An address with no failed authentication for this long starts over at `limits.authLockoutSeconds`.',
    }),
    maxUploadBytes: setting(positive(), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_MAX_UPLOAD_BYTES',
      default: 200 * 1024 * 1024,
      description: 'Largest asset upload or URL import, in bytes. Uploads and imports are streamed to a temporary file and stopped as soon as they pass it (`413 too_large`); they are never held in memory whole.',
    }),
    maxJsonBytes: setting(z.number().int().min(1024), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_MAX_JSON_BYTES',
      default: 2 * 1024 * 1024,
      description: 'Largest JSON request body, in bytes.',
    }),
    renderConcurrency: setting(z.number().int().min(1).max(64), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_RENDER_CONCURRENCY',
      default: 1,
      description: 'Renders at the same time. Each uses several CPU cores and 1-2 GB RAM. A lower value lets running renders finish.',
    }),
    // Resource limits (D-090, D-091; docs/security/HARDENING.md). `0` turns a job or provider cap off.
    maxQueuedJobsPerKey: setting(nonNegative(), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_MAX_QUEUED_JOBS_PER_KEY',
      default: 100,
      description:
        'Unfinished render and preview jobs (queued or running) one API key may have. Another start is refused with `429 too_many_jobs` and `Retry-After` until one finishes. Counted in the database, so it holds across instances. Raise it (or `0`) for one organisation key that feeds a large worker fleet. `0`: no limit.',
    }),
    maxQueuedJobs: setting(nonNegative(), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_MAX_QUEUED_JOBS',
      // Scale-aware (D-090): a single box keeps its queue bounded; the database queue scales with the database and the worker fleet.
      default: (get: Getter) => {
        const driver = get('queue.driver');
        const database = driver === 'database' || (driver === 'auto' && get('server.role') !== 'all');
        return database ? 0 : 1000;
      },
      defaultText: '`1000` with the in-process queue, `0` (no limit) with the database queue',
      description:
        'Render and preview jobs that may wait in the queue in total (every key, every instance). A start beyond it is refused with `429 queue_full` and `Retry-After`. The default follows the effective queue (`queue.driver`, `server.role`): a single instance keeps its queue bounded, the database queue is unbounded because the database and autoscaled workers absorb the load. `0`: no limit. With the database queue, a value here makes every start in the deployment wait for one shared row lock (held for two database round trips per start), which caps the total start rate; prefer `maxQueuedJobsPerKey` there unless the queue itself must be bounded.',
    }),
    maxRunningJobsPerKey: setting(nonNegative(), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_MAX_RUNNING_JOBS_PER_KEY',
      default: 0,
      description:
        "Jobs of one API key that run at the same time; that key's other jobs wait while other keys' jobs run. Off by default: jobs are always claimed fairly across keys (the key with the fewest running jobs first), so one key cannot starve others, and a single organisation key can still use every worker. Set it to reserve capacity. With several workers claiming at the same moment a key may briefly get one more. `0`: no limit.",
    }),
    maxEstimatedWaitSeconds: setting(z.number().int().min(0).max(86_400), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_MAX_ESTIMATED_WAIT_SECONDS',
      default: 0,
      description:
        'Admission control (D-103): refuse a new render or preview with `429 queue_full`, `Retry-After` and `details` (queued jobs ahead, estimated wait) when its estimated queue wait is longer than this. The estimate is measured, not configured: the smaller of how long the oldest queued job of the same or a higher priority has waited and the jobs ahead divided by the claim throughput of the last minutes (shared by every instance through the database). Checked in the same statement as the job caps. `0`: off.',
    }),
    maxRenderSeconds: setting(z.number().int().min(1).max(180), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_MAX_RENDER_SECONDS',
      default: 180,
      description: 'Longest render or preview, in seconds (the project schema allows at most 180). Longer projects are refused with `422 render_limit_exceeded`.',
    }),
    maxRenderFrames: setting(z.number().int().min(1).max(10_800), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_MAX_RENDER_FRAMES',
      default: 5400,
      description: 'Most frames in one render or preview (duration × fps; 5400 is 180 s at 30 fps or 90 s at 60 fps). Refused with `422 render_limit_exceeded`.',
    }),
    maxScenes: setting(z.number().int().min(1).max(50), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_MAX_SCENES',
      default: 50,
      description: 'Most scenes in one render (the project schema allows at most 50). Refused with `422 render_limit_exceeded`.',
    }),
    maxRenderDimension: setting(z.number().int().min(16).max(4096), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_MAX_RENDER_DIMENSION',
      default: 3840,
      description: 'Largest output width or height in pixels (3840 allows 4K in either orientation; the schema allows 4096). Refused with `422 render_limit_exceeded`.',
    }),
    maxRenderFps: setting(z.number().int().min(24).max(60), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_MAX_RENDER_FPS',
      default: 60,
      description: 'Highest output frame rate (supported: 24, 25, 30, 60). Refused with `422 render_limit_exceeded`.',
    }),
    providerRunsPerKeyPerDay: setting(nonNegative(), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_PROVIDER_RUNS_PER_KEY_PER_DAY',
      default: 500,
      description:
        'Provider calls (`run_provider`, `generate_voice`) one API key may make per UTC day; cached results do not count, failed calls do. Refused with `429 provider_limit_exceeded` until midnight UTC. Counted in the database across instances. `0`: no limit.',
    }),
    providerRunsPerDay: setting(nonNegative(), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_PROVIDER_RUNS_PER_DAY',
      default: 0,
      description:
        "Provider calls per UTC day for the whole server (every key and instance): a budget for the operator's own paid provider accounts. Off by default; set it from your provider plan (docs/security/HARDENING.md recommends one). Refused with `429 provider_budget_exhausted` until midnight UTC. `0`: no limit.",
    }),
  }),
  storage: z.object({
    dataDir: setting(nonEmpty(), {
      kind: 'path',
      scope: 'startup',
      env: 'REELFORGE_DATA_DIR',
      default: 'data',
      defaultText: '`./data` (`/data` in Docker)',
      description: 'Asset and render files, caches, the URL signing key, and the SQLite database by default.',
    }),
    cacheDir: setting(nonEmpty(), {
      kind: 'path',
      scope: 'startup',
      env: 'REELFORGE_CACHE_DIR',
      default: (get: Getter) => join(absolute(String(get('storage.dataDir'))), 'cache'),
      defaultText: '`<dataDir>/cache`',
      description: 'Engine bundle and provider result cache.',
    }),
    driver: setting(z.enum(['local', 's3', 'azure', 'gcs']), {
      kind: 'enum',
      scope: 'startup',
      env: 'REELFORGE_STORAGE_DRIVER',
      default: 'local',
      description:
        'Where asset and render files are kept (D-065): `local` (the data directory), `s3` (any S3-compatible API: AWS S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO, GCS with HMAC keys), `azure` (Azure Blob Storage) or `gcs` (Google Cloud Storage, native). Move existing files with `reelforge storage migrate --to <driver>`.',
    }),
    localShared: setting(z.boolean(), {
      kind: 'boolean',
      scope: 'startup',
      env: 'REELFORGE_STORAGE_LOCAL_SHARED',
      default: false,
      description:
        'Declare that the local data directory is ONE shared volume mounted by every instance (NFS, Amazon EFS, Azure Files, a ReadWriteMany PVC). Only then may the `api` and `worker` roles start with `storage.driver: local`; without it they refuse, because each instance would see only its own files.',
    }),
    downloads: setting(z.enum(['auto', 'presigned', 'proxy']), {
      kind: 'enum',
      scope: 'runtime',
      env: 'REELFORGE_STORAGE_DOWNLOADS',
      default: 'auto',
      description:
        'How `downloadUrl` links are made. `auto`/`presigned`: a time-limited URL signed by the bucket when the driver can sign (falls back to the server otherwise); `proxy`: always a signed link to this server, which streams the file (with Range support).',
    }),
    requestTimeoutSeconds: setting(z.number().int().min(1).max(3600), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_STORAGE_REQUEST_TIMEOUT_SECONDS',
      default: 120,
      description: 'Remote storage: a request whose connection stays silent this long (a stalled transfer) is aborted and retried. Not a limit on the total transfer time.',
    }),
    connectTimeoutSeconds: setting(z.number().int().min(1).max(300), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_STORAGE_CONNECT_TIMEOUT_SECONDS',
      default: 10,
      description: 'Remote storage: connection timeout in seconds.',
    }),
    maxAttempts: setting(z.number().int().min(1).max(10), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_STORAGE_MAX_ATTEMPTS',
      default: 4,
      description: 'Remote storage: attempts per request (the first plus retries with exponential backoff and jitter) on throttling, 5xx and network errors.',
    }),
    s3: z.object({
      bucket: setting(nonEmpty().optional(), { kind: 'string', scope: 'startup', env: 'REELFORGE_S3_BUCKET', description: 'Bucket (required for `s3`).' }),
      region: setting(nonEmpty().optional(), {
        kind: 'string',
        scope: 'startup',
        env: 'REELFORGE_S3_REGION',
        defaultText: '`us-east-1`',
        description: 'Region (`auto` for Cloudflare R2; any value for MinIO).',
      }),
      endpoint: setting(httpUrl().optional(), {
        kind: 'url',
        scope: 'startup',
        env: 'REELFORGE_S3_ENDPOINT',
        example: 'https://<account>.r2.cloudflarestorage.com',
        description: 'S3-compatible endpoint (R2, B2, Wasabi, Spaces, MinIO, `https://storage.googleapis.com` for GCS interop). Empty for AWS.',
      }),
      publicEndpoint: setting(httpUrl().optional(), {
        kind: 'url',
        scope: 'startup',
        env: 'REELFORGE_S3_PUBLIC_ENDPOINT',
        description: 'Endpoint used only in signed download URLs, when clients reach the bucket under another name than the server does. Default: `endpoint`.',
      }),
      forcePathStyle: setting(z.boolean(), {
        kind: 'boolean',
        scope: 'startup',
        env: 'REELFORGE_S3_FORCE_PATH_STYLE',
        default: false,
        description: 'Path-style URLs (`https://host/bucket/key`); needed for MinIO and most self-hosted endpoints.',
      }),
      serverSideEncryption: setting(z.enum(['AES256', 'aws:kms', 'aws:kms:dsse']).optional(), {
        kind: 'enum',
        scope: 'startup',
        env: 'REELFORGE_S3_SSE',
        description: 'Server-side encryption sent with every write: `AES256` (SSE-S3), `aws:kms` (SSE-KMS) or `aws:kms:dsse`. Unset: the bucket default. Not every S3-compatible service supports KMS.',
      }),
      kmsKeyId: setting(nonEmpty().optional(), {
        kind: 'string',
        scope: 'startup',
        env: 'REELFORGE_S3_KMS_KEY_ID',
        description: 'KMS key id or ARN for `aws:kms` / `aws:kms:dsse` (optional: the account\'s AWS managed key otherwise).',
      }),
      prefix: setting(nonEmpty().optional(), { kind: 'string', scope: 'startup', env: 'REELFORGE_S3_PREFIX', example: 'studio', description: 'Key prefix inside the bucket (share a bucket).' }),
      accessKeyId: setting(nonEmpty().optional(), {
        kind: 'string',
        scope: 'runtime',
        env: 'REELFORGE_S3_ACCESS_KEY_ID',
        secret: true,
        description: 'Access key id. Leave unset to use the ambient identity (IAM role, IRSA / web identity, `AWS_*` variables).',
      }),
      secretAccessKey: setting(nonEmpty().optional(), {
        kind: 'string',
        scope: 'runtime',
        env: 'REELFORGE_S3_SECRET_ACCESS_KEY',
        secret: true,
        description: 'Secret access key (with `accessKeyId`).',
      }),
      sessionToken: setting(nonEmpty().optional(), {
        kind: 'string',
        scope: 'runtime',
        env: 'REELFORGE_S3_SESSION_TOKEN',
        secret: true,
        description: 'Session token for temporary keys (optional).',
      }),
    }),
    azure: z.object({
      container: setting(nonEmpty().optional(), { kind: 'string', scope: 'startup', env: 'REELFORGE_AZURE_STORAGE_CONTAINER', description: 'Blob container (required for `azure`).' }),
      connectionString: setting(nonEmpty().optional(), {
        kind: 'string',
        scope: 'runtime',
        env: 'REELFORGE_AZURE_STORAGE_CONNECTION_STRING',
        aliases: ['AZURE_STORAGE_CONNECTION_STRING'],
        secret: true,
        description: 'Connection string (with an account key for signed URLs). Leave unset to use managed identity with `accountUrl`.',
      }),
      accountUrl: setting(httpUrl().optional(), {
        kind: 'url',
        scope: 'startup',
        env: 'REELFORGE_AZURE_STORAGE_ACCOUNT_URL',
        example: 'https://<account>.blob.core.windows.net',
        description: 'Account URL, used with the ambient identity (managed identity, workload identity) when there is no connection string.',
      }),
      managedIdentityClientId: setting(nonEmpty().optional(), {
        kind: 'string',
        scope: 'startup',
        env: 'REELFORGE_AZURE_MANAGED_IDENTITY_CLIENT_ID',
        description: 'Client id of a user-assigned managed identity (optional).',
      }),
      prefix: setting(nonEmpty().optional(), { kind: 'string', scope: 'startup', env: 'REELFORGE_AZURE_STORAGE_PREFIX', description: 'Blob name prefix inside the container.' }),
      encryptionScope: setting(nonEmpty().optional(), {
        kind: 'string',
        scope: 'startup',
        env: 'REELFORGE_AZURE_STORAGE_ENCRYPTION_SCOPE',
        description: 'Encryption scope for every write (customer-managed keys). Unset: the container default.',
      }),
    }),
    gcs: z.object({
      bucket: setting(nonEmpty().optional(), { kind: 'string', scope: 'startup', env: 'REELFORGE_GCS_BUCKET', description: 'Bucket (required for `gcs`).' }),
      projectId: setting(nonEmpty().optional(), { kind: 'string', scope: 'startup', env: 'REELFORGE_GCS_PROJECT_ID', description: 'Google Cloud project (optional; detected from the credentials).' }),
      prefix: setting(nonEmpty().optional(), { kind: 'string', scope: 'startup', env: 'REELFORGE_GCS_PREFIX', description: 'Object name prefix inside the bucket.' }),
      kmsKeyName: setting(nonEmpty().optional(), {
        kind: 'string',
        scope: 'startup',
        env: 'REELFORGE_GCS_KMS_KEY_NAME',
        example: 'projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>',
        description: 'Cloud KMS key for every write (CMEK). Unset: the bucket default.',
      }),
      credentialsJson: setting(nonEmpty().optional(), {
        kind: 'string',
        scope: 'runtime',
        env: 'REELFORGE_GCS_CREDENTIALS_JSON',
        secret: true,
        description: 'Service-account key (the JSON file\'s contents; `_FILE` takes the file). Leave unset to use workload identity / Application Default Credentials.',
      }),
      apiEndpoint: setting(httpUrl().optional(), { kind: 'url', scope: 'startup', env: 'REELFORGE_GCS_API_ENDPOINT', description: 'Another API endpoint (an emulator); empty for Google Cloud.' }),
    }),
    retention: z.object({
      renderDays: setting(z.number().int().min(0).max(36500), {
        kind: 'integer',
        scope: 'runtime',
        env: 'REELFORGE_STORAGE_RETENTION_RENDER_DAYS',
        default: 0,
        description: 'Delete renders and previews older than this many days (`0`: keep). The newest `keepLastRendersPerProject` of each project are always kept (D-068).',
      }),
      keepLastRendersPerProject: setting(z.number().int().min(0).max(10000), {
        kind: 'integer',
        scope: 'runtime',
        env: 'REELFORGE_STORAGE_RETENTION_KEEP_LAST',
        default: 0,
        description: 'Always keep the newest N renders of each project (`0`: no minimum). Without `renderDays`, everything older than the newest N is deleted.',
      }),
      tempHours: setting(z.number().int().min(1).max(8760), {
        kind: 'integer',
        scope: 'runtime',
        env: 'REELFORGE_STORAGE_RETENTION_TEMP_HOURS',
        default: 24,
        description: 'Remove unfinished render uploads and staging directories (crashed or killed renders) older than this many hours.',
      }),
      cacheDays: setting(z.number().int().min(0).max(3650), {
        kind: 'integer',
        scope: 'runtime',
        env: 'REELFORGE_STORAGE_RETENTION_CACHE_DAYS',
        default: 30,
        description: 'Remove local copies of remote assets and renders (`<cacheDir>/storage`) unused for this many days (`0`: keep).',
      }),
      sweepIntervalMinutes: setting(z.number().int().min(0).max(10080), {
        kind: 'integer',
        scope: 'runtime',
        env: 'REELFORGE_STORAGE_SWEEP_INTERVAL_MINUTES',
        default: 60,
        description: 'Run the storage cleanup on this schedule (`0`: only on demand with `run_storage_cleanup` / `POST /v1/storage/cleanup`).',
      }),
    }),
  }),
  database: z.object({
    url: setting(nonEmpty(), {
      kind: 'string',
      scope: 'startup',
      env: 'REELFORGE_DATABASE_URL',
      aliases: ['DATABASE_URL'],
      secret: true,
      default: (get: Getter) => `file:${join(absolute(String(get('storage.dataDir'))), 'reelforge.db')}`,
      defaultText: '`file:<dataDir>/reelforge.db` (SQLite)',
      example: 'postgresql://reelforge:<password>@db:5432/reelforge',
      description: 'Database: `file:` (SQLite), `postgresql://...`, `mysql://...` or `mariadb://...`. Secret because the URL usually holds a password.',
    }),
    readUrl: setting(nonEmpty().optional(), {
      kind: 'string',
      scope: 'startup',
      env: 'REELFORGE_DATABASE_READ_URL',
      aliases: ['DATABASE_READ_URL'],
      secret: true,
      example: 'postgresql://reelforge:<password>@db-replica:5432/reelforge',
      description:
        'A read replica of `database.url` (PostgreSQL or MySQL; refused with SQLite) for the list reads that tolerate lag: list_projects, list_project_versions, list_jobs, list_assets, list_themes, list_audit_events and audit exports. Job state, claims, quotas, rate limits, keys, licence, idempotency and every read-then-write stay on `database.url`. Unset: everything uses `database.url`. Never migrated. See docs/providers/queue-and-scaling.md#read-replica.',
    }),
    workerConnectionLimit: setting(nonNegative(), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_DB_WORKER_CONNECTION_LIMIT',
      default: 3,
      description:
        'Pool size of a `worker` role process when its database URL has no `?connection_limit=` (claims, heartbeats and progress need few connections; hundreds of workers at the drivers\' default of 10 each would exhaust the database). `0`: the driver default (10). Other roles keep the driver default. Sizing: docs/providers/queue-and-scaling.md#connection-pooling.',
    }),
    directUrl: setting(nonEmpty().optional(), {
      kind: 'string',
      scope: 'startup',
      env: 'REELFORGE_DATABASE_DIRECT_URL',
      aliases: ['DATABASE_DIRECT_URL'],
      secret: true,
      defaultText: '`database.url`',
      example: 'postgresql://reelforge:<password>@db:5432/reelforge',
      description:
        'A direct session connection to the PostgreSQL server, for what a transaction-mode pooler cannot carry. Today: the `LISTEN` connection of `queue.dispatch` `notify` (one per worker). Required when `database.url` goes through PgBouncer in transaction or statement mode (or a similar pooler); the queries keep using `database.url`. Unset: `database.url`. Secret because the URL usually holds a password.',
    }),
    migrateOnStart: setting(z.boolean(), {
      kind: 'boolean',
      scope: 'startup',
      env: 'REELFORGE_MIGRATE_ON_START',
      default: true,
      description: 'Apply pending migrations on start. Off: refuse to start while migrations are pending (run `reelforge migrate`).',
    }),
    connectTimeoutSeconds: setting(nonNegative(), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_DB_CONNECT_TIMEOUT_SECONDS',
      default: 30,
      description: 'Keep retrying the first database connection this long (a database container may still be starting).',
    }),
  }),
  security: z.object({
    secretKey: setting(z.string().min(32, 'must be at least 32 characters (e.g. `openssl rand -base64 32`)').optional(), {
      kind: 'string',
      scope: 'startup',
      env: 'REELFORGE_SECRET_KEY',
      secret: true,
      description:
        'Encrypts secrets stored in the database (provider keys, licence key) with AES-256-GCM and keys the integrity seal of the stored licence state. At least 32 characters: `openssl rand -base64 32`. **Required by the release edition**: it does not start without it (#305). A dev build without it refuses to store secrets and seals the licence state with a random key in `<dataDir>/licence-seal.key` (instances sharing a database then need the same secret key). Keep it safe: losing it makes stored secrets unreadable.',
    }),
    bootstrapKey: setting(
      z
        .string()
        .max(200)
        .superRefine((v, ctx) => {
          const why = weakKeyReason(v);
          if (why) ctx.addIssue({ code: 'custom', message: why });
        })
        .optional(),
      {
        kind: 'string',
        scope: 'startup',
        env: 'REELFORGE_BOOTSTRAP_KEY',
        secret: true,
        description:
          'First admin API key: `rf_` + at least 32 random URL-safe characters (`rf_$(openssl rand -hex 24)`); low-entropy values are refused. Stored hashed as key "bootstrap" on start if no key exists.',
      }
    ),
    // MCP authorization (#305, D-112): OAuth 2.1 access tokens on /mcp next to API keys.
    oauth: z.object({
      issuer: setting(z.string().regex(/^https?:\/\/[^\s/]+(\/[^\s]*)?$/, 'must start with https:// (http:// only for a local test issuer)').optional(), {
        kind: 'url',
        scope: 'startup',
        env: 'REELFORGE_MCP_OAUTH_ISSUER',
        example: 'https://auth.example.com/realms/studio',
        description:
          'Turns on OAuth for `/mcp`: the issuer identifier of your authorization server, exactly as in its tokens\' `iss` (trailing slash included). `/mcp` then also accepts its JWT access tokens (asymmetric signatures, keys from its JWKS) with `reelforge:read`, `reelforge:write`, `reelforge:render` or `reelforge:admin` in `scope`/`scp`, and serves `/.well-known/oauth-protected-resource`. API keys keep working. Unset: API keys only.',
      }),
      audience: setting(httpUrl().optional(), {
        kind: 'url',
        scope: 'startup',
        env: 'REELFORGE_MCP_OAUTH_AUDIENCE',
        example: 'https://studio.example.com/mcp',
        description: 'What a token\'s `aud` must contain: this server\'s MCP URL (RFC 8707 resource indicator). Default: `server.publicUrl` + `/mcp` (one of them is required with an issuer).',
      }),
      jwksUrl: setting(httpUrl().optional(), {
        kind: 'url',
        scope: 'startup',
        env: 'REELFORGE_MCP_OAUTH_JWKS_URL',
        description: 'The issuer\'s JWKS. Default: `jwks_uri` from its metadata (`/.well-known/oauth-authorization-server`, then OpenID discovery).',
      }),
    }),
  }),
  audit: z.object({
    retentionDays: setting(z.number().int().min(0).max(36500), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_AUDIT_RETENTION_DAYS',
      default: 365,
      description: 'Days audit entries are kept in the database; older ones are deleted by the hourly sweep. `0` keeps them forever.',
    }),
    sinks: setting(z.array(z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, 'a sink id such as stdout or otlp')).max(10), {
      kind: 'list',
      scope: 'runtime',
      env: 'REELFORGE_AUDIT_SINKS',
      default: [],
      example: 'stdout,otlp',
      description:
        'Where audit entries go besides the database (always on): `stdout` (one JSON line per entry, `{"type":"audit",...}`), `otlp` (OTLP/HTTP logs to `audit.otlpEndpoint`), or the id of a sink plugin. Several at once; comma-separated in the environment.',
    }),
    otlpEndpoint: setting(httpUrl().optional(), {
      kind: 'url',
      scope: 'runtime',
      env: 'REELFORGE_AUDIT_OTLP_ENDPOINT',
      example: 'http://otel-collector:4318/v1/logs',
      description: 'OTLP/HTTP logs endpoint for the `otlp` audit sink (JSON encoding). Sends audit entries to that host only when `otlp` is in `audit.sinks` (docs/PRIVACY.md).',
    }),
  }),
  keys: z.object({
    rotationGraceHours: setting(z.number().int().min(0).max(720), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_KEY_ROTATION_GRACE_HOURS',
      default: 24,
      description: 'After `rotate_key`, the old secret keeps working this many hours so clients can switch. `0` ends it at once; a rotation may pass its own `graceHours`.',
    }),
  }),
  idempotency: z.object({
    ttlHours: setting(z.number().int().min(1).max(168), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_IDEMPOTENCY_TTL_HOURS',
      default: 24,
      description: 'How long an `Idempotency-Key` (REST) / `idempotencyKey` (MCP) and its stored result are kept; expired ones are swept hourly.',
    }),
  }),
  webhooks: z.object({
    allowPrivateNetworks: setting(z.boolean(), {
      kind: 'boolean',
      scope: 'startup',
      env: 'REELFORGE_WEBHOOKS_ALLOW_PRIVATE_NETWORKS',
      default: false,
      description:
        'Let webhook and chat endpoints reach loopback, private (RFC 1918), link-local, CGNAT and other non-public addresses. Off by default (SSRF guard, checked when connecting). Start-up only: it can never be turned on over the API.',
    }),
    allowHttp: setting(z.boolean(), {
      kind: 'boolean',
      scope: 'startup',
      env: 'REELFORGE_WEBHOOKS_ALLOW_HTTP',
      default: false,
      description: 'Allow `http://` endpoint URLs (payloads and signatures then travel unencrypted). Off by default; start-up only.',
    }),
    timeoutSeconds: setting(z.number().int().min(1).max(60), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_WEBHOOKS_TIMEOUT_SECONDS',
      default: 10,
      description: 'Longest time one delivery attempt may take (connect, send, answer); then it counts as failed and is retried.',
    }),
    maxAttempts: setting(z.number().int().min(1).max(30), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_WEBHOOKS_MAX_ATTEMPTS',
      default: 20,
      description:
        'Attempts per delivery before it becomes dead (failed for good; the dead letter queue, sent again with `resend_webhook`). With the default backoff the retry window ends first (about 15 attempts in 24 hours).',
    }),
    retryWindowHours: setting(z.number().int().min(1).max(168), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_WEBHOOKS_RETRY_WINDOW_HOURS',
      default: 24,
      description:
        'How long a delivery is retried after it was queued; the last attempt lands on the end of the window, then the delivery is dead (failed for good). A resend starts a new window.',
    }),
    retryBaseSeconds: setting(z.number().int().min(1).max(3600), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_WEBHOOKS_RETRY_BASE_SECONDS',
      default: 30,
      description: "Delay after the first failed attempt; it doubles after each further one (±20 % jitter, at least the receiver's `Retry-After`).",
    }),
    retryMaxDelaySeconds: setting(z.number().int().min(1).max(86400), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_WEBHOOKS_RETRY_MAX_DELAY_SECONDS',
      default: 14400,
      description: 'Longest delay between two attempts (default 4 hours).',
    }),
    secretRotationGraceHours: setting(z.number().int().min(0).max(720), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_WEBHOOKS_SECRET_ROTATION_GRACE_HOURS',
      default: 24,
      description: 'After `update_webhook { rotateSecret: true }`, messages carry signatures with the new and the old secret for this many hours so receivers can switch.',
    }),
    deliveryRetentionDays: setting(z.number().int().min(0).max(3650), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_WEBHOOKS_DELIVERY_RETENTION_DAYS',
      default: 30,
      description: 'Days finished deliveries (succeeded or dead) and their attempt log are kept; the hourly sweep deletes older ones. `0` keeps them forever.',
    }),
  }),
  notifications: z.object({
    email: z.object({
      from: setting(z.string().min(3).max(320).optional(), {
        kind: 'string',
        scope: 'runtime',
        env: 'REELFORGE_EMAIL_FROM',
        example: 'ReelForge <studio@example.com>',
        description: 'Sender of notification emails (every email provider needs it; Resend, Postmark, SES and SendGrid only send from verified senders).',
      }),
      smtp: z.object({
        host: setting(nonEmpty().optional(), { kind: 'string', scope: 'runtime', env: 'REELFORGE_SMTP_HOST', example: 'smtp.example.com', description: 'SMTP server for email channels with provider `smtp`.' }),
        port: setting(port(), { kind: 'integer', scope: 'runtime', env: 'REELFORGE_SMTP_PORT', default: 587, description: 'SMTP port (587 submission with STARTTLS, 465 implicit TLS, 25 or 1025 for a local relay or Mailpit).' }),
        security: setting(z.enum(['starttls', 'tls', 'none']), {
          kind: 'enum',
          scope: 'runtime',
          env: 'REELFORGE_SMTP_SECURITY',
          default: 'starttls',
          description: '`starttls` (upgrade required), `tls` (implicit TLS, port 465) or `none` (plain text; local relays and Mailpit only).',
        }),
        user: setting(nonEmpty().optional(), { kind: 'string', scope: 'runtime', env: 'REELFORGE_SMTP_USER', description: 'SMTP user name (optional).' }),
        password: setting(nonEmpty().optional(), { kind: 'string', scope: 'runtime', env: 'REELFORGE_SMTP_PASSWORD', secret: true, description: 'SMTP password.' }),
      }),
      resend: z.object({
        apiKey: setting(nonEmpty().optional(), { kind: 'string', scope: 'runtime', env: 'REELFORGE_RESEND_API_KEY', secret: true, description: 'Resend API key (sending access) for email channels with provider `resend`.' }),
        baseUrl: setting(httpUrl(), { kind: 'url', scope: 'startup', env: 'REELFORGE_RESEND_BASE_URL', default: 'https://api.resend.com', description: 'Resend API base URL (change only for a test stub).' }),
      }),
      postmark: z.object({
        serverToken: setting(nonEmpty().optional(), { kind: 'string', scope: 'runtime', env: 'REELFORGE_POSTMARK_SERVER_TOKEN', secret: true, description: 'Postmark server API token for email channels with provider `postmark`.' }),
        messageStream: setting(nonEmpty(), { kind: 'string', scope: 'runtime', env: 'REELFORGE_POSTMARK_MESSAGE_STREAM', default: 'outbound', description: 'Postmark message stream (transactional).' }),
        baseUrl: setting(httpUrl(), { kind: 'url', scope: 'startup', env: 'REELFORGE_POSTMARK_BASE_URL', default: 'https://api.postmarkapp.com', description: 'Postmark API base URL (change only for a test stub).' }),
      }),
      sendgrid: z.object({
        apiKey: setting(nonEmpty().optional(), { kind: 'string', scope: 'runtime', env: 'REELFORGE_SENDGRID_API_KEY', secret: true, description: 'SendGrid API key (Mail Send permission) for email channels with provider `sendgrid`.' }),
        baseUrl: setting(httpUrl(), { kind: 'url', scope: 'startup', env: 'REELFORGE_SENDGRID_BASE_URL', default: 'https://api.sendgrid.com', description: 'SendGrid API base URL (`https://api.eu.sendgrid.com` for EU data residency, or a test stub).' }),
      }),
      ses: z.object({
        region: setting(nonEmpty().optional(), { kind: 'string', scope: 'runtime', env: 'REELFORGE_SES_REGION', example: 'eu-west-1', description: 'Amazon SES region for email channels with provider `ses`.' }),
        accessKeyId: setting(nonEmpty().optional(), {
          kind: 'string',
          scope: 'runtime',
          env: 'REELFORGE_SES_ACCESS_KEY_ID',
          secret: true,
          description: 'Access key id with `ses:SendEmail`. Leave unset to use the ambient AWS identity (IAM role, IRSA, `AWS_*` variables).',
        }),
        secretAccessKey: setting(nonEmpty().optional(), { kind: 'string', scope: 'runtime', env: 'REELFORGE_SES_SECRET_ACCESS_KEY', secret: true, description: 'Secret access key (with `accessKeyId`).' }),
        sessionToken: setting(nonEmpty().optional(), { kind: 'string', scope: 'runtime', env: 'REELFORGE_SES_SESSION_TOKEN', secret: true, description: 'Session token for temporary keys (optional).' }),
        endpoint: setting(httpUrl().optional(), { kind: 'url', scope: 'startup', env: 'REELFORGE_SES_ENDPOINT', description: 'SES API endpoint override (VPC endpoint, or a test stub). Empty: the regional AWS endpoint.' }),
      }),
    }),
  }),
  render: z.object({
    chromiumPath: setting(nonEmpty().optional(), {
      kind: 'path',
      scope: 'startup',
      env: 'REELFORGE_CHROMIUM_PATH',
      processEnv: 'REELFORGE_CHROMIUM_PATH',
      defaultText: '(none; set in Docker)',
      description: 'Chrome Headless Shell binary used by every engine.',
    }),
    chromiumNoSandbox: setting(z.boolean(), {
      kind: 'boolean',
      scope: 'startup',
      env: 'REELFORGE_CHROMIUM_NO_SANDBOX',
      processEnv: 'REELFORGE_CHROMIUM_NO_SANDBOX',
      default: false,
      description:
        "`true` turns Chromium's own sandbox off. The sandbox is on by default everywhere, the release image included (run it with `deployment/seccomp/chrome.json`, docs/security/HARDENING.md). `true` is an explicit opt-out: it is logged at start and reported in `get_capabilities` and `/readyz`.",
    }),
    sceneTimeoutSeconds: setting(z.number().int().min(30).max(3600), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_RENDER_SCENE_TIMEOUT_SECONDS',
      processEnv: 'REELFORGE_RENDER_SCENE_TIMEOUT_SECONDS',
      default: 900,
      description:
        'Hard limit for rendering one html or hyperframes scene, whatever its length (engines use their per-frame estimate when it is shorter). 30 to 3600 seconds.',
    }),
    timeoutSeconds: setting(z.number().int().min(0).max(86400), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_RENDER_TIMEOUT_SECONDS',
      default: 3600,
      description:
        'Longest time one render or preview job (or one unit or join of a fanned-out render) may run on a worker; then it is stopped and fails with `render_timeout` (the `render.timeout` event). `0`: no limit. Read when the job starts.',
    }),
    fanOut: setting(z.enum(['off', 'scenes', 'scenes+chunks']), {
      kind: 'enum',
      scope: 'runtime',
      env: 'REELFORGE_RENDER_FAN_OUT',
      default: 'off',
      description:
        'Split one render across workers (D-097, docs/providers/queue-and-scaling.md#render-fan-out). `off`: one worker renders every scene and assembles the video (the default; unchanged behaviour). `scenes`: with the database queue, a `render` of the `local` backend with two or more scenes becomes one `render_unit` job per scene, claimed by any worker, and one `render_join` job that assembles and commits the video; previews and the in-process queue always use one worker. `scenes+chunks`: as `scenes`, and a scene of at least `render.chunkMinSceneSeconds` whose engine renders frame ranges (Remotion; not html, Motion Canvas or HyperFrames) is split into chunks of `render.chunkSeconds`, one unit each, so one long scene no longer bounds the render\'s latency.',
    }),
    chunkSeconds: setting(z.number().min(1).max(600), {
      kind: 'number',
      scope: 'runtime',
      env: 'REELFORGE_RENDER_CHUNK_SECONDS',
      default: 4,
      description:
        'With `render.fanOut: scenes+chunks`: length of one chunk of a split scene, in seconds of video (1 to 600). The last chunk takes the rest: it is shorter, or up to half a chunk longer when the rest would be under half a chunk. Shorter chunks spread a scene over more workers; each chunk pays a browser start and an encode of its own.',
    }),
    chunkMinSceneSeconds: setting(z.number().min(2).max(3600), {
      kind: 'number',
      scope: 'runtime',
      env: 'REELFORGE_RENDER_CHUNK_MIN_SCENE_SECONDS',
      default: 8,
      description:
        'With `render.fanOut: scenes+chunks`: scenes shorter than this (seconds, 2 to 3600) are never split and render as one unit.',
    }),
    audio: z.object({
      loudness: setting(z.enum(['social', 'broadcast-ebu', 'broadcast-atsc', 'podcast', 'off']), {
        kind: 'enum',
        scope: 'runtime',
        env: 'REELFORGE_RENDER_AUDIO_LOUDNESS',
        default: 'social',
        description:
          'Loudness preset of renders whose manifest sets no `audio.loudness` and whose `render_project` call passes none (#301, docs/public/manifest/audio.md). `social`: -14 LUFS, true peak -2 dBTP; `broadcast-ebu`: EBU R 128, -23 LUFS, -1 dBTP; `broadcast-atsc`: ATSC A/85, -24 LKFS, -2 dBTP; `podcast`: -16 LUFS, -1 dBTP; `off`: the mix as it is. Two-pass FFmpeg loudnorm, measured again after the AAC encode.',
      }),
      loudnessQa: setting(z.enum(['warn', 'fail']), {
        kind: 'enum',
        scope: 'runtime',
        env: 'REELFORGE_RENDER_AUDIO_LOUDNESS_QA',
        default: 'warn',
        description:
          'What a render does when the finished file misses its loudness target (integrated loudness more than 1 LU off, or the true peak over the ceiling): `warn` records it in the render manifest (`audio.qa`) and `get_render_output`; `fail` fails the render.',
      }),
      mutedTrack: setting(z.enum(['silent', 'none']), {
        kind: 'enum',
        scope: 'runtime',
        env: 'REELFORGE_RENDER_AUDIO_MUTED_TRACK',
        default: 'silent',
        description:
          'What a muted render (`audio.mute`) carries: `silent`, a valid silent AAC track (safest: some players and upload pipelines expect an audio stream); `none`, no audio stream at all.',
      }),
    }),
    ffmpegPath: setting(nonEmpty(), {
      kind: 'path',
      scope: 'startup',
      env: 'REELFORGE_FFMPEG_PATH',
      aliases: ['FFMPEG_PATH'],
      processEnv: 'FFMPEG_PATH',
      default: 'ffmpeg',
      defaultText: '`ffmpeg` on PATH',
      description: 'FFmpeg binary (system build; 6.1 and 5.1.9 tested).',
    }),
    ffprobePath: setting(nonEmpty(), {
      kind: 'path',
      scope: 'startup',
      env: 'REELFORGE_FFPROBE_PATH',
      aliases: ['FFPROBE_PATH'],
      processEnv: 'FFPROBE_PATH',
      default: 'ffprobe',
      defaultText: '`ffprobe` on PATH',
      description: 'ffprobe binary.',
    }),
    backends: z.object({
      remotionLambda: z.object({
        region: setting(nonEmpty().optional(), {
          kind: 'string',
          scope: 'runtime',
          env: 'REELFORGE_REMOTION_LAMBDA_REGION',
          aliases: ['REMOTION_LAMBDA_REGION'],
          providerEnv: 'REMOTION_LAMBDA_REGION',
          description: 'AWS region of your Remotion Lambda deployment (backend `remotion-lambda`, not implemented yet: configuration check only).',
        }),
        functionName: setting(nonEmpty().optional(), {
          kind: 'string',
          scope: 'runtime',
          env: 'REELFORGE_REMOTION_LAMBDA_FUNCTION_NAME',
          aliases: ['REMOTION_LAMBDA_FUNCTION_NAME'],
          providerEnv: 'REMOTION_LAMBDA_FUNCTION_NAME',
          description: 'Remotion Lambda function name.',
        }),
        serveUrl: setting(httpUrl().optional(), {
          kind: 'url',
          scope: 'runtime',
          env: 'REELFORGE_REMOTION_LAMBDA_SERVE_URL',
          aliases: ['REMOTION_LAMBDA_SERVE_URL'],
          providerEnv: 'REMOTION_LAMBDA_SERVE_URL',
          description: 'Remotion Lambda serve URL (the deployed site).',
        }),
      }),
    }),
  }),
  providers: z.object({
    elevenlabs: z.object({
      apiKey: setting(z.string().min(1).max(1000).regex(/^[^\r\n]*$/, 'must be a single line').optional(), {
        kind: 'string',
        scope: 'runtime',
        env: 'REELFORGE_ELEVENLABS_API_KEY',
        aliases: ['ELEVENLABS_API_KEY'],
        secret: true,
        providerEnv: 'ELEVENLABS_API_KEY',
        description: 'Enables the ElevenLabs TTS provider. Same setting as `configure_provider` / `PUT /v1/providers/elevenlabs/config`; stored encrypted when set at runtime.',
      }),
    }),
  }),
  captions: z.object({
    defaultMode: setting(z.enum(['off', 'burned', 'sidecar', 'both']), {
      kind: 'enum',
      scope: 'runtime',
      env: 'REELFORGE_CAPTIONS_DEFAULT_MODE',
      default: 'off',
      description:
        'Captions for projects that do not set `captions.mode` (docs/CAPTIONS.md): `off` (the default; projects render as before), `burned` into the video, `sidecar` files (SRT, WebVTT, ASS) next to final.mp4, or `both`. A project\'s `captions.mode` and render_project\'s `captions` override it.',
    }),
    stt: z.object({
      provider: setting(z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'a provider id such as faster-whisper'), {
        kind: 'string',
        scope: 'runtime',
        env: 'REELFORGE_STT_PROVIDER',
        default: 'faster-whisper',
        description: 'Speech-to-text provider used by `transcribe_captions` (get_capabilities `captions.stt` lists the installed ones and whether each can run here).',
      }),
      command: setting(
        z
          .string()
          .min(1)
          .max(1024)
          .refine((v) => /^[A-Za-z0-9._+-]+$/.test(v) || (v.startsWith('/') && !v.includes('\0') && !/[\r\n]/.test(v)), 'a command name on PATH (letters, digits, . _ + -) or an absolute path'),
        {
          kind: 'path',
          scope: 'runtime',
          env: 'REELFORGE_STT_COMMAND',
          default: 'reelforge-whisper',
          description:
            'The local speech-to-text program: a name looked up on PATH or an absolute path. It is started directly (never through a shell) with a fixed argument list and no network access is needed (deployment/stt/README.md). The default `reelforge-whisper` is installed by the optional speech-to-text image layer; without it speech-to-text is off and get_capabilities says so. Admin-only like every setting, and audit-logged.',
        }
      ),
      model: setting(z.string().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/, 'a model name such as small or a directory path'), {
        kind: 'string',
        scope: 'runtime',
        env: 'REELFORGE_STT_MODEL',
        default: 'small',
        description:
          'Whisper model: a name (tiny, base, small, medium, large-v3, distil-large-v3, ... and the .en variants) that must already be downloaded into `captions.stt.modelDir`, or the path of a converted model directory. Models are never downloaded at run time.',
      }),
      modelDir: setting(nonEmpty().max(1024).optional(), {
        kind: 'path',
        scope: 'runtime',
        env: 'REELFORGE_STT_MODEL_DIR',
        defaultText: '(the Hugging Face cache of the server user)',
        description: 'Directory the models were pre-downloaded into (the image layer uses `/opt/reelforge/whisper-models`).',
      }),
      language: setting(
        z
          .string()
          .min(2)
          .max(35)
          .refine((v) => v === 'auto' || isLanguageTag(v), '"auto" or a BCP 47 language tag such as en or pt-BR'),
        {
          kind: 'string',
          scope: 'runtime',
          env: 'REELFORGE_STT_LANGUAGE',
          default: 'auto',
          description: 'Spoken language of voice-overs: `auto` detects it, or a BCP 47 tag (its primary subtag is passed to Whisper, e.g. `pt` for `pt-BR`). `transcribe_captions` can pass one per call.',
        }
      ),
      computeType: setting(z.enum(['default', 'auto', 'int8', 'int8_float32', 'int8_float16', 'int8_bfloat16', 'int16', 'float16', 'bfloat16', 'float32']), {
        kind: 'enum',
        scope: 'runtime',
        env: 'REELFORGE_STT_COMPUTE_TYPE',
        default: 'int8',
        description: 'CTranslate2 compute type: `int8` is fast on a CPU; `float16` needs a GPU.',
      }),
      device: setting(z.enum(['cpu', 'cuda', 'auto']), {
        kind: 'enum',
        scope: 'runtime',
        env: 'REELFORGE_STT_DEVICE',
        default: 'cpu',
        description: '`cpu`, `cuda` (an NVIDIA GPU with CUDA libraries in the image) or `auto`.',
      }),
      timeoutSeconds: setting(z.number().int().min(10).max(3600), {
        kind: 'integer',
        scope: 'runtime',
        env: 'REELFORGE_STT_TIMEOUT_SECONDS',
        default: 600,
        description: 'Longest one transcription may run (10 to 3600 seconds); the process is killed after it.',
      }),
    }),
  }),
  logging: z.object({
    level: setting(z.enum(['debug', 'info', 'warn', 'error']), {
      kind: 'enum',
      scope: 'runtime',
      env: 'REELFORGE_LOG_LEVEL',
      default: 'info',
      description: 'Server log level.',
    }),
    format: setting(z.enum(['text', 'json']), {
      kind: 'enum',
      scope: 'startup',
      env: 'REELFORGE_LOG_FORMAT',
      default: 'json',
      description:
        'Older name for the stdout log format, kept for existing deployments: `text` selects `observability.logs.exporter: pretty` when that is not set. Prefer `observability.logs.exporter`.',
    }),
  }),
  observability: z.object({
    serviceName: setting(z.string().min(1).max(100).regex(/^[\w.-]+$/, 'letters, digits, ".", "_" and "-" only'), {
      kind: 'string',
      scope: 'startup',
      env: 'REELFORGE_OTEL_SERVICE_NAME',
      aliases: ['OTEL_SERVICE_NAME'],
      default: 'reelforge-studio',
      description: 'OpenTelemetry `service.name` of traces, metrics and logs (also `service.version` and `reelforge.edition` are sent).',
    }),
    logs: z.object({
      exporter: setting(z.enum(['stdout', 'pretty', 'otlp']), {
        kind: 'enum',
        scope: 'runtime',
        env: 'REELFORGE_LOGS_EXPORTER',
        default: (get: Getter) => (get('logging.format') === 'text' ? 'pretty' : 'stdout'),
        defaultText: '`stdout` (`pretty` when `logging.format` is `text`)',
        description:
          '`stdout`: one JSON object per line (request id, key id, route, status, duration; secrets redacted). `pretty`: readable `[reelforge] ...` lines for development. `otlp`: JSON lines on stdout and OpenTelemetry log records to `observability.otlp.endpoint` (Grafana Loki, Datadog, Honeycomb, Elastic, ...).',
      }),
    }),
    metrics: z.object({
      exporter: setting(z.enum(['prometheus', 'otlp', 'off']), {
        kind: 'enum',
        scope: 'runtime',
        env: 'REELFORGE_METRICS_EXPORTER',
        default: 'prometheus',
        description: '`prometheus`: text format on `GET /metrics` for scraping. `otlp`: pushed to `observability.otlp.endpoint` every `observability.metrics.exportIntervalSeconds`. `off`: neither (`/metrics` answers 404).',
      }),
      bearerToken: setting(z.string().min(16, 'at least 16 characters (e.g. `openssl rand -hex 24`)').max(500).regex(/^[\x21-\x7e]+$/, 'printable characters without spaces').optional(), {
        kind: 'string',
        scope: 'runtime',
        env: 'REELFORGE_METRICS_TOKEN',
        secret: true,
        description:
          '`GET /metrics` needs `Authorization: Bearer <token>` (Prometheus `authorization.credentials`). Unset: `/metrics` answers 401 unless `observability.metrics.allowAnonymous` is on.',
      }),
      allowAnonymous: setting(z.boolean(), {
        kind: 'boolean',
        scope: 'runtime',
        env: 'REELFORGE_METRICS_ALLOW_ANONYMOUS',
        default: false,
        description:
          'Serve `GET /metrics` without a token when no `observability.metrics.bearerToken` is set (for a scraper on a private network). Off by default: an open `/metrics` shows request and job counts to anyone who can reach the port.',
      }),
      exportIntervalSeconds: setting(z.number().int().min(5).max(3600), {
        kind: 'integer',
        scope: 'runtime',
        env: 'REELFORGE_METRICS_EXPORT_INTERVAL_SECONDS',
        default: 60,
        description: 'How often metrics are pushed with the `otlp` exporter.',
      }),
    }),
    tracing: z.object({
      exporter: setting(z.enum(['otlp', 'off']), {
        kind: 'enum',
        scope: 'runtime',
        env: 'REELFORGE_TRACING_EXPORTER',
        default: (get: Getter) => (get('observability.otlp.endpoint') ? 'otlp' : 'off'),
        defaultText: '`off` (`otlp` when `observability.otlp.endpoint` is set)',
        description: '`otlp`: spans for HTTP requests, jobs, engine renders and FFmpeg steps to `observability.otlp.endpoint` (Jaeger, Grafana Tempo, Honeycomb, Datadog, ...). `off`: no spans.',
      }),
      sampleRatio: setting(z.number().min(0).max(1), {
        kind: 'number',
        scope: 'runtime',
        env: 'REELFORGE_TRACING_SAMPLE_RATIO',
        default: 1,
        description: 'Share of new traces kept (0 to 1). A request that arrives with a W3C `traceparent` follows the caller\'s sampling decision.',
      }),
    }),
    otlp: z.object({
      endpoint: setting(httpUrl().optional(), {
        kind: 'url',
        scope: 'runtime',
        env: 'REELFORGE_OTLP_ENDPOINT',
        aliases: ['OTEL_EXPORTER_OTLP_ENDPOINT'],
        example: 'http://otel-collector:4318',
        description: 'OTLP/HTTP base URL; `/v1/traces`, `/v1/metrics` and `/v1/logs` are appended. Nothing is sent anywhere unless this is set (docs/PRIVACY.md).',
      }),
      headers: setting(
        z
          .string()
          .max(4000)
          .regex(/^\s*[^\s=,]+\s*=[^,\r\n]*(,\s*[^\s=,]+\s*=[^,\r\n]*)*$/, 'comma-separated name=value pairs, e.g. "x-honeycomb-team=<key>"')
          .optional(),
        {
          kind: 'string',
          scope: 'runtime',
          env: 'REELFORGE_OTLP_HEADERS',
          aliases: ['OTEL_EXPORTER_OTLP_HEADERS'],
          secret: true,
          example: 'authorization=Basic <base64 instance:token>',
          description: 'Headers sent with every OTLP request, as `name=value,name2=value2` (values may be URL-encoded). Usually holds the vendor API key, so it is a secret.',
        }
      ),
      protocol: setting(z.enum(['http/protobuf', 'http/json']), {
        kind: 'enum',
        scope: 'runtime',
        env: 'REELFORGE_OTLP_PROTOCOL',
        aliases: ['OTEL_EXPORTER_OTLP_PROTOCOL'],
        default: 'http/protobuf',
        description: 'OTLP encoding over HTTP. gRPC is not shipped (it would add a large dependency); point this at an OpenTelemetry Collector to reach a gRPC-only backend.',
      }),
      timeoutSeconds: setting(z.number().int().min(1).max(60), {
        kind: 'integer',
        scope: 'runtime',
        env: 'REELFORGE_OTLP_TIMEOUT_SECONDS',
        default: 10,
        description: 'Longest time one OTLP export may take, retries included (429/502/503/504 are retried with exponential backoff inside this time). Then the batch is dropped and the server carries on.',
      }),
    }),
  }),
  licence: z.object({
    mode: setting(z.enum(['required', 'off', 'trial']), {
      kind: 'enum',
      scope: 'startup',
      env: 'REELFORGE_LICENCE_MODE',
      aliases: ['REELFORGE_LICENSE_MODE'],
      default: 'required',
      description:
        'What happens without a valid licence (D-028). `required`: renders and previews are refused until a key is activated (everything else works). `off`: development and CI only; nothing is refused, a configured key is still checked and reported. `trial` is reserved and not built yet (behaves as `required`).',
    }),
    key: setting(z.string().trim().min(1).max(500).regex(/^[^\r\n]*$/, 'must be a single line').optional(), {
      kind: 'string',
      scope: 'runtime',
      env: 'REELFORGE_LICENCE_KEY',
      aliases: ['REELFORGE_LICENSE_KEY'],
      secret: true,
      description:
        'Licence key from your ReelForge purchase (D-028). Activated on start and when set; validated daily. Setting it with `activate_licence` / `POST /v1/licence` stores it encrypted (needs `REELFORGE_SECRET_KEY`). Only the key and a random instance id are sent to the licence server (docs/PRIVACY.md).',
    }),
    offlineGraceDays: setting(z.number().int().min(0).max(14), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_LICENCE_OFFLINE_GRACE_DAYS',
      default: 14,
      description: 'Days the server keeps rendering past the last successful licence check while the licence server cannot be reached (D-028). At most 14; a lower value only shortens it.',
    }),
    serverUrl: setting(httpUrl(), {
      kind: 'url',
      scope: 'startup',
      env: 'REELFORGE_LICENCE_SERVER_URL',
      default: 'https://api.console.buildbase.app',
      description: 'Licence server (BuildBase). Change only for a mock server in tests.',
    }),
    orgId: setting(z.string().regex(/^[a-z0-9]{8,64}(-[a-z]{8})?$/, 'a BuildBase organisation id, optionally followed by -<environment key>'), {
      kind: 'string',
      scope: 'startup',
      env: 'REELFORGE_LICENCE_ORG_ID',
      default: '6b01478bb42d2c444e99fcd8',
      description: 'BuildBase organisation that issued the key (ReelForge production). A test environment is `<orgId>-<environment key>`.',
    }),
  }),
});

export type Config = z.output<typeof ConfigSchema>;

function absolute(p: string): string {
  return isAbsolute(p) ? p : resolve(p);
}

/** One setting, flattened. */
export interface SettingDef extends SettingMeta {
  /** Dotted path, e.g. "limits.rateLimitPerMinute"; also the config file nesting. */
  key: string;
  schema: z.ZodType;
}

function collect(obj: z.ZodObject, prefix: string, out: SettingDef[]): SettingDef[] {
  for (const [name, child] of Object.entries(obj.shape)) {
    const key = prefix ? `${prefix}.${name}` : name;
    const meta = META.get(child as z.ZodType);
    if (meta) out.push({ key, schema: child as z.ZodType, ...meta });
    else if (child instanceof z.ZodObject) collect(child, key, out);
    else throw new Error(`config schema: ${key} has no setting metadata`);
  }
  return out;
}

/** Every setting, in schema order. */
export const SETTINGS: readonly SettingDef[] = Object.freeze(collect(ConfigSchema, '', []));
export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((s) => [s.key, s]));

/** The env variable names a setting is read from, in precedence order (secrets: each also as _FILE). */
export function envNames(def: SettingDef): string[] {
  return [def.env, ...(def.aliases ?? [])];
}

/** The config file schema: the same nesting, every key optional, unknown keys refused (typos). */
function fileSchemaOf(obj: z.ZodObject): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, child] of Object.entries(obj.shape)) {
    shape[name] = META.has(child as z.ZodType) ? (child as z.ZodType).optional() : fileSchemaOf(child as z.ZodObject).optional();
  }
  return z.strictObject(shape);
}
export const FileConfigSchema = fileSchemaOf(ConfigSchema);

/** Read a dotted key from a nested object. */
export function getPath(obj: unknown, key: string): unknown {
  let cur = obj;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Write a dotted key into a nested object (creating parents). */
export function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (typeof cur[part] !== 'object' || cur[part] === null) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts.at(-1)!] = value;
}
