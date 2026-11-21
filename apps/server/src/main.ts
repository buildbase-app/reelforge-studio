import { startServer } from './server';

const started = await startServer().catch((e) => {
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
