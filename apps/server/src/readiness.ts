import { constants, existsSync } from 'node:fs';
import { access, statfs } from 'node:fs/promises';
import { browserVersion, chromiumSandbox, type ReelforgeService } from '@reelforge/core';
import { toolVersion } from '@reelforge/media-pipeline';
import type { Observability } from './observability/telemetry';

/** One dependency in GET /readyz (D-053). */
export interface DependencyStatus {
  status: 'ok' | 'error' | 'not_configured';
  /** Whether /readyz answers 503 while this dependency is not ok. */
  required: boolean;
  latencyMs?: number;
  detail?: string;
  [extra: string]: unknown;
}

export interface Readiness {
  ok: boolean;
  /** One line per required check ("ok" or the problem); kept from v0.1 for existing probes. */
  checks: Record<string, string>;
  dependencies: Record<string, DependencyStatus>;
  engines: Array<{ id: string; ok: boolean; reason?: string }>;
  /** Chromium sandbox per engine and what is weaker than the defaults (admin detail only). */
  security?: { chromiumSandbox: Record<string, boolean>; warnings: string[] };
  /**
   * The licence as this instance applies it (admin detail only, D-098): a worker reads the
   * state the api instances stored and claims no render job while it disallows renders.
   * Never fails readiness: everything except rendering keeps working.
   */
  licence?: {
    status: string;
    renderAllowed: boolean;
    reason: string | null;
    checksLicenceServer: boolean;
    instanceId: string;
    checkedBy: string | null;
    lastCheckedAt: string | null;
    nextCheckAt: string | null;
    detail?: string;
  };
}

/** What anonymous callers of /readyz see: overall status and each dependency's status, nothing else (D-088). */
export interface PublicReadiness {
  ok: boolean;
  checks: Record<string, 'ok' | 'error'>;
  dependencies: Record<string, { status: DependencyStatus['status']; required: boolean }>;
  engines: Array<{ id: string; ok: boolean }>;
}

export function publicReadiness(r: Readiness): PublicReadiness {
  return {
    ok: r.ok,
    checks: Object.fromEntries(Object.entries(r.checks).map(([k, v]) => [k, v === 'ok' ? 'ok' : 'error'])),
    dependencies: Object.fromEntries(Object.entries(r.dependencies).map(([k, d]) => [k, { status: d.status, required: d.required }])),
    engines: r.engines.map((e) => ({ id: e.id, ok: e.ok })),
  };
}

const versions = new Map<string, string>();
const cachedVersion = (bin: string) => {
  let v = versions.get(bin);
  if (!v) versions.set(bin, (v = toolVersion(bin)));
  return v;
};

/** A probe never waits longer than this for one dependency (a hung database or bucket must not hang /readyz). */
const CHECK_TIMEOUT_MS = 5000;

