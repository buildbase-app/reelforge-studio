import { scrubSecretEnv } from '@renderweld/core';
import { prepareDatabase } from '@renderweld/db';
import { loadConfig } from './config';
import { startServer } from './server';
import { onceArgs, runWorkerOnce } from './worker';

// `--migrate-only`: apply database migrations (and the one-time v0.1 import), then exit.
// For deploys that migrate in a separate step (an init container, a release command).
if (process.argv.includes('--migrate-only')) {
  try {
    const config = loadConfig();
    const { db, migrated } = await prepareDatabase({
      url: config.databaseUrl,
      dataDir: config.dataDir,
      migrate: true,
      connectTimeoutSeconds: config.dbConnectTimeoutSeconds,
      log: (line) => console.log(`[renderweld] ${line}`),
    });
    console.log(`[renderweld] database: ${db.kind} ${db.displayUrl}; ${migrated.length ? `applied ${migrated.join(', ')}` : 'schema is up to date'}`);
    await db.close();
    process.exit(0);
  } catch (e) {
    console.error(`[renderweld] migration failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

// The configuration is read from a copy of the environment; the process environment
// then loses every RenderWeld secret, so render child processes (browsers, the
// HyperFrames CLI, FFmpeg, Remotion's Chrome) never inherit them (D-086).
const env = { ...process.env };
scrubSecretEnv(process.env);

// `REELFORGE_WORKER_ONCE=1` (D-100): claim at most one job, render it and exit (job platforms).
if (loadConfig(env).resolved.config.server.workerOnce) {
  const code = await runWorkerOnce(env, onceArgs(process.argv.slice(2))).catch((e) => {
    console.error(`[renderweld] worker --once failed to start: ${(e as Error).message}`);
    return 1;
  });
  process.exit(code);
}
const started = await startServer({}, { env }).catch((e) => {
  console.error(`[renderweld] failed to start: ${(e as Error).message}`);
  process.exit(1);
});

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`[renderweld] ${sig}: shutting down`);
    await started.close();
    process.exit(0);
  });
}
