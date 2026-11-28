import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { buildOrigin, currentBuild, CUSTOM_BUILD_WARNING, type BuildInfo } from './build';
import { SECRET_KEY_HELP } from './crypto';
import { ConfigSchema, FileConfigSchema, SETTINGS, SETTINGS_BY_KEY, envNames, getPath, setPath, type Config, type SettingDef } from './schema';

/** `build`: fixed by a release image (D-039); nothing else can change it. */
export type ConfigSource = 'default' | 'file' | 'env' | 'runtime' | 'build';

export interface ConfigIssue {
  /** Dotted setting key, or "" for the file as a whole. */
  key: string;
  source: ConfigSource;
  /** The environment variable or file the value came from (never the value of a secret). */
  origin?: string;
  message: string;
}

/** Invalid configuration: every problem at once, without secret values. */
export class ConfigError extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(`invalid configuration:\n${issues.map((i) => `  - ${formatIssue(i)}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function formatIssue(i: ConfigIssue): string {
  const where = i.origin ? `${i.origin}${i.key && i.source !== 'env' ? ` (${i.key})` : ''}` : i.key || i.source;
  return `${where}: ${i.message}`;
}

/** The config file named by RENDERWELD_CONFIG, parsed (YAML or JSON). */
export interface ConfigFile {
  path: string;
  data: unknown;
}

/** Read and parse a YAML or JSON config file. Throws ConfigError. */
export function readConfigFile(path: string): ConfigFile {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (e) {
    throw new ConfigError([{ key: '', source: 'file', origin: abs, message: `cannot read the config file (RENDERWELD_CONFIG): ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` }]);
  }
  const ext = extname(abs).toLowerCase();
  try {
    // JSON is YAML too, but JSON.parse gives better messages for .json files.
    const data = ext === '.json' ? JSON.parse(text) : parseYaml(text, { prettyErrors: true });
    return { path: abs, data: data ?? {} };
  } catch (e) {
    // Parser messages quote the offending line, which may hold a secret: report the position only.
    const m = /line (\d+)/i.exec((e as Error).message) ?? /position (\d+)/i.exec((e as Error).message);
    throw new ConfigError([{ key: '', source: 'file', origin: abs, message: `not valid ${ext === '.json' ? 'JSON' : 'YAML'}${m ? ` (near ${m[0]})` : ''}` }]);
  }
}

/** RENDERWELD_CONFIG, read and parsed; undefined when not set (empty counts as unset). Throws ConfigError. */
export function loadConfigFile(env: NodeJS.ProcessEnv): ConfigFile | undefined {
  const path = env.RENDERWELD_CONFIG?.trim();
  return path ? readConfigFile(path) : undefined;
}

interface LayerValue {
  value: unknown;
  origin?: string;
}

function zodMessage(def: SettingDef, error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `[${i.path.join('.')}] ` : '') + i.message).join('; ') || 'invalid value';
}

function validateLeaf(def: SettingDef, value: unknown, source: ConfigSource, origin: string | undefined, issues: ConfigIssue[]): LayerValue | undefined {
  const r = def.schema.safeParse(value);
  if (r.success) return { value: r.data, origin };
  const shown = def.secret || value === undefined ? '' : ` (got ${JSON.stringify(value)})`;
  issues.push({ key: def.key, source, origin, message: `${zodMessage(def, r.error)}${shown}` });
  return undefined;
}

/** Turn an environment variable's text into a value of the setting's kind. */
/** A decimal number as text. Each string matches in one way only, so a long hostile value can't blow up backtracking (CodeQL js/polynomial-redos). */
export const NUMBER_TEXT = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

function fromEnvText(def: SettingDef, text: string, origin: string, issues: ConfigIssue[]): unknown {
  const shown = def.secret ? '' : ` (got "${text}")`;
  switch (def.kind) {
    case 'integer':
      if (/^-?\d+$/.test(text)) return Number(text);
      issues.push({ key: def.key, source: 'env', origin, message: `must be an integer${shown}` });
      return undefined;
    case 'number':
      if (NUMBER_TEXT.test(text)) return Number(text);
      issues.push({ key: def.key, source: 'env', origin, message: `must be a number${shown}` });
      return undefined;
    case 'boolean': {
      const t = text.toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(t)) return true;
      if (['0', 'false', 'no', 'off'].includes(t)) return false;
      issues.push({ key: def.key, source: 'env', origin, message: `must be 1/0, true/false, yes/no or on/off${shown}` });
      return undefined;
    }
    case 'list':
      return text
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    default:
      return text;
  }
}

