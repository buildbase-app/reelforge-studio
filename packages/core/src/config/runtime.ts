import { ApiError } from '../errors';
import type { ProviderSettingRepository, Repositories, StoredValue } from '../repositories';
import { ENCRYPTED_SCHEME, PLAIN_SCHEME, SECRET_KEY_HELP, SecretCipher, SecretDecryptError } from './crypto';
import type { BuildInfo } from './build';
import { ConfigError, buildLockedMessage, formatIssue, parseSettingValue, resolveConfig, type ConfigFile, type ConfigSource, type ResolvedConfig, type ResolvedSetting } from './load';
import { SETTINGS, SETTINGS_BY_KEY, envNames, type Config, type SettingDef, type SettingKind, type SettingScope } from './schema';

/** Where configuration comes from besides the database. */
export interface ConfigSources {
  env: NodeJS.ProcessEnv;
  file?: ConfigFile;
  /** Default: this process's build (currentBuild()). */
  build?: BuildInfo;
}

/** One row of GET /v1/config / get_config. Secret values are only "set" / "not set". */
export interface ConfigEntry {
  key: string;
  value: unknown;
  source: ConfigSource;
  /** The environment variable, config file path, or "database". */
  origin?: string;
  scope: SettingScope;
  secret: boolean;
  /** The value's type, so a client can offer the right input and check it before update_config (#292). */
  kind: SettingKind;
  /** Enum settings: the allowed values. */
  options?: string[];
  /** Number settings: the inclusive bounds the schema enforces. */
  min?: number;
  max?: number;
  /** Fixed by the image build (release edition): update_config refuses it. */
  locked?: true;
  env: string;
  aliases?: string[];
  description: string;
  placeholder?: string;
  /** Runtime values: when and by whom they were set. */
  updatedAt?: string;
  updatedBy?: string;
  /** Runtime secrets: how the value is stored. */
  atRest?: string;
  /** e.g. a stored secret that cannot be decrypted with the current key. */
  error?: string;
}

export interface ConfigReport {
  /** `release` images fix the licence settings (source `build`); `dev` is a build from source. */
  edition: BuildInfo['edition'];
  configFile: string | null;
  /** Whether RENDERWELD_SECRET_KEY is set, i.e. secrets can be stored (encrypted). */
  secretKey: 'set' | 'not set';
  settings: ConfigEntry[];
  warnings: string[];
}

export interface ConfigChange {
  key: string;
  /** Secrets: "set" / "cleared" only. */
  from: unknown;
  to: unknown;
}

export type ConfigListener = (resolved: ResolvedConfig, changedKeys: string[]) => void;

/** Shown value of a setting: secrets only as set / not set. */
export function redact(def: SettingDef, value: unknown): unknown {
  if (def.secret) return value === undefined || value === null || value === '' ? 'not set' : 'set';
  return value === undefined ? null : value;
}

/** Where a start-up-only setting is set, for error messages. */
export function whereToSet(def: SettingDef): string {
  const env = def.secret ? `${def.env} (or ${def.env}_FILE)` : def.env;
  return `set it in the config file (RENDERWELD_CONFIG, key "${def.key}") or the environment variable ${env}, then restart the server`;
}

/** A provider-backed secret (providers.<id>.<name>) is stored in ProviderSetting under its env name, shared with configure_provider. */
function providerRow(def: SettingDef): string | undefined {
  return def.secret && def.providerEnv ? def.providerEnv : undefined;
}

const PROVIDER_ROW_KEYS = new Map(SETTINGS.filter((d) => providerRow(d)).map((d) => [d.providerEnv!, d]));

/** Flatten { limits: { rateLimitPerMinute: 5 } } and { "limits.rateLimitPerMinute": 5 } alike. */
export function flattenPatch(patch: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(patch)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (!SETTINGS_BY_KEY.has(key) && v !== null && typeof v === 'object' && !Array.isArray(v)) flattenPatch(v as Record<string, unknown>, key, out);
    else out[key] = v;
  }
  return out;
}

/**
 * The effective configuration of a running server: file and environment
 * (resolved once at start) plus runtime settings stored in the database.
 * Secrets in the database are encrypted with RENDERWELD_SECRET_KEY.
 *
 * It also holds provider settings set with configure_provider (any name a
 * provider declares), which share the ProviderSetting table with the
 * provider-backed keys of the schema (providers.elevenlabs.apiKey).
 */
