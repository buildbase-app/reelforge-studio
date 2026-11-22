import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

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
  }),
  limits: z.object({
    rateLimitPerMinute: setting(nonNegative(), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_RATE_LIMIT_PER_MINUTE',
      default: 300,
      description: 'Requests per minute per API key (`0` disables the limit).',
    }),
    maxUploadBytes: setting(positive(), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_MAX_UPLOAD_BYTES',
      default: 200 * 1024 * 1024,
      description: 'Largest asset upload or URL import, in bytes.',
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
        'Encrypts secrets stored in the database (provider keys, licence key) with AES-256-GCM. At least 32 characters: `openssl rand -base64 32`. Without it the server refuses to store secrets. Keep it safe: losing it makes stored secrets unreadable.',
    }),
    bootstrapKey: setting(z.string().regex(/^rf_[A-Za-z0-9_-]{20,}$/, 'must be rf_ followed by 20 or more URL-safe characters').optional(), {
      kind: 'string',
      scope: 'startup',
      env: 'REELFORGE_BOOTSTRAP_KEY',
      secret: true,
      description: 'First admin API key (`rf_` + 20 or more URL-safe characters). Stored hashed as key "bootstrap" on start if no key exists.',
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
      default: 15,
      description: 'Longest time one delivery attempt may take (connect, send, answer); then it counts as failed and is retried.',
    }),
    maxAttempts: setting(z.number().int().min(1).max(30), {
      kind: 'integer',
      scope: 'runtime',
      env: 'REELFORGE_WEBHOOKS_MAX_ATTEMPTS',
      default: 15,
      description: 'Attempts per delivery before it becomes dead (dead letter; replayable). With the default backoff, 15 attempts span about 24 hours.',
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
      defaultText: '`false` (`true` in Docker)',
      description: "Turn Chromium's own sandbox off (containers, where the container is the isolation boundary).",
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
          'When set, `GET /metrics` needs `Authorization: Bearer <token>` (Prometheus `authorization.credentials`). Unset: `/metrics` is open like `/healthz`; keep it off the public internet (docs/OBSERVABILITY.md).',
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