/**
 * The Docker image sets its defaults (data directory, host, port, browser)
 * under the RENDERWELD_* names and lists them, as `NAME=value` separated by
 * spaces, in RENDERWELD_IMAGE_DEFAULTS. Such a value ranks below any value the
 * operator sets for the same setting, under any of its names, so
 * `-e DATABASE_URL=...` still wins over an image default for that setting.
 */
export const IMAGE_DEFAULTS_ENV = 'RENDERWELD_IMAGE_DEFAULTS';

function parseImageDefaults(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of (text ?? '').split(/\s+/)) {
    const i = pair.indexOf('=');
    if (i > 0) out.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return out;
}

/**
 * The environment layer: for each setting, the first of its names that is set
 * (RENDERWELD_* before other aliases; for secrets NAME before NAME_FILE).
 * Empty variables count as unset (Compose passes `${X:-}` as "").
 */
function envLayer(env: NodeJS.ProcessEnv, issues: ConfigIssue[], warnings: string[]): Map<string, LayerValue> {
  const out = new Map<string, LayerValue>();
  const imageDefaults = parseImageDefaults(env[IMAGE_DEFAULTS_ENV]);
  for (const def of SETTINGS) {
    const found: Array<{ name: string; origin: string; text: string }> = [];
    for (const name of envNames(def)) {
      const direct = env[name];
      if (direct !== undefined && direct.trim() !== '') found.push({ name, origin: name, text: direct.trim() });
      const file = def.secret ? env[`${name}_FILE`]?.trim() : undefined;
      if (file) {
        try {
          const text = readFileSync(file, 'utf8').trim();
          if (!text) issues.push({ key: def.key, source: 'env', origin: `${name}_FILE`, message: `the file ${file} is empty` });
          else found.push({ name, origin: `${name}_FILE`, text });
        } catch (e) {
          issues.push({ key: def.key, source: 'env', origin: `${name}_FILE`, message: `cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` });
        }
      }
    }
    if (!found.length) continue;
    // A value the Docker image sets as its default (RENDERWELD_IMAGE_DEFAULTS) gives way to any value the operator set.
    const operator = found.filter((f) => imageDefaults.get(f.origin) !== f.text);
    if (operator.length) found.splice(0, found.length, ...operator);
    const [first, ...rest] = found as [(typeof found)[number], ...typeof found];
    if (rest.some((r) => r.text !== first.text)) warnings.push(`${found.map((f) => f.origin).join(', ')} are all set for ${def.key} with different values; using ${first.origin}`);
    const raw = fromEnvText(def, first.text, first.origin, issues);
    if (raw === undefined) continue;
    const v = validateLeaf(def, raw, 'env', first.origin, issues);
    if (v) out.set(def.key, v);
  }
  return out;
}

function fileLayer(file: ConfigFile, issues: ConfigIssue[]): Map<string, LayerValue> {
  const out = new Map<string, LayerValue>();
  if (file.data === null || typeof file.data !== 'object' || Array.isArray(file.data)) {
    issues.push({ key: '', source: 'file', origin: file.path, message: 'the config file must be a mapping (YAML) or an object (JSON) of setting groups' });
    return out;
  }
  const r = FileConfigSchema.safeParse(file.data);
  if (!r.success) {
    for (const i of r.error.issues) {
      const key = i.path.join('.');
      const def = SETTINGS_BY_KEY.get(key);
      const unknown = i.code === 'unrecognized_keys' ? ` (${(i as { keys?: string[] }).keys?.map((k) => (key ? `${key}.${k}` : k)).join(', ')}; see docs/CONFIG.md)` : '';
      const shown = def && !def.secret && getPath(file.data, key) !== undefined ? ` (got ${JSON.stringify(getPath(file.data, key))})` : '';
      issues.push({ key, source: 'file', origin: file.path, message: `${i.message}${unknown}${shown}` });
    }
    return out;
  }
  for (const def of SETTINGS) {
    const v = getPath(r.data, def.key);
    if (v !== undefined) out.set(def.key, { value: v, origin: file.path });
  }
  return out;
}

/** One setting's effective value and where it came from. `value` is the real value: redact secrets before showing it. */
export interface ResolvedSetting {
  def: SettingDef;
  value: unknown;
  source: ConfigSource;
  /** Environment variable name or config file path. */
  origin?: string;
}

export interface ResolvedConfig {
  config: Config;
  settings: Map<string, ResolvedSetting>;
  file?: ConfigFile;
  warnings: string[];
  build: BuildInfo;
}

