#!/usr/bin/env -S npx tsx
/**
 * reelforge CLI (operator tasks that need no running server).
 *
 *   reelforge migrate [--status]       apply database migrations (and import v0.1 data once)
 *   reelforge import-v01 [--data-dir DIR]  import a v0.1 filesystem data directory again (existing rows are kept)
 *   reelforge backup <file>            SQLite: consistent copy of the live database
 *   reelforge keys create [--name NAME] [--scopes read,write,render,admin] [limits]
 *   reelforge keys list | show <keyId>
 *   reelforge keys update <keyId> [--name NAME] [limits]
 *   reelforge keys rotate <keyId> [--grace-hours N]
 *   reelforge keys revoke <keyId>
 *   reelforge keys delete <keyId>
 *     limits: --expires-in 30d|12h | --expires-at ISO | --rate-limit N | --renders-per-day N
 *             --renders-per-month N | --ip-allow CIDR,CIDR   ("none" clears one in update)
 *   reelforge audit list [--from ISO] [--to ISO] [--actor KEYID] [--action key.*] [--target ID] [--result R] [--limit N] [--json]
 *   reelforge audit export [--format jsonl|csv] [--out FILE] [same filters]   (streamed)
 *   reelforge audit sweep              delete entries past audit.retentionDays and expired idempotency keys
 *   reelforge config check [--file PATH]   validate the config file and environment (no server, no database)
 *   reelforge config show [--json] [--offline]   effective configuration, secrets redacted
 *   reelforge licence status [--json] [--check]   licence status (exit 2 when renders are refused)
 *   reelforge licence activate [KEY] [--json]     store the key (encrypted) and activate it now
 *   reelforge licence deactivate [--json]         give this server's activation back
 *
 * Uses DATABASE_URL (default: SQLite in REELFORGE_DATA_DIR, ./data) like the
 * server. The key is printed once.
 */
import { createWriteStream, existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import {
  AuditLog,
  ConfigError,
  KeyStore,
  RuntimeConfig,
  SCOPES,
  auditToCsv,
  auditToJsonl,
  createLicenceManager,
  formatIssue,
  parseAuditQuery,
  type ConfigReport,
  type KeyOptions,
  type LicenceReport,
  type PublicKey,
  type Repositories,
  type Scope,
} from '@reelforge/core';
import { Database, parseDatabaseUrl, prepareDatabase } from '@reelforge/db';
import { resolve } from 'node:path';
import { loadConfig, type ServerConfig } from './config';

function arg(name: string, args: string[]): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

const USAGE = `usage:
  reelforge migrate [--status]
  reelforge import-v01 [--data-dir DIR]
  reelforge backup <file>   (SQLite; use pg_dump / mysqldump for the others)
  reelforge keys create [--name NAME] [--scopes ${SCOPES.join(',')}] [LIMITS]
  reelforge keys list
  reelforge keys show <keyId>
  reelforge keys update <keyId> [--name NAME] [LIMITS]   ("none" clears a limit)
  reelforge keys rotate <keyId> [--grace-hours N]
  reelforge keys revoke <keyId>
  reelforge keys delete <keyId>
    LIMITS: --expires-in 30d|12h  --expires-at ISO  --rate-limit N  --renders-per-day N  --renders-per-month N  --ip-allow CIDR,CIDR
  reelforge audit list [--from ISO] [--to ISO] [--actor KEYID] [--action ACTION|prefix.*] [--target-type T] [--target ID] [--result success|failure|denied] [--limit N] [--json]
  reelforge audit export [--format jsonl|csv] [--out FILE] [same filters]
  reelforge audit sweep
  reelforge config check [--file PATH]
  reelforge config show [--json] [--offline]
  reelforge licence status [--json] [--check]
  reelforge licence activate [KEY] [--json]   (KEY also from REELFORGE_LICENCE_KEY_INPUT; omit to re-activate the configured key)
  reelforge licence deactivate [--json]`;

function printLicence(r: LicenceReport, json: boolean) {
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`status:       ${r.status}${r.reason ? ` (${r.reason})` : ''}${r.renderAllowed ? '' : '  -- renders are refused'}`);
  console.log(`message:      ${r.message}`);
  if (r.fix) console.log(`fix:          ${r.fix}`);
  if (r.warning) console.log(`warning:      ${r.warning}`);
  console.log(`mode:         ${r.mode}`);
  console.log(`key:          ${r.key ?? '(not set)'}${r.keySource ? `  from ${r.keySource}` : ''}`);
  console.log(`instance:     ${r.instanceId}`);
  if (r.item) console.log(`item:         ${r.item.title} (${r.item.id})`);
  if (r.activations) console.log(`activations:  ${r.activations.used}/${r.activations.limit ?? 'unlimited'}`);
  if (r.expiresAt) console.log(`expires:      ${r.expiresAt}`);
  console.log(`last check:   ${r.lastCheckedAt ?? '-'}    last success: ${r.lastSuccessAt ?? '-'}${r.graceUntil ? `    grace until: ${r.graceUntil}` : ''}`);
  if (r.lastError) console.log(`last error:   ${r.lastError.message} (${r.lastError.at})`);
  console.log(`server:       ${r.licenceServer.url} (org ${r.licenceServer.orgId})`);
}

