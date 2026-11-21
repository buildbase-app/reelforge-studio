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
 *
 * Uses DATABASE_URL (default: SQLite in REELFORGE_DATA_DIR, ./data) like the
 * server. The key is printed once.
 */
import { KeyStore, SCOPES, type Scope } from '@reelforge/core';
import { Database, prepareDatabase } from '@reelforge/db';
import { resolve } from 'node:path';
import { loadConfig } from './config';

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
  reelforge keys delete <keyId>`;

async function main(argv: string[]) {
  const [group, cmd, ...rest] = argv;
  const config = loadConfig();
  const log = (line: string) => console.log(line);

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