export interface ResolveInput {
  env: NodeJS.ProcessEnv;
  file?: ConfigFile;
  /** Runtime values from the database (already decrypted), by key. Only runtime-scope keys are used. */
  runtime?: Record<string, unknown>;
  /** The build (release images fix some settings). Default: this process's build (currentBuild()). */
  build?: BuildInfo;
}

/** Why a value from the file, env or runtime layer is refused for a setting a release build fixes. */
export function buildLockedMessage(key: string, build: BuildInfo): string {
  return `"${key}" is fixed by this ${build.edition} build to ${JSON.stringify(build.locked[key])} and cannot be changed by the config file, environment or update_config. Remove it.${
    key === 'licence.mode' ? ' Building from source with licence.mode "off" is for noncommercial development only (LICENSING.md).' : ''
  }`;
}

/**
 * defaults < file < env < runtime. Throws ConfigError with every problem
 * (no secret values in messages).
 */
export function resolveConfig(input: ResolveInput): ResolvedConfig {
  const issues: ConfigIssue[] = [];
  const warnings: string[] = [];
  const fileValues = input.file ? fileLayer(input.file, issues) : new Map<string, LayerValue>();
  const envValues = envLayer(input.env, issues, warnings);
  const runtimeValues = new Map<string, LayerValue>();
  for (const [key, value] of Object.entries(input.runtime ?? {})) {
    const def = SETTINGS_BY_KEY.get(key);
    if (!def) {
      warnings.push(`the database holds a runtime value for unknown setting "${key}" (from a newer or older version?); ignored`);
      continue;
    }
    if (def.scope !== 'runtime') {
      warnings.push(`the database holds a runtime value for "${key}", which is start-up only; ignored`);
      continue;
    }
    const v = validateLeaf(def, value, 'runtime', 'database', issues);
    if (v) runtimeValues.set(key, v);
  }

  const build = input.build ?? currentBuild();
  const settings = new Map<string, ResolvedSetting>();
  const pending: SettingDef[] = [];
  for (const def of SETTINGS) {
    if (Object.hasOwn(build.locked, def.key)) {
      const fixed = build.locked[def.key];
      // Saying the same thing again is harmless; anything else is refused (the server does not start).
      for (const [source, layer] of [['file', fileValues], ['env', envValues], ['runtime', runtimeValues]] as const) {
        const v = layer.get(def.key);
        if (v && JSON.stringify(v.value) !== JSON.stringify(fixed)) issues.push({ key: def.key, source, origin: v.origin, message: buildLockedMessage(def.key, build) });
      }
      settings.set(def.key, { def, value: structuredClone(fixed), source: 'build', origin: buildOrigin(build) });
      continue;
    }
    const r = runtimeValues.get(def.key);
    const e = envValues.get(def.key);
    const f = fileValues.get(def.key);
    if (r) settings.set(def.key, { def, value: r.value, source: 'runtime', origin: r.origin });
    else if (e) settings.set(def.key, { def, value: e.value, source: 'env', origin: e.origin });
    else if (f) settings.set(def.key, { def, value: f.value, source: 'file', origin: f.origin });
    else pending.push(def);
  }
  // Defaults last: computed ones read other effective values (e.g. the data directory).
  const get = (key: string) => settings.get(key)?.value;
  for (const def of pending) {
    const value = typeof def.default === 'function' ? (def.default as (g: typeof get) => unknown)(get) : def.default;
    settings.set(def.key, { def, value: value === undefined ? undefined : structuredClone(value), source: 'default' });
  }

  issues.push(...storageIssues(settings));

  if (issues.length) throw new ConfigError(issues);
  const nested: Record<string, unknown> = {};
  for (const [key, s] of settings) setPath(nested, key, s.value);
  const parsed = ConfigSchema.safeParse(nested);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => {
        const key = i.path.join('.');
        const s = settings.get(key);
        return { key, source: s?.source ?? 'default', origin: s?.origin, message: i.message };
      })
    );
  }
  if (build.custom) warnings.push(CUSTOM_BUILD_WARNING);
  return { config: parsed.data, settings, file: input.file, warnings, build };
}

/** Validate one runtime value (PATCH /v1/config) against its setting. */
export function parseSettingValue(def: SettingDef, value: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  const r = def.schema.safeParse(value);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, message: zodMessage(def, r.error) };
}

