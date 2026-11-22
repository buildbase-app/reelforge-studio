import { scrubSecretEnv } from '@reelforge/core';
import { prepareDatabase } from '@reelforge/db';
import { loadConfig } from './config';
import { startServer } from './server';

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
      log: (line) => console.log(`[reelforge] ${line}`),
    });
    console.log(`[reelforge] database: ${db.kind} ${db.displayUrl}; ${migrated.length ? `applied ${migrated.join(', ')}` : 'schema is up to date'}`);
    await db.close();
    process.exit(0);
  } catch (e) {
    console.error(`[reelforge] migration failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

// The configuration is read from a copy of the environment; the process environment
// then loses every ReelForge secret, so render child processes (browsers, the
// HyperFrames CLI, FFmpeg, Remotion's Chrome) never inherit them (D-086).
const env = { ...process.env };
scrubSecretEnv(process.env);
const started = await startServer({}, { env }).catch((e) => {
  console.error(`[reelforge] failed to start: ${(e as Error).message}`);
  process.exit(1);
});

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`[reelforge] ${sig}: shutting down`);
    await started.close();
    process.exit(0);
  });
}