/**
 * `reelforge licence ...`: works on the database directly (no running server
 * needed). A running server reads the stored state at its next check; a key
 * stored here reaches a running server after a restart (D-032).
 */
async function licence(cmd: string | undefined, argv: string[], config: ServerConfig): Promise<void> {
  if (!['status', 'activate', 'deactivate'].includes(cmd ?? '')) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  const json = argv.includes('--json');
  const { db } = await prepareDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrate: config.migrateOnStart, connectTimeoutSeconds: config.dbConnectTimeoutSeconds });
  try {
    const repos = db.repositories();
    const settings = new RuntimeConfig(repos, config.sources);
    await settings.load();
    const manager = createLicenceManager(settings, repos, { timers: false, log: json ? undefined : (_l, line) => console.error(line) });
    await manager.init();
    let r: LicenceReport;
    if (cmd === 'status') {
      r = argv.includes('--check') ? await manager.check('cli') : manager.report();
    } else if (cmd === 'activate') {
      const key = argv.find((a) => !a.startsWith('--')) ?? process.env.REELFORGE_LICENCE_KEY_INPUT;
      if (key) {
        const { changes } = await settings.update({ 'licence.key': key.trim() });
        await repos.audit.write({ actorType: 'cli', action: 'config.update', targetType: 'config', data: { changes } });
      } else if (!manager.report().key) {
        console.error('no licence key is set: reelforge licence activate <KEY>');
        process.exitCode = 1;
        return;
      }
      r = await manager.activateNow();
      await repos.audit.write({ actorType: 'cli', action: 'licence.activate', targetType: 'licence', targetId: r.instanceId, data: { key: r.key, status: r.status, reason: r.reason } });
    } else {
      r = await manager.deactivate();
      await repos.audit.write({ actorType: 'cli', action: 'licence.deactivate', targetType: 'licence', targetId: r.instanceId, data: { key: r.key } });
    }
    printLicence(r, json);
    if (cmd !== 'deactivate' && !r.renderAllowed) process.exitCode = 2;
  } finally {
    await db.close();
  }
}

