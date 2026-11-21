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
export type SettingKind = 'string' | 'integer' | 'boolean' | 'list' | 'enum' | 'path' | 'url';

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
    driver: setting(z.enum(['local', 's3']), {
      kind: 'enum',
      scope: 'startup',
      env: 'REELFORGE_STORAGE_DRIVER',
      default: 'local',
      description: 'Where asset and render files are kept. Only `local` works today; `s3` is refused until #27 is built.',
    }),
    s3: z.object({
      bucket: setting(nonEmpty().optional(), { kind: 'string', scope: 'startup', env: 'REELFORGE_S3_BUCKET', placeholder: '#27', description: 'S3 bucket.' }),
      region: setting(nonEmpty().optional(), { kind: 'string', scope: 'startup', env: 'REELFORGE_S3_REGION', placeholder: '#27', description: 'S3 region.' }),
      endpoint: setting(httpUrl().optional(), {
        kind: 'url',
        scope: 'startup',
        env: 'REELFORGE_S3_ENDPOINT',
        placeholder: '#27',
        description: 'S3-compatible endpoint (MinIO, R2, ...). Empty for AWS.',
      }),
      accessKeyId: setting(nonEmpty().optional(), {
        kind: 'string',
        scope: 'startup',
        env: 'REELFORGE_S3_ACCESS_KEY_ID',
        secret: true,
        placeholder: '#27',
        description: 'S3 access key id.',
      }),
      secretAccessKey: setting(nonEmpty().optional(), {
        kind: 'string',
        scope: 'startup',
        env: 'REELFORGE_S3_SECRET_ACCESS_KEY',
        secret: true,
        placeholder: '#27',
        description: 'S3 secret access key.',
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
      default: 'text',
      description: '`text` (`[reelforge] ...` lines) or `json` (one object per line).',
    }),
  }),
  licence: z.object({
    key: setting(z.string().min(1).max(500).regex(/^[^\r\n]*$/, 'must be a single line').optional(), {
      kind: 'string',
      scope: 'runtime',
      env: 'REELFORGE_LICENCE_KEY',
      aliases: ['REELFORGE_LICENSE_KEY'],
      secret: true,
      placeholder: '#25',
      description: 'Licence key (D-028). Stored encrypted when set at runtime. Not checked yet: licence activation is #25.',
    }),
    offlineGraceDays: setting(z.number().int().min(0).max(365), {
      kind: 'integer',
      scope: 'startup',
      env: 'REELFORGE_LICENCE_OFFLINE_GRACE_DAYS',
      default: 14,
      placeholder: '#25',
      description: 'Days the server keeps working past the last good licence check (D-028). Not used yet (#25).',
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