/** Settings the chosen storage driver needs, and credentials that only come in pairs (D-066). */
function storageIssues(settings: Map<string, ResolvedSetting>): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  const v = (key: string) => settings.get(key)?.value;
  const issue = (key: string, message: string) => {
    const s = settings.get(key);
    out.push({ key, source: s?.source ?? 'default', origin: s?.origin, message });
  };
  const driver = v('storage.driver');
  if (driver === 's3' && !v('storage.s3.bucket')) issue('storage.s3.bucket', 'storage.driver is "s3": set storage.s3.bucket (RENDERWELD_S3_BUCKET)');
  if (driver === 'azure') {
    if (!v('storage.azure.container')) issue('storage.azure.container', 'storage.driver is "azure": set storage.azure.container (RENDERWELD_AZURE_STORAGE_CONTAINER)');
    if (!v('storage.azure.connectionString') && !v('storage.azure.accountUrl')) {
      issue('storage.azure.accountUrl', 'storage.driver is "azure": set storage.azure.connectionString, or storage.azure.accountUrl to use managed identity');
    }
  }
  if (driver === 'gcs' && !v('storage.gcs.bucket')) issue('storage.gcs.bucket', 'storage.driver is "gcs": set storage.gcs.bucket (RENDERWELD_GCS_BUCKET)');
  for (const key of ['storage.s3.endpoint', 'storage.s3.publicEndpoint', 'storage.azure.accountUrl', 'storage.gcs.apiEndpoint']) {
    const url = v(key);
    if (typeof url === 'string') {
      const problem = endpointProblem(url);
      if (problem) issue(key, problem);
    }
  }
  if (v('storage.s3.kmsKeyId') && !String(v('storage.s3.serverSideEncryption') ?? '').startsWith('aws:kms')) {
    issue('storage.s3.kmsKeyId', 'storage.s3.kmsKeyId needs storage.s3.serverSideEncryption "aws:kms" or "aws:kms:dsse"');
  }
  if (Boolean(v('storage.s3.accessKeyId')) !== Boolean(v('storage.s3.secretAccessKey'))) {
    issue(v('storage.s3.accessKeyId') ? 'storage.s3.secretAccessKey' : 'storage.s3.accessKeyId', 'set both storage.s3.accessKeyId and storage.s3.secretAccessKey, or neither (ambient identity)');
  }
  // MCP OAuth (D-112): a token must name this server, so an issuer needs an audience (or the public URL it defaults from).
  if (v('security.oauth.issuer') && !v('security.oauth.audience') && !v('server.publicUrl')) {
    issue('security.oauth.audience', 'security.oauth.issuer is set: set security.oauth.audience (RENDERWELD_MCP_OAUTH_AUDIENCE) to this server\'s MCP URL, or server.publicUrl');
  }
  return out;
}

/**
 * A storage endpoint is operator configuration (start-up only, never set over
 * the API), but still checked (D-066): http(s) only, no credentials, query or
 * fragment in the URL, and plain http only to internal hosts (loopback,
 * private addresses, single-label names such as a Compose service, *.local,
 * *.internal, *.svc, *.cluster.local) so keys never cross the internet unencrypted.
 */
export function endpointProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not a valid URL';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'must be an http:// or https:// URL';
  if (u.username || u.password) return 'must not contain credentials (use the secret settings instead)';
  if (u.search || u.hash) return 'must not contain a query string or fragment';
  if (u.protocol === 'http:' && !isInternalHost(u.hostname)) return 'plain http:// is only allowed for internal hosts (loopback, private addresses, single-label or *.local/*.internal/*.svc names); use https://';
  return null;
}

function isInternalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || !h.includes('.') && !h.includes(':')) return true;
  if (/\.(local|internal|svc|cluster\.local|localhost)$/.test(h)) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h)) return true;
  return false;
}

/**
 * RENDERWELD_SECRET_KEY at start-up (#305). The release edition refuses to start
 * without it: it seals the stored licence state (D-089) and encrypts stored
 * secrets, and a fixed fallback would protect nothing. A dev build only warns:
 * its licence-state seal then uses a random key in the data directory.
 */
export function secretKeyProblem(resolved: Pick<ResolvedConfig, 'config' | 'build'>): { error?: string; warning?: string } {
  if (resolved.config.security.secretKey) return {};
  if (resolved.build.edition === 'release') {
    return { error: `RENDERWELD_SECRET_KEY is not set: the release edition does not start without it (it seals the stored licence state and encrypts stored secrets). ${SECRET_KEY_HELP}` };
  }
  return {
    warning:
      'RENDERWELD_SECRET_KEY is not set: provider keys and other secrets cannot be stored through the API, and the licence state is sealed with a random key in <dataDir>/licence-seal.key (instances that share a database need the same RENDERWELD_SECRET_KEY). A release build refuses to start without it.',
  };
}