/** `reelforge config check`: validate the file and environment without starting anything. Exit 1 on errors. */
function configCheck(argv: string[]): void {
  const file = arg('file', argv);
  const env = file ? { ...process.env, REELFORGE_CONFIG: file } : process.env;
  let config: ServerConfig;
  try {
    config = loadConfig(env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(`configuration is INVALID (${e.issues.length} problem${e.issues.length === 1 ? '' : 's'}):`);
    for (const i of e.issues) console.error(`  ✘ ${formatIssue(i)}`);
    process.exitCode = 1;
    return;
  }
  const problems: string[] = [];
  try {
    parseDatabaseUrl(config.databaseUrl);
  } catch (e) {
    // parseDatabaseUrl messages redact the URL.
    problems.push(`database.url: ${(e as Error).message}`);
  }
  const counts: Record<string, number> = {};
  for (const s of config.resolved.settings.values()) counts[s.source] = (counts[s.source] ?? 0) + 1;
  const warnings = [...config.resolved.warnings];
  if (!config.resolved.config.security.secretKey) warnings.push('REELFORGE_SECRET_KEY is not set: provider keys and other secrets cannot be stored over the API');
  if (!existsSync(config.dataDir)) warnings.push(`storage.dataDir ${config.dataDir} does not exist yet (the server creates it)`);
  if (problems.length) {
    console.error('configuration is INVALID:');
    for (const p of problems) console.error(`  ✘ ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`configuration is valid${config.sources.file ? ` (config file ${config.sources.file.path})` : ' (no config file; REELFORGE_CONFIG is not set)'}`);
  console.log(`  ${Object.entries(counts).map(([k, v]) => `${v} from ${k}`).join(', ')}`);
  console.log(`  edition: ${config.resolved.build.edition}${config.resolved.build.edition === 'release' ? ' (licence.mode, licence.serverUrl and licence.orgId are fixed by the build)' : ''}`);
  for (const w of warnings) console.log(`  ! ${w}`);
}

function printReport(r: ConfigReport, note?: string) {
  console.log(`edition: ${r.edition}    config file: ${r.configFile ?? '(none)'}    secret key: ${r.secretKey}${note ? `    ${note}` : ''}`);
  const width = Math.max(...r.settings.map((s) => s.key.length));
  for (const s of r.settings) {
    const where = s.source === 'default' ? 'default' : `${s.source}${s.origin && s.origin !== 'database' ? `: ${s.origin}` : ''}`;
    console.log(`${s.key.padEnd(width)}  ${JSON.stringify(s.value)}  (${where}${s.scope === 'startup' ? ', start-up only' : ''}${s.error ? `; ${s.error}` : ''})`);
  }
  for (const w of r.warnings) console.log(`! ${w}`);
}

/** `reelforge config show`: the effective configuration with the database's runtime settings (unless --offline), secrets redacted. */
async function configShow(argv: string[], config: ServerConfig): Promise<void> {
  let db: Database | undefined;
  let note: string | undefined;
  try {
    const sqlite = (() => {
      try {
        return parseDatabaseUrl(config.databaseUrl).file;
      } catch {
        return undefined;
      }
    })();
    if (sqlite && !existsSync(sqlite)) note = `no database yet (${sqlite}); showing file and environment only`;
    else if (!argv.includes('--offline')) {
      try {
        db = await Database.open({ url: config.databaseUrl });
        await db.assertMigrated();
      } catch (e) {
        note = `runtime settings not read (${(e as Error).message.split('\n')[0]}); showing file and environment only`;
        await db?.close().catch(() => undefined);
        db = undefined;
      }
    } else note = 'offline: runtime settings from the database not included';
    const runtime = new RuntimeConfig(db ? db.repositories() : (await import('@reelforge/core')).createMemoryRepositories(), config.sources);
    await runtime.load();
    const report = runtime.report();
    if (argv.includes('--json')) console.log(JSON.stringify(note ? { ...report, note } : report, null, 2));
    else printReport(report, note);
  } finally {
    await db?.close();
  }
}

async function main(argv: string[]) {
  const [group, cmd, ...rest] = argv;
  if (group === 'config' && cmd === 'check') return configCheck(rest);
  const config = loadConfig();
  if (group === 'config' && cmd === 'show') return configShow(rest, config);
  const log = (line: string) => console.log(line);
  if (group === 'licence' || group === 'license') return licence(cmd, rest, config);

  if (group === 'migrate' && argv.includes('--status')) {
    const db = await Database.open({ url: config.databaseUrl });
    try {
      const s = await db.status();
      console.log(`database: ${db.kind} ${db.displayUrl}`);
      for (const a of s.applied) console.log(`applied  ${a.id}  ${a.appliedAt}`);
      for (const p of s.pending) console.log(`pending  ${p}`);
      if (s.pending.length) process.exitCode = 2;
    } finally {
      await db.close();
    }
    return;
  }
  if (group === 'migrate') {
    const { db, migrated, imported } = await prepareDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrate: true, connectTimeoutSeconds: config.dbConnectTimeoutSeconds, log });
    console.log(`database: ${db.kind} ${db.displayUrl}`);
    console.log(migrated.length ? `applied ${migrated.join(', ')}` : 'schema is up to date');
    if (imported) console.log(`imported v0.1 data: ${JSON.stringify(imported)}`);
    await db.close();
    return;
  }
  if (group === 'import-v01') {
    const dataDir = arg('data-dir', argv) ?? config.dataDir;
    const { db } = await prepareDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrate: config.migrateOnStart, connectTimeoutSeconds: config.dbConnectTimeoutSeconds, log });
    try {
      const report = await db.importFilesystemOnce(dataDir, { force: true, log });
      console.log(report ? JSON.stringify(report, null, 2) : `nothing to import in ${dataDir}`);
    } finally {
      await db.close();
    }
    return;
  }
  if (group === 'backup' && cmd) {
    const db = await Database.open({ url: config.databaseUrl });
    try {
      await db.backupSqlite(resolve(cmd));
      console.log(`wrote ${resolve(cmd)}`);
    } finally {
      await db.close();
    }
    return;
  }
  if (group === 'audit') return audit(cmd, rest, config);
  if (group !== 'keys' || !['create', 'list', 'show', 'update', 'rotate', 'revoke', 'delete'].includes(cmd ?? '')) {
    console.log(USAGE);
    process.exitCode = group ? 1 : 0;
    return;
  }
  return keys(cmd!, rest, config);
}

/** The CLI as an audit actor: actorType "cli", named after the OS user. */
function cliAuditLog(repos: Repositories) {
  const log = new AuditLog(repos.audit);
  let who = 'cli';
  try {
    who = `cli:${userInfo().username}`;
  } catch {
    // no passwd entry (container with an arbitrary UID)
  }
  return { log, write: (e: Parameters<AuditLog['write']>[0]) => log.write({ ...e, actorType: 'cli', actorName: who }) };
}

/** --expires-in 30d / 12h / 90m -> ISO time. */
function expiresIn(v: string): string {
  const m = /^(\d+(?:\.\d+)?)([dhm])$/.exec(v.trim());
  if (!m) throw new Error('--expires-in must look like 30d, 12h or 90m');
  const ms = Number(m[1]) * (m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : 60_000);
  return new Date(Date.now() + ms).toISOString();
}

function keyLimits(args: string[]): KeyOptions {
  const o: KeyOptions = {};
  const num = (name: string): number | null | undefined => {
    const v = arg(name, args);
    if (v === undefined) return undefined;
    if (v === 'none') return null;
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer or "none"`);
    return n;
  };
  const exp = arg('expires-in', args);
  const at = arg('expires-at', args);
  if (exp !== undefined) o.expiresAt = exp === 'none' ? null : expiresIn(exp);
  else if (at !== undefined) o.expiresAt = at === 'none' ? null : at;
  const rl = num('rate-limit');
  if (rl !== undefined) o.rateLimitPerMinute = rl;
  const d = num('renders-per-day');
  if (d !== undefined) o.rendersPerDay = d;
  const mo = num('renders-per-month');
  if (mo !== undefined) o.rendersPerMonth = mo;
  const ip = arg('ip-allow', args);
  if (ip !== undefined) o.ipAllowlist = ip === 'none' ? null : ip.split(',').map((s) => s.trim()).filter(Boolean);
  return o;
}

function describeKey(k: PublicKey): string {
  const limits = [
    k.expiresAt ? `expires ${k.expiresAt}` : '',
    k.rateLimitPerMinute !== undefined ? `${k.rateLimitPerMinute}/min` : '',
    k.rendersPerDay !== undefined ? `${k.rendersPerDay} renders/day` : '',
    k.rendersPerMonth !== undefined ? `${k.rendersPerMonth} renders/month` : '',
    k.ipAllowlist?.length ? `from ${k.ipAllowlist.join(',')}` : '',
    k.previousSecretExpiresAt ? `old secret valid until ${k.previousSecretExpiresAt}` : '',
  ].filter(Boolean);
  return `${k.id}  ${k.prefix}…  ${k.name.padEnd(20)} ${k.status.padEnd(8)} ${k.scopes.join(',').padEnd(24)} created ${k.createdAt}${k.lastUsedAt ? `, last used ${k.lastUsedAt}` : ''}${limits.length ? `  [${limits.join('; ')}]` : ''}`;
}

/** `reelforge keys ...`: the same lifecycle as create_key / rotate_key / revoke_key, audit-logged as the CLI. */
async function keys(cmd: string, rest: string[], config: ServerConfig): Promise<void> {
  const { db } = await prepareDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrate: config.migrateOnStart, connectTimeoutSeconds: config.dbConnectTimeoutSeconds });
  try {
    const repos = db.repositories();
    const settings = new RuntimeConfig(repos, config.sources);
    await settings.load();
    const audit = cliAuditLog(repos);
    const store = new KeyStore(repos.keys, { audit: audit.write, rotationGraceHours: () => settings.current.config.keys.rotationGraceHours });
    const actor = { actorType: 'cli' as const };
    const id = rest.find((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1]!.startsWith('--') && !rest[i - 1]!.includes('=')));
    if (cmd === 'create') {
      const name = arg('name', rest) ?? 'default';
      const scopes = (arg('scopes', rest) ?? 'read,write,render').split(',').map((s) => s.trim()) as Scope[];
      const { key, record } = await store.create(name, scopes, keyLimits(rest), actor);
      console.log(`Created API key "${record.name}" (${record.id}) with scopes ${record.scopes.join(', ')}.`);
      console.log(describeKey(record));
      console.log('Store it now; it is not shown again:\n');
      console.log(key);
    } else if (cmd === 'list') {
      for (const k of await store.list()) console.log(describeKey(k));
    } else if (!id) {
      console.log(USAGE);
      process.exitCode = 1;
    } else if (cmd === 'show') {
      console.log(JSON.stringify(await store.get(id), null, 2));
    } else if (cmd === 'update') {
      const name = arg('name', rest);
      console.log(describeKey(await store.update(id, { ...keyLimits(rest), ...(name !== undefined ? { name } : {}) }, actor)));
    } else if (cmd === 'rotate') {
      const g = arg('grace-hours', rest);
      const { key, record } = await store.rotate(id, g === undefined ? {} : { graceHours: Number(g) }, actor);
      console.log(`Rotated ${record.id}. ${record.previousSecretExpiresAt ? `The old key works until ${record.previousSecretExpiresAt}.` : 'The old key stopped working.'}`);
      console.log('Store the new key now; it is not shown again:\n');
      console.log(key);
    } else if (cmd === 'revoke') {
      const k = await store.revoke(id, actor);
      console.log(`Revoked ${k.id} (${k.name}) at ${k.revokedAt}`);
    } else if (cmd === 'delete') {
      await store.delete(id, actor);
      console.log(`Deleted ${id}`);
    }
  } finally {
    await db.close();
  }
}

