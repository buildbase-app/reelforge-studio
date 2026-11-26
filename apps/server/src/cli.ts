#!/usr/bin/env -S npx tsx
/**
 * renderweld CLI (operator tasks that need no running server). The old name
 * `reelforge` (src/reelforge.ts) runs the same commands with a deprecation notice.
 *
 *   renderweld migrate [--status]       apply database migrations (and import v0.1 data once)
 *   renderweld import-v01 [--data-dir DIR]  import a v0.1 filesystem data directory again (existing rows are kept)
 *   renderweld backup <file>            SQLite: consistent copy of the live database
 *   renderweld keys create [--name NAME] [--scopes read,write,render,admin] [limits]
 *   renderweld keys list | show <keyId>
 *   renderweld keys update <keyId> [--name NAME] [limits]
 *   renderweld keys rotate <keyId> [--grace-hours N]
 *   renderweld keys revoke <keyId>
 *   renderweld keys delete <keyId>
 *     limits: --expires-in 30d|12h | --expires-at ISO | --rate-limit N | --renders-per-day N
 *             --renders-per-month N | --ip-allow CIDR,CIDR | --max-priority interactive|standard|batch
 *             ("none" clears one in update)
 *   renderweld audit list [--from ISO] [--to ISO] [--actor KEYID] [--action key.*] [--target ID] [--result R] [--limit N] [--json]
 *   renderweld audit export [--format jsonl|csv] [--out FILE] [same filters]   (streamed)
 *   renderweld audit sweep              delete entries past audit.retentionDays and expired idempotency keys
 *   renderweld config check [--file PATH]   validate the config file and environment (no server, no database)
 *   renderweld config show [--json] [--offline]   effective configuration, secrets redacted
 *   renderweld licence status [--json] [--check]   licence status (exit 2 when renders are refused)
 *   renderweld licence activate [KEY] [--json]     store the key (encrypted) and activate it now
 *   renderweld licence deactivate [--json]         give this server's activation back
 *   renderweld storage status [--json]             driver, health, usage, retention
 *   renderweld storage migrate --to <driver> [--from local] [--dry-run]   copy assets and renders (idempotent)
 *   renderweld storage cleanup [--dry-run] [--json]   apply the retention policy now
 *   renderweld webhooks list | show <id> | delete <id> [--json]
 *   renderweld webhooks create --name N [--type webhook|slack|discord|teams|email] [--url URL] [--to a@x,b@y] [--provider smtp] --events job.*,render.ready
 *   renderweld webhooks update <id> [--name N] [--url URL] [--events E,E] [--enable|--disable] [--rotate-secret [--grace-hours N]]
 *   renderweld webhooks test <id>          queue a webhook.test event (the running server delivers it)
 *   renderweld webhooks deliveries <id> [--status dead] [--limit N] [--json]
 *   renderweld webhooks replay <id> <deliveryId>
 *   renderweld skills list [--json]
  renderweld skills export <dir> [--prefix renderweld-] [--force]   (one <prefix><name>/SKILL.md per skill, for agent tools that load skill folders)
  renderweld worker --once [--job <id>] [--wait-ms N]   claim at most one job, render it, exit (D-100)
 *
 * Uses DATABASE_URL (default: SQLite in REELFORGE_DATA_DIR, ./data) like the
 * server. The key is printed once.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import {
  AuditLog,
  ConfigError,
  KeyStore,
  RuntimeConfig,
  DEFAULT_WORKSPACE_ID,
  SCOPES,
  STORAGE_DRIVERS,
  StorageManager,
  WebhookService,
  auditToCsv,
  auditToJsonl,
  createLicenceManager,
  createStorageDriver,
  formatIssue,
  legacyNote,
  readRenamedEnv,
  renameWarning,
  migrateStorage,
  scrubSecretEnv,
  secretKeyProblem,
  parseAuditQuery,
  type ConfigReport,
  type KeyOptions,
  type LicenceReport,
  type PublicKey,
  type Repositories,
  type Scope,
  type StorageDriverId,
} from '@renderweld/core';
import { Database, parseDatabaseUrl, parseReadUrl, prepareDatabase } from '@renderweld/db';
import { join, resolve } from 'node:path';
import { loadConfig, type ServerConfig } from './config';
import { onceArgs, runWorkerOnce } from './worker';
import { exportSkillFile, SKILL_NAME, skillsFor } from './skills/index';

function arg(name: string, args: string[]): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

const USAGE = `usage:
  renderweld migrate [--status]
  renderweld import-v01 [--data-dir DIR]
  renderweld backup <file>   (SQLite; use pg_dump / mysqldump for the others)
  renderweld keys create [--name NAME] [--scopes ${SCOPES.join(',')}] [LIMITS]   (every keys command takes --workspace ID; default "default")
  renderweld keys list
  renderweld keys show <keyId>
  renderweld keys update <keyId> [--name NAME] [LIMITS]   ("none" clears a limit)
  renderweld keys rotate <keyId> [--grace-hours N]
  renderweld keys revoke <keyId>
  renderweld keys delete <keyId>
    LIMITS: --expires-in 30d|12h  --expires-at ISO  --rate-limit N  --renders-per-day N  --renders-per-month N  --ip-allow CIDR,CIDR  --max-priority interactive|standard|batch
  renderweld audit list [--from ISO] [--to ISO] [--actor KEYID] [--action ACTION|prefix.*] [--target-type T] [--target ID] [--result success|failure|denied] [--limit N] [--json]
  renderweld audit export [--format jsonl|csv] [--out FILE] [same filters]
  renderweld audit sweep
  renderweld config check [--file PATH]
  renderweld config show [--json] [--offline]
  renderweld licence status [--json] [--check]
  renderweld licence activate [KEY] [--json]   (KEY also from REELFORGE_LICENCE_KEY_INPUT; omit to re-activate the configured key)
  renderweld licence deactivate [--json]
  renderweld storage status [--json]
  renderweld storage migrate --to ${STORAGE_DRIVERS.join('|')} [--from local] [--dry-run]
  renderweld storage cleanup [--dry-run] [--json]
  renderweld webhooks list | show <id> | delete <id> [--json]
  renderweld webhooks create --name N [--type webhook|slack|discord|teams|email] [--url URL] [--to a@x,b@y] [--provider smtp|resend|postmark|ses|sendgrid] --events job.*,render.ready
  renderweld webhooks update <id> [--name N] [--url URL] [--to ...] [--events ...] [--enable|--disable] [--rotate-secret [--grace-hours N]]
  renderweld webhooks test <id>
  renderweld webhooks deliveries <id> [--status pending|delivering|succeeded|dead] [--limit N] [--json]
  renderweld webhooks replay <id> <deliveryId>
  renderweld worker --once [--job <id>] [--wait-ms N]   (exit 0 succeeded/cancelled/nothing queued, 1 failed, 75 handed back or still queued)`;

/**
 * \`renderweld skills list | export <dir>\`: the skills this server serves (the built-ins and skills.dir).
 * Export writes one folder per skill with a SKILL.md, the layout Claude Code, Codex and other agent tools load,
 * so an agent has the rules locally as well as over MCP. An existing SKILL.md that differs is kept unless --force.
 */
