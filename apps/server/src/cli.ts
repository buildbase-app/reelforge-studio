#!/usr/bin/env -S npx tsx
/**
 * reelforge CLI (operator tasks that need no running server).
 *
 *   reelforge migrate [--status]       apply database migrations (and import v0.1 data once)
 *   reelforge import-v01 [--data-dir DIR]  import a v0.1 filesystem data directory again (existing rows are kept)
 *   reelforge backup <file>            SQLite: consistent copy of the live database
 *   reelforge keys create [--name NAME] [--scopes read,write,render,admin]
 *   reelforge keys list
 *   reelforge keys delete <keyId>
 *   reelforge config check [--file PATH]   validate the config file and environment (no server, no database)
 *   reelforge config show [--json] [--offline]   effective configuration, secrets redacted
 *   reelforge licence status [--json] [--check]   licence status (exit 2 when renders are refused)
 *   reelforge licence activate [KEY] [--json]     store the key (encrypted) and activate it now
 *   reelforge licence deactivate [--json]         give this server's activation back
 *
 * Uses DATABASE_URL (default: SQLite in REELFORGE_DATA_DIR, ./data) like the
 * server. The key is printed once.
 */
import { existsSync } from 'node:fs';
import { ConfigError, KeyStore, RuntimeConfig, SCOPES, createLicenceManager, formatIssue, type ConfigReport, type LicenceReport, type Scope } from '@reelforge/core';
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
  reelforge keys create [--name NAME] [--scopes ${SCOPES.join(',')}]
  reelforge keys list
  reelforge keys delete <keyId>
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
  for (const w of warnings) console.log(`  ! ${w}`);
}

function printReport(r: ConfigReport, note?: string) {
  console.log(`config file: ${r.configFile ?? '(none)'}    secret key: ${r.secretKey}${note ? `    ${note}` : ''}`);
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
  if (group !== 'keys' || !['create', 'list', 'delete'].includes(cmd ?? '')) {
    console.log(USAGE);
    process.exitCode = group ? 1 : 0;
    return;
  }

  const { db } = await prepareDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrate: config.migrateOnStart, connectTimeoutSeconds: config.dbConnectTimeoutSeconds });
  try {
    const keys = new KeyStore(db.repositories().keys);
    if (cmd === 'create') {
      const name = arg('name', rest) ?? 'default';
      const scopes = (arg('scopes', rest) ?? 'read,write,render').split(',').map((s) => s.trim()) as Scope[];
      const { key, record } = await keys.create(name, scopes);
      await db.repositories().audit.write({ actorType: 'cli', action: 'key.create', targetType: 'key', targetId: record.id, data: { name: record.name, scopes: record.scopes } });
      console.log(`Created API key "${record.name}" (${record.id}) with scopes ${record.scopes.join(', ')}.`);
      console.log('Store it now; it is not shown again:\n');
      console.log(key);
    } else if (cmd === 'list') {
      for (const k of await keys.list()) console.log(`${k.id}  ${k.prefix}…  ${k.name.padEnd(20)} ${k.scopes.join(',').padEnd(24)} created ${k.createdAt}${k.lastUsedAt ? `, last used ${k.lastUsedAt}` : ''}`);
    } else if (cmd === 'delete' && rest[0]) {
      await keys.delete(rest[0]);
      await db.repositories().audit.write({ actorType: 'cli', action: 'key.delete', targetType: 'key', targetId: rest[0] });
      console.log(`Deleted ${rest[0]}`);
    } else {
      console.log(USAGE);
      process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