/** `reelforge audit list|export|sweep`. */
async function audit(cmd: string | undefined, rest: string[], config: ServerConfig): Promise<void> {
  if (!['list', 'export', 'sweep'].includes(cmd ?? '')) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  const { db } = await prepareDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrate: config.migrateOnStart, connectTimeoutSeconds: config.dbConnectTimeoutSeconds });
  try {
    const repos = db.repositories();
    const { log, write } = cliAuditLog(repos);
    const query = {
      from: arg('from', rest),
      to: arg('to', rest),
      actorId: arg('actor', rest),
      action: arg('action', rest),
      targetType: arg('target-type', rest),
      targetId: arg('target', rest),
      result: arg('result', rest),
    };
    if (cmd === 'sweep') {
      const settings = new RuntimeConfig(repos, config.sources);
      await settings.load();
      const days = settings.current.config.audit.retentionDays;
      const auditDeleted = await log.sweep(days);
      const idempotencyDeleted = await repos.idempotency.deleteExpired(new Date().toISOString());
      if (auditDeleted) await write({ actorType: 'cli', action: 'audit.sweep', data: { deleted: auditDeleted, retentionDays: days } });
      console.log(`deleted ${auditDeleted} audit entr${auditDeleted === 1 ? 'y' : 'ies'} older than ${days} days${days ? '' : ' (retention 0: kept forever)'} and ${idempotencyDeleted} expired idempotency key(s)`);
    } else if (cmd === 'list') {
      const limit = arg('limit', rest);
      const { events, nextCursor } = await log.list(parseAuditQuery({ ...query, limit: limit ?? 50 }));
      if (rest.includes('--json')) console.log(JSON.stringify({ events, nextCursor }, null, 2));
      else {
        for (const e of events) {
          console.log(`${e.at}  ${e.result.padEnd(7)} ${e.action.padEnd(22)} ${(e.actorName ?? e.actorId ?? e.actorType).padEnd(20)} ${e.targetType ? `${e.targetType}:${e.targetId ?? ''}` : ''}${e.ip ? `  ip ${e.ip}` : ''}${e.requestId ? `  ${e.requestId}` : ''}`);
        }
      }
    } else {
      const format = arg('format', rest) ?? 'jsonl';
      if (format !== 'jsonl' && format !== 'csv') throw new Error('--format must be jsonl or csv');
      const out = arg('out', rest);
      const sink = out ? createWriteStream(resolve(out), { mode: 0o600 }) : process.stdout;
      const write = (s: string) => new Promise<void>((ok) => (sink.write(s) ? ok() : sink.once('drain', () => ok())));
      let n = 0;
      if (format === 'csv') await write(auditToCsv([]));
      // One database page at a time: memory stays flat for any range.
      for await (const page of log.pages(parseAuditQuery(query), Number(arg('limit', rest) ?? Number.MAX_SAFE_INTEGER))) {
        await write(format === 'csv' ? auditToCsv(page, false) : auditToJsonl(page));
        n += page.length;
      }
      if (out) {
        await new Promise<void>((ok) => (sink as ReturnType<typeof createWriteStream>).end(ok));
        console.error(`wrote ${n} entries to ${resolve(out)}`);
      }
    }
  } finally {
    await db.close();
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
