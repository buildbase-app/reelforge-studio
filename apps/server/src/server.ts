import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { OutboxRelay, ReelforgeService, chromiumSandbox, createBrokerDispatch, effectiveQueueMode, isBrokerDispatch, type PluginRegistry, type ServiceConfig } from '@reelforge/core';
import { createNotifyListener, defaultDatabaseUrl, notifyChannel, pooledSchemaWarning, prepareDatabase, READ_REPLICA_READS, type Database } from '@reelforge/db';
import { createApp } from './app';
import { applyServerSettings, createLogger, exportProcessEnv, loadConfig, type ServerConfig } from './config';
import { secretValues } from './observability/logger';
import { Observability, observabilitySettings } from './observability/telemetry';
import { createDefaultRegistry } from './registry';
import { scalingProblems } from './scaling';

export const SERVER_VERSION = '0.1.0';

export interface StartedServer {
  url: string;
  port: number;
  service: ReelforgeService;
  config: ServerConfig;
  db: Database;
  observability: Observability;
  /** The server's logger (redacts secrets; console or OTLP per the settings). */
  log: (level: 'debug' | 'info' | 'warn' | 'error', line: string) => void;
  close(): Promise<void>;
}

/** Build the service and app, apply the bootstrap key, and listen. */
export async function startServer(
  overrides: Partial<ServerConfig> = {},
  opts: {
    /** The plugins; a function receives the environment object providers must read (runtime settings are written into it). */
    registry?: PluginRegistry | ((providerEnv: NodeJS.ProcessEnv) => PluginRegistry);
    env?: NodeJS.ProcessEnv;
    quiet?: boolean;
    /** Where log lines go instead of stdout/stderr (tests). */
    logWrite?: (level: 'debug' | 'info' | 'warn' | 'error', line: string) => void;
    /** Licence checks: tests inject the licence API, fetch or clock (ServiceConfig.licence). */
    licence?: ServiceConfig['licence'];
    /** Storage driver factory / sweep (tests; ServiceConfig.storage). */
    storage?: ServiceConfig['storage'];
    /** Audit sink plugins (selected by audit.sinks) and the clock (tests). */
    auditSinks?: ServiceConfig['auditSinks'];
    now?: ServiceConfig['now'];
    /** Job queue overrides (tests: short leases, a fixed worker id; ServiceConfig.queue). */
    queue?: ServiceConfig['queue'];
    /**
     * `worker --once` (D-100): no HTTP listener, no webhook delivery worker or
     * maintenance timers, and the queue claims only through jobs.runOnce().
     */
    once?: boolean;
  } = {}
): Promise<StartedServer> {
  const env = opts.env ?? process.env;
  const config: ServerConfig = { ...loadConfig(env), ...overrides };
  // A data directory given in code (tests) also moves the default SQLite file.
  if (overrides.dataDir && !overrides.databaseUrl && config.resolved.settings.get('database.url')?.source === 'default') {
    config.databaseUrl = defaultDatabaseUrl(config.dataDir);
  }
  exportProcessEnv(config.resolved);
  await mkdir(config.dataDir, { recursive: true });
  const logger = createLogger(config, opts.quiet, opts.logWrite);
  const log = (line: string) => logger.log('info', line);
  if (config.sources.file) log(`config file: ${config.sources.file.path}`);
  for (const w of config.resolved.warnings) logger.log('warn', w);
  if (!chromiumSandbox()) {
    logger.log(
      'warn',
      process.env.REELFORGE_CHROMIUM_NO_SANDBOX === '1'
        ? "REELFORGE_CHROMIUM_NO_SANDBOX=1: Chromium's own sandbox is OFF for every engine (explicit opt-out). Agent-supplied scenes then run in a renderer with the server's privileges; see docs/security/HARDENING.md"
        : "Chromium's own sandbox is OFF because the server runs as root; run as a non-root user (docs/security/HARDENING.md)"
    );
  }
  const edition = config.resolved.build.edition;
  // More than one instance needs a shared database and shared storage (D-076): refuse a role that would lose jobs or files.
  const scaling = scalingProblems(config.resolved, config.databaseUrl);
  for (const w of scaling.warnings) logger.log('warn', w);
  if (scaling.errors.length) throw new Error(`refusing to start: ${scaling.errors.join(' | ')}`);
  const role = config.resolved.config.server.role;
  // Exporters from the file and env now; runtime settings from the database are applied once it is open.
  const obs = new Observability(observabilitySettings(config.resolved.config, SERVER_VERSION, edition), logger);
  // Workers need few connections (claims, heartbeats, progress): a small pool unless the URL sets connection_limit (D-104).
  const workerPool = config.resolved.config.database.workerConnectionLimit;
  // Queue dispatch (D-105): with `notify` every transaction that queues a job sends NOTIFY (api and workers alike).
  const queueCfg = config.resolved.config.queue;
  const databaseQueue = (opts.queue?.mode ?? effectiveQueueMode(role, queueCfg.driver)) === 'database';
  const notify = queueCfg.dispatch === 'notify' && databaseQueue;
  // `sqs` / `redis` (D-105): job transactions write outbox rows; this instance's relay publishes them to the broker.
  const brokerDriver = databaseQueue && isBrokerDispatch(queueCfg.dispatch) ? queueCfg.dispatch : undefined;
  // Runtime settings (credentials, the Redis password) are read on every broker call; the service exists only later.
  let current: (() => typeof queueCfg) | undefined;
  const broker = brokerDriver ? createBrokerDispatch(brokerDriver, () => current?.() ?? queueCfg, { log: (level, line) => logger.log(level, line) }) : undefined;
  const { db, imported } = await prepareDatabase({
    url: config.databaseUrl,
    readUrl: config.databaseReadUrl,
    defaultConnectionLimit: role === 'worker' && workerPool > 0 ? workerPool : undefined,
    dataDir: config.dataDir,
    migrate: config.migrateOnStart,
    connectTimeoutSeconds: config.dbConnectTimeoutSeconds,
    log,
    ...(notify ? { readySignal: { kind: 'notify' as const, channel: notifyChannel(config.databaseUrl), announceClaimsWithinMs: Math.max(2000, queueCfg.notifyJitterMs * 4) } } : {}),
    ...(broker ? { readySignal: { kind: 'outbox' as const } } : {}),
  });
  const repositories = db.repositories();
  const relay = broker
    ? new OutboxRelay({ repo: repositories.dispatchOutbox, publisher: broker.publisher, sweepMs: queueCfg.dispatchFallbackSeconds * 1000, telemetry: obs.telemetry, log: (level, line) => logger.log(level, line) })
    : undefined;
  // Claiming instances LISTEN on their own direct session connection (database.directUrl, else database.url).
  const listener =
    notify && role !== 'api'
      ? createNotifyListener(db, { directUrl: config.resolved.config.database.directUrl, pingMs: queueCfg.dispatchFallbackSeconds * 1000, log: (level, line) => logger.log(level, line) })
      : broker && role !== 'api'
        ? broker.listener(opts.queue?.workerId ? { consumer: opts.queue.workerId } : {})
        : undefined;
  const dispatchOverride = listener || relay
    ? {
        dispatch: {
          driver: queueCfg.dispatch,
          ...opts.queue?.dispatch,
          ...(listener ? { listener } : {}),
          ...(relay ? { onPublished: () => relay.kick(), relay: () => relay.status() } : {}),
        },
      }
    : {};
  if (imported) {
    const { warnings, ...counts } = imported;
    log(`imported v0.1 data from ${config.dataDir}: ${JSON.stringify(counts)}${warnings.length ? ` (${warnings.length} warnings)` : ''}`);
  }
  // Providers read their keys from this object; keys set through the API are written into it.
  const providerEnv: NodeJS.ProcessEnv = { ...env };
  let service: ReelforgeService;
  try {
    const registry = typeof opts.registry === 'function' ? opts.registry(providerEnv) : (opts.registry ?? createDefaultRegistry(providerEnv));
    service = await ReelforgeService.create(registry, {
      repositories,
      providerEnv,
      dataDir: config.dataDir,
      cacheDir: config.cacheDir,
      renderConcurrency: config.renderConcurrency,
      serverVersion: SERVER_VERSION,
      publicUrl: config.publicUrl,
      maxUploadBytes: config.maxUploadBytes,
      configSources: config.sources,
      licence: opts.licence,
      storage: opts.storage,
      auditSinks: opts.auditSinks,
      now: opts.now,
      log: logger.log,
      telemetry: obs.telemetry,
      ...(opts.queue || opts.once || listener || relay ? { queue: { ...opts.queue, ...(opts.once ? { once: true } : {}), ...dispatchOverride } } : {}),
      ...(opts.once ? { webhooks: { worker: false }, maintenance: false, storage: { ...opts.storage, sweep: false } } : {}),
    });
  } catch (e) {
    await broker?.publisher.close?.().catch(() => undefined);
    await obs.shutdown();
    await db.close().catch(() => undefined);
    throw e;
  }
  current = () => service.settings.current.config.queue;
  relay?.start();
  // Runtime settings stored in the database win over the file and environment; changes apply at once.
  applyServerSettings(config, service.settings.current, null);
  const applyObservability = (resolved: typeof service.settings.current) => {
    logger.redactor.setSecrets(secretValues(resolved, service.settings.providerEnvOverlay()));
    obs.apply(observabilitySettings(resolved.config, SERVER_VERSION, edition));
  };
  applyObservability(service.settings.current);
  obs.observe(service);
  service.settings.onChange((resolved, keys) => {
    applyServerSettings(config, resolved, keys);
    applyObservability(resolved);
    logger.log('info', `configuration changed at runtime: ${keys.join(', ')}`);
  });
  if (await service.keys.bootstrap(config.bootstrapKey)) {
    log('stored REELFORGE_BOOTSTRAP_KEY as admin key "bootstrap"');
  }
  const app = createApp({ service, config, observability: obs });
  const server: ServerType | null = opts.once
    ? null
    : await new Promise((resolve) => {
        const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(s));
      });
  // Agents poll with keep-alive connections; a short server keep-alive races with
  // their next request (ECONNRESET) while a render keeps the event loop busy.
  if (server) {
    const http = server as unknown as { keepAliveTimeout: number; headersTimeout: number };
    http.keepAliveTimeout = 65_000;
    http.headersTimeout = 66_000;
  }
  const port = server ? (server.address() as AddressInfo).port : 0;
  const shownHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const url = server ? `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${port}` : '';
  log(server ? `ReelForge Studio ${SERVER_VERSION} listening on ${url} (data: ${config.dataDir})` : `ReelForge Studio ${SERVER_VERSION} worker --once (no HTTP listener; data: ${config.dataDir})`);
  if (role === 'worker') {
    if (server) log(`role worker: renders jobs from the database queue (worker ${service.jobs.workerId}, ${service.jobs.concurrency} at a time); serves only /healthz, /readyz and /metrics`);
    log('licence: this worker never calls the licence server; it applies the licence state the api instances store in the database (re-read every minute)');
  } else if (server) log(`REST ${url}/v1  MCP ${url}/mcp`);
  log(`role: ${role}; job queue: ${service.jobs.mode}${service.jobs.mode === 'database' ? ` (worker ${service.jobs.workerId}, ${service.jobs.runJobs ? `renders ${service.jobs.concurrency} at a time` : 'enqueues only, never renders'})` : ''}`);
  if (service.jobs.mode === 'database') {
    log(
      notify
        ? `queue dispatch: notify (PostgreSQL LISTEN/NOTIFY${listener ? `; listening on ${config.resolved.config.database.directUrl ? 'database.directUrl' : 'database.url'}, fallback poll every ${queueCfg.dispatchFallbackSeconds} s` : '; this instance only publishes'})`
        : broker
          ? `queue dispatch: ${broker.driver} (${broker.describe()}; ${listener ? `listening as consumer, fallback poll every ${queueCfg.dispatchFallbackSeconds} s` : 'this instance only publishes'}; outbox relay on this instance)`
          : `queue dispatch: poll (every ${queueCfg.pollIntervalMs} ms, backing off to ${queueCfg.pollMaxIntervalMs} ms when idle)`
    );
  }
  log(`database: ${db.kind} ${db.displayUrl}${db.kind === 'sqlite' ? '' : ` (pool ${db.poolSize})`}`);
  // ?schema= behind a transaction-mode pooler (#191): safe for this version, a warning for older processes and the operator's own SQL.
  const pooled = await pooledSchemaWarning(config.databaseUrl);
  if (pooled) logger.log('warn', pooled);
  if (db.readDisplayUrl) log(`database read replica: ${db.readDisplayUrl} (pool ${db.readPoolSize}); lists only: ${READ_REPLICA_READS.join(', ')}`);
  log(`storage: ${service.storage.driver.id} ${JSON.stringify(service.storage.driver.describe())}`);
  if (existsSync(join(config.dataDir, 'secrets.json'))) {
    logger.log('warn', `${join(config.dataDir, 'secrets.json')} (v0.1) still holds provider keys in plain text; they are in the database now${service.settings.cipher ? ' (encrypted)' : ''}: delete the file once you have checked them`);
  }
  if (!service.settings.cipher) log('REELFORGE_SECRET_KEY is not set: provider keys and other secrets cannot be stored through the API (see docs/CONFIG.md)');
  if ((await service.keys.count()) === 0) {
    log('no API keys yet: run `pnpm keys:create --name me` or set REELFORGE_BOOTSTRAP_KEY');
  }
  return {
    url,
    port,
    service,
    config,
    db,
    observability: obs,
    log: (level, line) => logger.log(level, line),
    close: async () => {
      if (service.jobs.mode === 'database') {
        // Stop claiming; let running jobs finish within the grace period, hand the rest back to the queue.
        const grace = config.resolved.config.queue.shutdownGraceSeconds;
        const r = await service.jobs.shutdown(grace * 1000);
        log(`shutdown: stopped claiming jobs; ${r.finished} running job(s) finished${r.released ? `, ${r.released} handed back to the queue after ${grace} s` : ''}`);
      }
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        });
      }
      await service.stop();
      await service.jobs.flush();
      // After the queue settled: rows of jobs handed back on shutdown are published before the relay stops.
      if (relay) {
        await relay.runOnce().catch(() => undefined);
        await relay.stop();
        await broker?.publisher.close?.().catch(() => undefined);
      }
      await obs.shutdown();
      await db.close();
    },
  };
}