export class RuntimeConfig {
  readonly cipher: SecretCipher | null;
  private resolved: ResolvedConfig;
  private runtime: Record<string, unknown> = {};
  private meta = new Map<string, { updatedAt?: string; updatedBy?: string; scheme: string }>();
  private broken = new Map<string, string>();
  /** Decrypted ProviderSetting values by env name (every provider-declared name). */
  private providerValues: Record<string, string> = {};
  private providerMeta = new Map<string, { scheme: string; updatedAt: string; providerId?: string }>();
  private listeners: ConfigListener[] = [];
  private loadWarnings: string[] = [];

  constructor(
    private readonly repos: Repositories,
    readonly sources: ConfigSources,
    private readonly log: (level: 'info' | 'warn' | 'error', line: string) => void = () => undefined
  ) {
    this.resolved = resolveConfig(sources); // throws ConfigError on a bad file or env
    const key = this.resolved.config.security.secretKey;
    this.cipher = key ? new SecretCipher(key) : null;
  }

  get config(): Config {
    return this.resolved.config;
  }

  get current(): ResolvedConfig {
    return this.resolved;
  }

  onChange(fn: ConfigListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private decode(name: string, stored: StoredValue): string {
    if (stored.scheme === PLAIN_SCHEME) return stored.value;
    if (stored.scheme !== ENCRYPTED_SCHEME) throw new SecretDecryptError(name, `unknown storage scheme "${stored.scheme}"`);
    if (!this.cipher) throw new SecretDecryptError(name, 'RENDERWELD_SECRET_KEY is not set');
    return this.cipher.decrypt(name, stored.value);
  }

  private encode(name: string, plaintext: string, secret: boolean): StoredValue {
    if (!secret) return { value: plaintext, scheme: PLAIN_SCHEME };
    if (!this.cipher) throw new ApiError('secret_key_required', 409, `refusing to store ${name}: secrets are stored encrypted and RENDERWELD_SECRET_KEY is not set. ${SECRET_KEY_HELP}`);
    return { value: this.cipher.encrypt(name, plaintext), scheme: ENCRYPTED_SCHEME };
  }

  /** (Re)read runtime settings and provider settings from the database and resolve. */
  async load(): Promise<void> {
    const runtime: Record<string, unknown> = {};
    const meta = new Map<string, { updatedAt?: string; updatedBy?: string; scheme: string }>();
    const broken = new Map<string, string>();
    const warnings: string[] = [];
    for (const row of await this.repos.settings.list()) {
      const def = SETTINGS_BY_KEY.get(row.key);
      meta.set(row.key, { updatedAt: row.updatedAt, updatedBy: row.updatedBy, scheme: row.scheme });
      try {
        runtime[row.key] = JSON.parse(this.decode(row.key, row));
      } catch (e) {
        const reason = e instanceof SecretDecryptError ? e.message : `cannot read the stored value of ${row.key}`;
        broken.set(row.key, reason);
        if (def) warnings.push(`${reason}; ignoring it`);
      }
    }
    const providerValues: Record<string, string> = {};
    const providerMeta = new Map<string, { scheme: string; updatedAt: string; providerId?: string }>();
    const infos = new Map((await this.repos.providerSettings.list()).map((i) => [i.name, i]));
    for (const [name, stored] of Object.entries(await this.repos.providerSettings.values())) {
      const info = infos.get(name);
      providerMeta.set(name, { scheme: stored.scheme, updatedAt: info?.updatedAt ?? '', providerId: info?.providerId });
      const def = PROVIDER_ROW_KEYS.get(name);
      try {
        const v = this.decode(name, stored);
        providerValues[name] = v;
        if (def) {
          runtime[def.key] = v;
          meta.set(def.key, { updatedAt: info?.updatedAt, scheme: stored.scheme });
        }
      } catch (e) {
        const reason = (e as Error).message;
        if (def) broken.set(def.key, reason);
        else broken.set(`provider:${name}`, reason);
        warnings.push(`${reason}; the provider setting is ignored until the right RENDERWELD_SECRET_KEY is set`);
      }
    }
    if (!this.cipher) {
      const plain = [...providerMeta].filter(([, m]) => m.scheme === PLAIN_SCHEME).map(([n]) => n);
      if (plain.length) warnings.push(`${plain.length} provider setting(s) are stored in plain text (${plain.join(', ')}); set RENDERWELD_SECRET_KEY to encrypt them at rest`);
    }
    // A runtime value that no longer validates (e.g. after an upgrade) must not stop the server: drop it and say so.
    let resolved: ResolvedConfig;
    for (;;) {
      try {
        resolved = resolveConfig({ ...this.sources, runtime });
        break;
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        const bad = e.issues.filter((i) => i.source === 'runtime' && i.key in runtime);
        if (!bad.length) throw e;
        for (const i of bad) {
          delete runtime[i.key];
          broken.set(i.key, `stored runtime value is invalid (${i.message})`);
          warnings.push(`ignoring the stored runtime value of ${formatIssue(i)}`);
        }
      }
    }
    this.runtime = runtime;
    this.meta = meta;
    this.broken = broken;
    this.providerValues = providerValues;
    this.providerMeta = providerMeta;
    this.resolved = resolved;
    this.loadWarnings = warnings;
  }

  warnings(): string[] {
    return [...this.resolved.warnings, ...this.loadWarnings];
  }

  /**
   * Re-read the database and apply what another instance changed (several
   * instances, D-077): listeners get the keys whose effective value changed.
   * Returns those keys.
   */
  async refresh(): Promise<string[]> {
    const before = new Map([...this.resolved.settings.values()].map((v) => [v.def.key, JSON.stringify(v.value ?? null)]));
    const providersBefore = JSON.stringify(this.providerValues);
    await this.load();
    const keys = [...this.resolved.settings.values()].filter((v) => before.get(v.def.key) !== JSON.stringify(v.value ?? null)).map((v) => v.def.key);
    if (keys.length) this.emit(keys);
    else if (JSON.stringify(this.providerValues) !== providersBefore) this.emit([]);
    return keys;
  }

  /**
   * Encrypt provider settings and secret runtime settings still stored in
   * plain text (v0.1 imports, rows from before D-031). Needs the secret key;
   * idempotent. Returns the names encrypted (never values).
   */
  async encryptPlaintext(): Promise<string[]> {
    if (!this.cipher) return [];
    const done: string[] = [];
    const now = new Date().toISOString();
    const providerChanges: Record<string, StoredValue> = {};
    for (const [name, stored] of Object.entries(await this.repos.providerSettings.values())) {
      if (stored.scheme !== PLAIN_SCHEME) continue;
      providerChanges[name] = { value: this.cipher.encrypt(name, stored.value), scheme: ENCRYPTED_SCHEME };
      done.push(name);
    }
    if (done.length) await this.repos.providerSettings.apply(providerChanges, now);
    const settingChanges: Record<string, StoredValue> = {};
    for (const row of await this.repos.settings.list()) {
      if (row.scheme !== PLAIN_SCHEME || !SETTINGS_BY_KEY.get(row.key)?.secret) continue;
      settingChanges[row.key] = { value: this.cipher.encrypt(row.key, row.value), scheme: ENCRYPTED_SCHEME };
      done.push(row.key);
    }
    if (Object.keys(settingChanges).length) await this.repos.settings.apply(settingChanges, now, 'system');
    if (done.length) await this.load();
    return done;
  }

  private entry(s: ResolvedSetting): ConfigEntry {
    const d = s.def;
    const m = s.source === 'runtime' ? this.meta.get(d.key) : undefined;
    const brokenReason = this.broken.get(d.key);
    return {
      key: d.key,
      value: redact(d, s.value),
      source: s.source,
      ...(s.origin ? { origin: s.origin } : {}),
      scope: d.scope,
      secret: Boolean(d.secret),
      ...valueType(d),
      ...(Object.hasOwn(this.resolved.build.locked, d.key) ? { locked: true as const } : {}),
      env: d.env,
      ...(d.aliases?.length ? { aliases: d.aliases } : {}),
      description: d.description,
      ...(d.placeholder ? { placeholder: `reserved for ${d.placeholder}; not used yet` } : {}),
      ...(m?.updatedAt ? { updatedAt: m.updatedAt } : {}),
      ...(m?.updatedBy ? { updatedBy: m.updatedBy } : {}),
      ...(m && d.secret ? { atRest: m.scheme } : {}),
      ...(brokenReason ? { error: brokenReason } : {}),
    };
  }

  /** GET /v1/config: every setting with its effective value and source; secrets as set / not set. */
  report(opts: { prefix?: string } = {}): ConfigReport {
    const settings = SETTINGS.filter((d) => !opts.prefix || d.key === opts.prefix || d.key.startsWith(`${opts.prefix}.`)).map((d) => this.entry(this.resolved.settings.get(d.key)!));
    return {
      edition: this.resolved.build.edition,
      configFile: this.sources.file?.path ?? null,
      secretKey: this.cipher ? 'set' : 'not set',
      settings,
      warnings: this.warnings(),
    };
  }

  /**
   * PATCH /v1/config: set (value) or clear (null) runtime settings, all or
   * nothing. Start-up-only keys, unknown keys, invalid values and secrets
   * without RENDERWELD_SECRET_KEY are refused with every problem listed.
   */
  async update(patch: unknown, actorId?: string): Promise<{ changes: ConfigChange[]; settings: ConfigEntry[] }> {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
      throw new ApiError('bad_request', 400, 'send the settings to change, e.g. { "settings": { "limits.rateLimitPerMinute": 120 } } (null clears a runtime value)');
    }
    const flat = flattenPatch(patch as Record<string, unknown>);
    type Issue = { key: string; code: string; message: string; setIn?: { configFile: string; env: string[] } };
    const issues: Issue[] = [];
    const next: Record<string, unknown> = { ...this.runtime };
    const changed: Array<{ def: SettingDef; value: unknown }> = [];
    for (const [key, raw] of Object.entries(flat)) {
      const def = SETTINGS_BY_KEY.get(key);
      if (!def) {
        issues.push({ key, code: 'unknown_setting', message: `"${key}" is not a setting; call get_config (GET /v1/config) for the keys` });
        continue;
      }
      if (Object.hasOwn(this.resolved.build.locked, key)) {
        issues.push({ key, code: 'build_locked', message: buildLockedMessage(key, this.resolved.build) });
        continue;
      }
      if (def.scope !== 'runtime') {
        const env = envNames(def).flatMap((n) => (def.secret ? [n, `${n}_FILE`] : [n]));
        issues.push({ key, code: 'startup_only', message: `"${key}" applies at start-up only and cannot be changed at runtime: ${whereToSet(def)}`, setIn: { configFile: key, env } });
        continue;
      }
      if (raw === null) {
        delete next[key];
        changed.push({ def, value: undefined });
        continue;
      }
      const parsed = parseSettingValue(def, raw);
      if (!parsed.ok) {
        issues.push({ key, code: 'invalid_value', message: `${key}: ${parsed.message}${def.secret ? '' : ` (got ${JSON.stringify(raw)})`}` });
        continue;
      }
      if (def.secret && !this.cipher) {
        issues.push({ key, code: 'secret_key_required', message: `refusing to store ${key}: secrets are stored encrypted and RENDERWELD_SECRET_KEY is not set. ${SECRET_KEY_HELP}` });
        continue;
      }
      next[key] = parsed.value;
      changed.push({ def, value: parsed.value });
    }
    if (!issues.length) {
      try {
        resolveConfig({ ...this.sources, runtime: next });
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        for (const i of e.issues) issues.push({ key: i.key, code: 'invalid_value', message: formatIssue(i) });
      }
    }
    if (issues.length) {
      const codes = new Set(issues.map((i) => i.code));
      const [code, status] =
        codes.has('unknown_setting') || codes.has('invalid_value')
          ? ['invalid_setting', 422]
          : codes.has('build_locked')
            ? ['build_locked_setting', 409]
            : codes.has('startup_only')
              ? ['startup_only_setting', 409]
              : ['secret_key_required', 409];
      const message = issues.length === 1 ? issues[0]!.message : `${issues.length} settings were refused (nothing was changed): ${issues.map((i) => i.message).join(' | ')}`;
      throw new ApiError(code!, status as number, message, { issues });
    }

    const before = new Map(changed.map(({ def }) => [def.key, this.resolved.settings.get(def.key)!.value]));
    const at = new Date().toISOString();
    const providerChanges: Record<string, StoredValue | null> = {};
    const settingChanges: Record<string, StoredValue | null> = {};
    for (const { def, value } of changed) {
      const row = providerRow(def);
      if (row) providerChanges[row] = value === undefined ? null : this.encode(row, String(value), true);
      else settingChanges[def.key] = value === undefined ? null : this.encode(def.key, JSON.stringify(value), Boolean(def.secret));
    }
    // Provider rows first (they carry a providerId), then the rest. Each is one transaction.
    for (const [row, v] of Object.entries(providerChanges)) {
      const providerId = PROVIDER_ROW_KEYS.get(row)!.key.split('.')[1];
      await this.repos.providerSettings.apply({ [row]: v }, at, providerId);
    }
    if (Object.keys(settingChanges).length) await this.repos.settings.apply(settingChanges, at, actorId);
    await this.load();
    const keys = changed.map(({ def }) => def.key);
    this.emit(keys);
    const changes = changed.map(({ def }) => ({
      key: def.key,
      from: redact(def, before.get(def.key)),
      to: redact(def, this.resolved.settings.get(def.key)!.value),
    }));
    return { changes, settings: keys.map((k) => this.entry(this.resolved.settings.get(k)!)) };
  }