async function timed(fn: () => Promise<DependencyStatus>): Promise<DependencyStatus> {
  const t = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<DependencyStatus>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${CHECK_TIMEOUT_MS / 1000} s`)), CHECK_TIMEOUT_MS);
  });
  const r = await Promise.race([fn(), timeout])
    .catch((e): DependencyStatus => ({ status: 'error', required: true, detail: (e as Error).message }))
    .finally(() => clearTimeout(timer));
  return { ...r, latencyMs: Math.round((performance.now() - t) * 10) / 10 };
}

/**
 * What GET /readyz reports: the database, storage, FFmpeg/ffprobe and the
 * browser, each with a status, how long the check took and what to fix.
 * The database, storage and FFmpeg are required (the API cannot work
 * without them); the browser is reported but does not fail readiness,
 * because projects, settings and downloads keep working without it and
 * each engine's availability says why renders would fail.
 */
/** Storage driver health (local disk, bucket or container), supplied by the server so probes can be cached. */
export type StorageHealth = () => Promise<{ ok: boolean; message?: string }>;

export async function readiness(service: ReelforgeService, obs?: Observability, storageHealth?: StorageHealth): Promise<Readiness> {
  const dependencies: Record<string, DependencyStatus> = {};
  let dataDirCheck = 'ok';
  let storageCheck = 'ok';
  dependencies.database = await timed(async () => {
    try {
      await Promise.race([service.repos.keys.count(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS - 500).unref())]);
      return { status: 'ok', required: true };
    } catch (e) {
      return { status: 'error', required: true, detail: (e as Error).message === 'timeout' ? 'unreachable (no answer within 4.5 s)' : 'unreachable (see the server log)' };
    }
  });
  dependencies.storage = await timed(async () => {
    const driver = service.settings.config.storage.driver;
    try {
      await access(service.dataDir, constants.W_OK);
    } catch {
      dataDirCheck = `not writable: ${service.dataDir}`;
      return { status: 'error', required: true, driver, path: service.dataDir, detail: dataDirCheck };
    }
    const fs = await statfs(service.dataDir).catch(() => null);
    const local = { driver, path: service.dataDir, ...(fs ? { freeBytes: fs.bavail * fs.bsize } : {}) };
    if (storageHealth) {
      const h = await storageHealth();
      if (!h.ok) {
        storageCheck = `unavailable (${service.storage.driver.id}): ${h.message ?? 'unknown error'}`;
        return { status: 'error', required: true, ...local, detail: storageCheck };
      }
    }
    return { status: 'ok', required: true, ...local };
  });
  dependencies.ffmpeg = await timed(async () => {
    try {
      const tools = service.tools();
      return { status: 'ok', required: true, path: tools.ffmpeg, version: cachedVersion(tools.ffmpeg), ffprobe: tools.ffprobe };
    } catch (e) {
      return { status: 'error', required: true, detail: (e as Error).message };
    }
  });
  dependencies.browser = await timed(async () => {
    const path = process.env.REELFORGE_CHROMIUM_PATH;
    if (!path) return { status: 'not_configured', required: false, detail: 'REELFORGE_CHROMIUM_PATH is not set; engines that need Chromium may not render (see engines)' };
    if (!existsSync(path)) return { status: 'error', required: false, path, detail: `REELFORGE_CHROMIUM_PATH does not exist: ${path}` };
    const version = browserVersion(path);
    return { status: 'ok', required: false, path, ...(version ? { version } : {}) };
  });

  // The job queue (D-075): which role this is, what it runs, and whether claiming works.
  const q = service.jobs.status();
  const role = service.settings.config.server.role;
  dependencies.queue = {
    status: q.paused === 'shutting down' || q.lastError ? 'error' : 'ok',
    // A worker that cannot claim (or is draining) must leave rotation; others only report it.
    required: q.paused === 'shutting down' || (role === 'worker' && Boolean(q.lastError)),
    role,
    mode: q.mode,
    renders: q.runJobs,
    workerId: q.workerId,
    running: q.running,
    queued: q.queued,
    concurrency: q.concurrency,
    ...(q.paused ? { paused: q.paused } : {}),
    ...(q.lastHeartbeatAt ? { lastHeartbeatAt: q.lastHeartbeatAt } : {}),
    // Queue housekeeping (D-106): whether this instance runs the lease recovery and the queue count, and who does.
    ...(q.housekeeping ? { housekeeping: q.housekeeping } : {}),
    ...(q.lastError ? { detail: `queue ${q.lastError.operation} failing since ${q.lastError.at}: ${q.lastError.message}` } : q.paused ? { detail: q.paused } : {}),
  };

  // Queue dispatch (D-105): the LISTEN connection of a `notify` worker, the broker connection of an `sqs` / `redis`
  // worker, and the outbox relay of every `sqs` / `redis` instance. Reported, never required: while the listener is down
  // the worker polls (queue.pollIntervalMs with backoff), so it keeps claiming; while the broker refuses publishes the
  // outbox keeps the rows and retries, and the fallback poll claims their jobs. Only the wake-up latency is lost.
  const d = q.dispatch;
  const relay = d?.relay
    ? {
        relay: {
          failing: d.relay.failing,
          published: d.relay.published,
          failed: d.relay.failed,
          dropped: d.relay.dropped,
          ...(d.relay.lastPublishedAt ? { lastPublishedAt: d.relay.lastPublishedAt } : {}),
          ...(d.relay.lastError ? { lastError: d.relay.lastError, lastErrorAt: d.relay.lastErrorAt } : {}),
        },
      }
    : {};
  const relayDetail = d?.relay?.failing ? `publishing to ${d.driver} fails (${d.relay.lastError}); the outbox keeps the job ids and retries with backoff` : undefined;
  if (d && d.listener) {
    const l = d.listener;
    const detail = [d.listening ? undefined : `the ${d.driver} listener is disconnected${l.lastError ? ` (${l.lastError})` : ''}; polling every ${q.dispatch!.pollMs} ms until it reconnects`, relayDetail].filter(Boolean).join('; ');
    dependencies.dispatch = {
      status: d.listening && !d.relay?.failing ? 'ok' : 'error',
      required: false,
      driver: d.driver,
      connected: l.connected,
      ...(l.since ? { since: l.since } : {}),
      reconnects: l.reconnects,
      fallbackSeconds: (d.fallbackMs ?? 0) / 1000,
      received: d.received,
      duplicates: d.duplicates,
      fallbackClaims: d.fallbackClaims,
      ...relay,
      ...(detail ? { detail } : {}),
    };
  } else if (d) {
    dependencies.dispatch = {
      status: d.relay?.failing ? 'error' : 'ok',
      required: false,
      driver: d.driver,
      ...relay,
      ...(d.driver === 'poll' ? { pollMs: d.pollMs } : { detail: relayDetail ? `publishes only; ${relayDetail}` : 'publishes only (this instance does not claim jobs)' }),
    };
  }

  if (obs) {
    // OTLP exporters: reported, never required (a telemetry backend being down must not take the studio out of rotation).
    const signals = obs.exportHealth();
    const failing = Object.entries(signals).filter(([, h]) => h?.ok === false);
    dependencies.telemetry = {
      status: Object.keys(signals).length === 0 ? 'not_configured' : failing.length ? 'error' : 'ok',
      required: false,
      logs: obs.settings.logsExporter,
      metrics: obs.settings.metricsExporter,
      tracing: obs.settings.tracingExporter,
      ...(Object.keys(signals).length ? { otlp: signals } : {}),
      ...(failing.length ? { detail: failing.map(([s, h]) => `OTLP ${s} export failing: ${h!.lastError}`).join('; ') } : {}),
    };
  }
  const checks: Record<string, string> = {
    dataDir: dataDirCheck,
    ...(storageHealth ? { storage: storageCheck } : {}),
    database: dependencies.database.status === 'ok' ? 'ok' : String(dependencies.database.detail),
    ffmpeg: dependencies.ffmpeg.status === 'ok' ? 'ok' : String(dependencies.ffmpeg.detail),
  };
  const engines = service.registry.listEngines().map((e) => ({ id: e.id, ...e.availability() }));
  const ok = Object.values(dependencies).every((d) => !d.required || d.status === 'ok');
  const sandbox = Object.fromEntries(service.registry.listEngines().filter((e) => e.browserSandbox).map((e) => [e.id, e.browserSandbox!()]));
  const warnings: string[] = [];
  if (!chromiumSandbox()) {
    warnings.push(
      process.env.REELFORGE_CHROMIUM_NO_SANDBOX === '1'
        ? "REELFORGE_CHROMIUM_NO_SANDBOX=1: Chromium's own sandbox is off for every engine (explicit opt-out; docs/security/HARDENING.md)"
        : "Chromium's own sandbox is off because the server runs as root"
    );
  }
  if (sandbox.remotion === false) warnings.push('Remotion always starts Chromium without its sandbox; it renders only built-in templates');
  const lic = service.getLicence();
  const licence: Readiness['licence'] = {
    status: lic.status,
    renderAllowed: lic.renderAllowed,
    reason: lic.reason,
    checksLicenceServer: lic.checksLicenceServer,
    instanceId: lic.instanceId,
    checkedBy: lic.checkedBy,
    lastCheckedAt: lic.lastCheckedAt,
    nextCheckAt: lic.nextCheckAt,
    ...(lic.renderAllowed ? {} : { detail: `${lic.message}${role === 'worker' ? ' This worker claims no render jobs until the licence allows renders.' : ''}${lic.fix ? ` Fix: ${lic.fix}` : ''}` }),
  };
  return { ok, checks, dependencies, engines, security: { chromiumSandbox: sandbox, warnings }, licence };
}