function skills(cmd: string | undefined, argv: string[], config: ServerConfig): void {
  const all = skillsFor(config.skillsDir);
  if (cmd === 'list') {
    if (argv.includes('--json')) console.log(JSON.stringify(all.map(({ name, title, description, source }) => ({ name, title, description, source })), null, 2));
    else for (const s of all) console.log(`${s.name.padEnd(28)} ${s.source.padEnd(8)} ${s.title}`);
    return;
  }
  const dir = cmd === 'export' ? argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--prefix') : undefined;
  if (!dir) {
    console.log(usage());
    process.exitCode = 1;
    return;
  }
  const at = argv.indexOf('--prefix');
  const prefix = at >= 0 ? (argv[at + 1] ?? '') : 'renderweld-';
  if (prefix && !/^[a-z0-9]+(?:-[a-z0-9]+)*-?$/.test(prefix)) {
    console.error(`--prefix "${prefix}": lowercase letters, digits and hyphens`);
    process.exitCode = 1;
    return;
  }
  const force = argv.includes('--force');
  const plan = all.map((s) => {
    const name = `${prefix}${s.name}`.slice(0, 64);
    if (!SKILL_NAME.test(name)) throw new Error(`skill folder name "${name}" is not valid`);
    const file = join(resolve(dir), name, 'SKILL.md');
    const text = exportSkillFile(s, prefix);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    return { file, name, text, state: current === undefined ? 'new' : current === text ? 'same' : 'changed' };
  });
  const blocked = plan.filter((p) => p.state === 'changed');
  if (blocked.length && !force) {
    console.error(`not overwriting ${blocked.length} changed file(s) (use --force):\n${blocked.map((p) => `  ${p.file}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  for (const p of plan) {
    if (p.state === 'same') continue;
    mkdirSync(join(resolve(dir), p.name), { recursive: true });
    writeFileSync(p.file, p.text);
  }
  const counts = (s: string) => plan.filter((p) => p.state === s).length;
  console.log(`exported ${plan.length} skills to ${resolve(dir)} (${counts('new')} new, ${counts('changed')} updated, ${counts('same')} unchanged)`);
}

/**
 * \`renderweld storage ...\` (D-069): works on the configuration (file, env and
 * the database's runtime settings, so encrypted credentials are used) without
 * a running server.
 */
async function storage(cmd: string | undefined, argv: string[], config: ServerConfig): Promise<void> {
  if (!['status', 'migrate', 'cleanup'].includes(cmd ?? '')) {
    console.log(usage());
    process.exitCode = 1;
    return;
  }
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const { db } = await prepareDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrate: config.migrateOnStart, connectTimeoutSeconds: config.dbConnectTimeoutSeconds });
  try {
    const repos = db.repositories();
    const settings = new RuntimeConfig(repos, config.sources);
    await settings.load();
    const cacheDir = config.cacheDir ?? `${config.dataDir}/cache`;
    if (cmd === 'migrate') {
      const to = arg('to', argv) as StorageDriverId | undefined;
      const fromId = (arg('from', argv) ?? 'local') as StorageDriverId;
      if (!to || !STORAGE_DRIVERS.includes(to) || !STORAGE_DRIVERS.includes(fromId) || to === fromId) {
        console.error(`usage: ${cliName} storage migrate --to ${STORAGE_DRIVERS.join('|')} [--from local] [--dry-run]  (--to and --from must differ)`);
        process.exitCode = 1;
        return;
      }
      const storageCfg = settings.config.storage;
      const from = await createStorageDriver(storageCfg, { dataDir: config.dataDir, driver: fromId });
      const target = await createStorageDriver(storageCfg, { dataDir: config.dataDir, driver: to });
      const health = await target.health();
      if (!health.ok) {
        console.error(`the target storage is not usable: ${health.message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`${dryRun ? 'dry run: ' : ''}copying assets and renders from ${fromId} to ${to} ${JSON.stringify(target.describe())}`);
      const r = await migrateStorage(from, target, { dryRun, log: (l) => console.log(l) });
      await repos.audit.write({ actorType: 'cli', action: 'storage.migrate', targetType: 'storage', targetId: to, data: { from: fromId, dryRun, copied: r.copied, skipped: r.skipped, failed: r.failed.length } });
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`${dryRun ? 'would copy' : 'copied'}: ${r.copied.objects} objects (${r.copied.bytes} bytes); already there: ${r.skipped.objects} (${r.skipped.bytes} bytes); failed: ${r.failed.length}`);
        for (const f of r.failed.slice(0, 20)) console.log(`  ✘ ${f.key}: ${f.error}`);
        if (!dryRun && !r.failed.length && settings.config.storage.driver !== to) console.log(`next: set storage.driver to "${to}" (REELFORGE_STORAGE_DRIVER=${to}) and restart; run this command again first if renders were made meanwhile`);
      }
      if (r.failed.length) process.exitCode = 1;
      return;
    }
    // Every workspace's files (#304): the manager runs activeRunIds inside each workspace in turn.
    const router = db.workspaceRepositories();
    const manager = new StorageManager({ factory: createStorageDriver, settings, dataDir: config.dataDir, cacheDir, workspaces: () => router.workspaceIds(), activeRunIds: async () => {
      const ids = new Set<string>();
      for (const status of ['queued', 'running'] as const) for (const j of await router.jobs.list({ status })) {
        const runId = (j.params as { runId?: unknown } | undefined)?.runId;
        if (typeof runId === 'string') ids.add(runId);
      }
      return ids;
    } });
    await manager.init();
    if (cmd === 'status') {
      const st = await manager.status();
      if (json) console.log(JSON.stringify(st, null, 2));
      else {
        console.log(`driver:     ${st.driver}  ${JSON.stringify(st.location)}`);
        console.log(`health:     ${st.health.ok ? 'ok' : `NOT OK: ${st.health.message}`}`);
        if (st.usage) console.log(`usage:      assets ${st.usage.assets.objects} (${st.usage.assets.bytes} B), renders ${st.usage.renders.count} (${st.usage.renders.bytes} B), unfinished ${st.usage.temp.objects} objects`);
        console.log(`retention:  ${JSON.stringify(st.retention)}`);
      }
      if (!st.health.ok) process.exitCode = 2;
      return;
    }
    const r = await manager.cleanup({ dryRun });
    if (!dryRun) await repos.audit.write({ actorType: 'cli', action: 'storage.cleanup', targetType: 'storage', targetId: manager.driver.id, data: { policy: r.policy, totals: r.totals } });
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`${dryRun ? 'would delete' : 'deleted'}: ${r.totals.renders} render(s), ${r.temp.length} unfinished upload(s), ${r.staging.length} staging dir(s), ${r.cache.files} cached file(s); ${r.totals.bytes + r.cache.bytes} bytes`);
      for (const x of r.renders) console.log(`  ${x.projectId}/${x.renderId}  ${x.createdAt}  ${x.bytes} B  (${x.reason})`);
    }
    if (r.errors.length) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

/**
 * `renderweld webhooks ...` (#66): manages endpoints in the database without a
 * running server. Deliveries (test, replay) go into the outbox; the running
 * server's worker sends them. Secrets are printed once, on create and rotate.
 */
async function webhooks(cmd: string | undefined, argv: string[], config: ServerConfig): Promise<void> {
  if (!['list', 'show', 'create', 'update', 'delete', 'test', 'deliveries', 'replay'].includes(cmd ?? '')) {
    console.log(usage());
    process.exitCode = 1;
    return;
  }
  const json = argv.includes('--json');
  const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--') && !['--json', '--enable', '--disable', '--rotate-secret'].includes(argv[i - 1]!)));
  const list = (v: string | undefined) => (v === undefined ? undefined : v.split(',').map((x) => x.trim()).filter(Boolean));
  const { db } = await prepareDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrate: config.migrateOnStart, connectTimeoutSeconds: config.dbConnectTimeoutSeconds });
  try {
    const repos = db.repositories();
    const settings = new RuntimeConfig(repos, config.sources);
    await settings.load();
    const actorName = `cli:${userInfo().username}`;
    const svc = new WebhookService({ repo: repos.webhooks, settings, audit: (e) => repos.audit.write({ ...e, actorType: 'cli', actorName }) });
    const actor = { actorType: 'cli' as const };
    const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
    const id = pos[0];
    const need = () => {
      if (!id) throw new Error(`usage: ${cliName} webhooks ${cmd} <webhookId>`);
      return id;
    };
    if (cmd === 'list') {
      const r = await svc.list();
      if (json) return print(r);
      if (!r.webhooks.length) console.log(`no webhooks yet: ${cliName} webhooks create --name N --url https://... --events "*"`);
      for (const w of r.webhooks) console.log(`${w.id}  ${w.enabled ? 'enabled ' : 'DISABLED'}  ${w.type.padEnd(8)} ${w.name}  ${w.url ?? `${w.email?.provider}: ${w.email?.to.join(', ')}`}  events: ${w.events.join(',')}${w.provider.configured ? '' : `  (not configured: ${w.provider.missing})`}`);
      return;
    }
    if (cmd === 'show') return print(await svc.get(need()));
    if (cmd === 'create') {
      const type = arg('type', argv) ?? 'webhook';
      const r = await svc.create(
        {
          name: arg('name', argv),
          type,
          ...(arg('url', argv) ? { url: arg('url', argv) } : {}),
          ...(type === 'email' ? { email: { provider: arg('provider', argv) ?? 'smtp', to: list(arg('to', argv)) ?? [] } } : {}),
          events: list(arg('events', argv)) ?? [],
          ...(arg('description', argv) ? { description: arg('description', argv) } : {}),
        },
        actor
      );
      if (json) return print(r);
      console.log(`created ${r.webhook.id} (${r.webhook.type}, ${r.webhook.name})`);
      if (r.secret) console.log(`signing secret (shown once): ${r.secret}`);
      return;
    }
    if (cmd === 'update') {
      const patch: Record<string, unknown> = {};
      if (arg('name', argv) !== undefined) patch.name = arg('name', argv);
      if (arg('url', argv) !== undefined) patch.url = arg('url', argv);
      if (arg('events', argv) !== undefined) patch.events = list(arg('events', argv));
      if (arg('to', argv) !== undefined) patch.email = { provider: arg('provider', argv) ?? 'smtp', to: list(arg('to', argv)) };
      if (argv.includes('--enable')) patch.enabled = true;
      if (argv.includes('--disable')) patch.enabled = false;
      if (argv.includes('--rotate-secret')) patch.rotateSecret = true;
      if (arg('grace-hours', argv) !== undefined) patch.graceHours = Number(arg('grace-hours', argv));
      const r = await svc.update(need(), patch, actor);
      if (json) return print(r);
      console.log(`updated ${r.webhook.id}`);
      if (r.secret) console.log(`new signing secret (shown once): ${r.secret}${r.webhook.signing?.previousSecretValidUntil ? `; the old one also signs until ${r.webhook.signing.previousSecretValidUntil}` : ''}`);
      return;
    }
    if (cmd === 'delete') return print(await svc.delete(need(), actor));
    if (cmd === 'test') {
      const r = await svc.test(need(), {}, actor);
      if (json) return print(r);
      console.log(`queued test delivery ${r.delivery.id} (webhook-id ${r.delivery.messageId}); the running server sends it. Check: ${cliName} webhooks deliveries ${id}`);
      return;
    }
    if (cmd === 'deliveries') {
      const r = await svc.listDeliveries(need(), { status: arg('status', argv), limit: arg('limit', argv) });
      if (json) return print(r);
      console.log(`counts: ${JSON.stringify(r.counts)}`);
      for (const d of r.deliveries) console.log(`${d.id}  ${d.status.padEnd(10)} ${d.eventType.padEnd(22)} attempts ${d.attempts}  ${d.lastStatus ?? ''} ${d.lastError ?? ''}  (webhook-id ${d.messageId})`);
      return;
    }
    if (cmd === 'replay') {
      if (!pos[1]) throw new Error(`usage: ${cliName} webhooks replay <webhookId> <deliveryId>`);
      return print(await svc.replay(need(), pos[1], actor));
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

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
 * `renderweld licence ...`: works on the database directly (no running server
 * needed). A running server reads the stored state at its next check; a key
 * stored here reaches a running server after a restart (D-032).
 */
async function licence(cmd: string | undefined, argv: string[], config: ServerConfig): Promise<void> {
  if (!['status', 'activate', 'deactivate'].includes(cmd ?? '')) {
    console.log(usage());
    process.exitCode = 1;
    return;
  }
  const json = argv.includes('--json');
  const { db } = await prepareDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrate: config.migrateOnStart, connectTimeoutSeconds: config.dbConnectTimeoutSeconds });
  try {
    const repos = db.repositories();
    const settings = new RuntimeConfig(repos, config.sources);
    await settings.load();
    const manager = createLicenceManager(settings, repos, { timers: false, dataDir: config.dataDir, log: json ? undefined : (_l, line) => console.error(line) });
    await manager.init();
    let r: LicenceReport;
    if (cmd === 'status') {
      r = argv.includes('--check') ? await manager.check('cli') : manager.report();
    } else if (cmd === 'activate') {
      const input = readRenamedEnv(process.env, 'REELFORGE_LICENCE_KEY_INPUT');
      if (input.conflict) throw new Error(input.conflict);
      if (input.legacy && !argv.some((a) => !a.startsWith('--'))) console.error(renameWarning('REELFORGE_LICENCE_KEY_INPUT'));
      const key = argv.find((a) => !a.startsWith('--')) ?? input.value;
      if (key) {
        const { changes } = await settings.update({ 'licence.key': key.trim() });
        await repos.audit.write({ actorType: 'cli', action: 'config.update', targetType: 'config', data: { changes } });
      } else if (!manager.report().key) {
        console.error(`no licence key is set: ${cliName} licence activate <KEY>`);
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

/** `renderweld config check`: validate the file and environment without starting anything. Exit 1 on errors. */
function configCheck(argv: string[]): void {
  const file = arg('file', argv);
  // --file replaces RENDERWELD_CONFIG and its old name REELFORGE_CONFIG.
  const env = file ? { ...process.env, RENDERWELD_CONFIG: file, REELFORGE_CONFIG: undefined } : process.env;
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
    const primary = parseDatabaseUrl(config.databaseUrl);
    try {
      if (config.databaseReadUrl) parseReadUrl(config.databaseReadUrl, primary);
    } catch (e) {
      problems.push(`database.readUrl: ${(e as Error).message}`);
    }
  } catch (e) {
    // parseDatabaseUrl messages redact the URL.
    problems.push(`database.url: ${(e as Error).message}`);
  }
  const counts: Record<string, number> = {};
  for (const s of config.resolved.settings.values()) counts[s.source] = (counts[s.source] ?? 0) + 1;
  const warnings = [...config.resolved.warnings];
  const secretKey = secretKeyProblem(config.resolved);
  if (secretKey.error) problems.push(`security.secretKey: ${secretKey.error}`);
  if (secretKey.warning) warnings.push(secretKey.warning);
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
  // Which variable supplied each value from the environment (RENDERWELD_* or an old REELFORGE_* name, #412).
  for (const s of config.resolved.settings.values()) {
    if (s.source !== 'env' || !s.origin) continue;
    const note = legacyNote(s.origin);
    console.log(`  ${s.def.key} <- ${s.origin}${note ? ` (${note})` : ''}`);
  }
  for (const w of warnings) console.log(`  ! ${w}`);
}

function printReport(r: ConfigReport, note?: string) {
  console.log(`edition: ${r.edition}    config file: ${r.configFile ?? '(none)'}    secret key: ${r.secretKey}${note ? `    ${note}` : ''}`);
  const width = Math.max(...r.settings.map((s) => s.key.length));
  for (const s of r.settings) {
    const where = s.source === 'default' ? 'default' : `${s.source}${s.origin && s.origin !== 'database' ? `: ${s.origin}` : ''}`;
    // The variable that supplied the value is in `where`; an old REELFORGE_* name also gets a note (#412).
    const note = s.source === 'env' ? legacyNote(s.origin) : '';
    console.log(`${s.key.padEnd(width)}  ${JSON.stringify(s.value)}  (${where}${s.scope === 'startup' ? ', start-up only' : ''}${s.error ? `; ${s.error}` : ''})${note ? `  [${note}]` : ''}`);
  }
  for (const w of r.warnings) console.log(`! ${w}`);
}

/** `renderweld config show`: the effective configuration with the database's runtime settings (unless --offline), secrets redacted. */
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
    const runtime = new RuntimeConfig(db ? db.repositories() : (await import('@renderweld/core')).createMemoryRepositories(), config.sources);
    await runtime.load();
    const report = runtime.report();
    if (argv.includes('--json')) console.log(JSON.stringify(note ? { ...report, note } : report, null, 2));
    else printReport(report, note);
  } finally {
    await db?.close();
  }
}

/** `renderweld worker --once`: one job per process, for job platforms (D-100). */
async function worker(args: string[]): Promise<void> {
  if (!args.includes('--once')) {
    console.error(`usage: ${cliName} worker --once [--job <id>] [--wait-ms N]\nA long-running worker is the server with REELFORGE_ROLE=worker (docs/providers/queue-and-scaling.md).`);
    process.exit(1);
  }
  const opts = onceArgs(args);
  // As in main.ts: the configuration reads a copy; render child processes never inherit RenderWeld secrets (D-086).
  const env = { ...process.env };
  scrubSecretEnv(process.env);
  process.exit(await runWorkerOnce(env, opts));
}

/**
 * The CLI. `renderweld` is its name (cli.ts runs as `renderweld`); the old
 * name `reelforge` (reelforge.ts) runs the same commands after a one-line
 * notice on stderr (#412; stdout stays the same for scripts that parse it).
 */
export async function runCli(argv: string[], name: CliName = 'renderweld'): Promise<void> {
  cliName = name;
  return main(argv);
}

export type CliName = 'renderweld' | 'reelforge';
let cliName: CliName = 'renderweld';
/** The usage text under the name this CLI was started with. */
const usage = () => USAGE.replace(/^ {2}renderweld /gm, `  ${cliName} `);

async function main(argv: string[]) {
  const [group, cmd, ...rest] = argv;
  if (group === 'worker') return worker(argv.slice(1));
  if (group === 'config' && cmd === 'check') return configCheck(rest);
  const config = loadConfig();
  if (group === 'config' && cmd === 'show') return configShow(rest, config);
  const log = (line: string) => console.log(line);
  if (group === 'licence' || group === 'license') return licence(cmd, rest, config);
  if (group === 'storage') return storage(cmd, rest, config);
  if (group === 'skills') return skills(cmd, rest, config);

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
  if (group === 'webhooks' || group === 'webhook') return webhooks(cmd, rest, config);
  if (group !== 'keys' || !['create', 'list', 'show', 'update', 'rotate', 'revoke', 'delete'].includes(cmd ?? '')) {
    console.log(usage());
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
  const mp = arg('max-priority', args);
  if (mp !== undefined) o.maxPriority = mp === 'none' ? null : (mp as KeyOptions['maxPriority']);
  return o;
}

function describeKey(k: PublicKey): string {
  const limits = [
    k.expiresAt ? `expires ${k.expiresAt}` : '',
    k.rateLimitPerMinute !== undefined ? `${k.rateLimitPerMinute}/min` : '',
    k.rendersPerDay !== undefined ? `${k.rendersPerDay} renders/day` : '',
    k.rendersPerMonth !== undefined ? `${k.rendersPerMonth} renders/month` : '',
    k.ipAllowlist?.length ? `from ${k.ipAllowlist.join(',')}` : '',
    k.maxPriority ? `priority up to ${k.maxPriority}` : '',
    k.previousSecretExpiresAt ? `old secret valid until ${k.previousSecretExpiresAt}` : '',
  ].filter(Boolean);
  return `${k.id}  ${k.prefix}…  ${k.name.padEnd(20)} ${k.status.padEnd(8)} ${k.scopes.join(',').padEnd(24)} created ${k.createdAt}${k.lastUsedAt ? `, last used ${k.lastUsedAt}` : ''}${limits.length ? `  [${limits.join('; ')}]` : ''}`;
}

/** `renderweld keys ...`: the same lifecycle as create_key / rotate_key / revoke_key, audit-logged as the CLI. */
async function keys(cmd: string, rest: string[], config: ServerConfig): Promise<void> {
  const { db } = await prepareDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrate: config.migrateOnStart, connectTimeoutSeconds: config.dbConnectTimeoutSeconds });
  try {
    // --workspace: keys of another workspace (#304); default: the default workspace.
    const workspace = arg('workspace', rest) ?? DEFAULT_WORKSPACE_ID;
    const ws = await db.repositories().workspaces.get(workspace);
    if (!ws || ws.status === 'deleted') {
      console.error(`no workspace "${workspace}"${ws ? ' (it is deleted)' : ''}; list them with GET /v1/workspaces (owner key)`);
      process.exitCode = 1;
      return;
    }
    const repos = db.repositories(workspace);
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
      console.log(usage());
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

/** `renderweld audit list|export|sweep`. */
async function audit(cmd: string | undefined, rest: string[], config: ServerConfig): Promise<void> {
  if (!['list', 'export', 'sweep'].includes(cmd ?? '')) {
    console.log(usage());
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

/** Run as a program (not imported by reelforge.ts or a test). */
function isEntry(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  runCli(process.argv.slice(2), 'renderweld').catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