  private emit(keys: string[]) {
    for (const l of this.listeners) {
      try {
        l(this.resolved, keys);
      } catch (e) {
        this.log('error', `applying a configuration change failed: ${(e as Error).message}`);
      }
    }
  }

  // ---- provider settings (configure_provider) --------------------------------

  /** Whether a provider setting has a value stored through the API (decryptable). */
  hasProviderValue(name: string): boolean {
    return typeof this.providerValues[name] === 'string' && this.providerValues[name] !== '';
  }

  providerError(name: string): string | undefined {
    const def = PROVIDER_ROW_KEYS.get(name);
    return this.broken.get(def ? def.key : `provider:${name}`);
  }

  /**
   * Values providers and backends read from their environment object: every
   * schema key with `providerEnv` (undefined = fall back to the process
   * environment), plus provider-declared names stored with configure_provider.
   */
  providerEnvOverlay(): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const [name, v] of Object.entries(this.providerValues)) out[name] = v;
    for (const d of SETTINGS) {
      if (!d.providerEnv) continue;
      const s = this.resolved.settings.get(d.key)!;
      out[d.providerEnv] = s.source === 'default' || s.value === undefined ? undefined : String(s.value);
    }
    return out;
  }

  /** The schema setting stored under a provider env name, if any. */
  static settingForProviderEnv(name: string): SettingDef | undefined {
    return SETTINGS.find((d) => d.providerEnv === name);
  }

  /**
   * One workspace's own provider settings (#480), decrypted, by name. `repo` is that workspace's provider
   * settings (its rows only); read on every call, so a change on another instance applies at once. A value
   * that cannot be decrypted is left out and reported in `errors`.
   */
  async workspaceProviderValues(repo: ProviderSettingRepository): Promise<{ values: Record<string, string>; errors: Record<string, string> }> {
    const values: Record<string, string> = {};
    const errors: Record<string, string> = {};
    for (const [name, stored] of Object.entries(await repo.values())) {
      try {
        const v = this.decode(name, stored);
        if (v) values[name] = v;
      } catch (e) {
        errors[name] = (e as Error).message;
      }
    }
    return { values, errors };
  }

  /** configure_workspace_provider: set (string) or clear (null) one workspace's own provider settings, encrypted. */
  async setWorkspaceProviderValues(repo: ProviderSettingRepository, changes: Record<string, string | null>, providerId: string): Promise<void> {
    const stored: Record<string, StoredValue | null> = {};
    for (const [name, v] of Object.entries(changes)) stored[name] = v === null ? null : this.encode(name, v, true);
    await repo.apply(stored, new Date().toISOString(), providerId);
  }

  /** configure_provider: set (string) or clear (null) provider settings, encrypted. */
  async setProviderValues(changes: Record<string, string | null>, providerId: string): Promise<string[]> {
    const stored: Record<string, StoredValue | null> = {};
    for (const [name, v] of Object.entries(changes)) stored[name] = v === null ? null : this.encode(name, v, true);
    await this.repos.providerSettings.apply(stored, new Date().toISOString(), providerId);
    await this.load();
    const keys = Object.keys(changes)
      .map((n) => PROVIDER_ROW_KEYS.get(n)?.key)
      .filter((k): k is string => Boolean(k));
    this.emit(keys);
    return keys;
  }
}

/** kind, enum options and number bounds of a setting, read from its schema (optional and default wrappers unwrapped). */
function valueType(d: SettingDef): Pick<ConfigEntry, 'kind' | 'options' | 'min' | 'max'> {
  let s = d.schema as unknown as { def?: { type?: string; innerType?: unknown }; options?: unknown; minValue?: unknown; maxValue?: unknown };
  for (let i = 0; i < 4 && s.def && (s.def.type === 'optional' || s.def.type === 'default' || s.def.type === 'nullable'); i++) s = s.def.innerType as typeof s;
  const out: Pick<ConfigEntry, 'kind' | 'options' | 'min' | 'max'> = { kind: d.kind };
  if (d.kind === 'enum' && Array.isArray(s.options)) out.options = s.options.map(String);
  if (d.kind === 'integer' || d.kind === 'number') {
    if (typeof s.minValue === 'number' && Math.abs(s.minValue) < Number.MAX_SAFE_INTEGER) out.min = s.minValue;
    if (typeof s.maxValue === 'number' && Math.abs(s.maxValue) < Number.MAX_SAFE_INTEGER) out.max = s.maxValue;
  }
  return out;
}
