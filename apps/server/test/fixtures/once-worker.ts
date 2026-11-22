/**
 * `reelforge worker --once` with fake engines (worker-once.processes.test.ts):
 * the same runWorkerOnce() the CLI and main.ts call, so start-up, the role
 * guard, the claim, signals and exit statuses are the real ones; only the
 * engines are fakes (no browser). FAKE_DELAY_PER_FRAME_MS slows them down,
 * FAKE_FAIL=1 makes them fail.
 */
import { PluginRegistry, scrubSecretEnv } from '@reelforge/core';
import { fakeEngine } from '../../../../packages/core/test/helpers';
import { onceArgs, runWorkerOnce } from '../../src/worker';

const delayPerFrameMs = Number(process.env.FAKE_DELAY_PER_FRAME_MS ?? 0);
const fail = process.env.FAKE_FAIL === '1';
const env = { ...process.env };
scrubSecretEnv(process.env);
const code = await runWorkerOnce(env, {
  ...onceArgs(process.argv.slice(2)),
  registry: () => new PluginRegistry().registerEngine(fakeEngine('remotion', { delayPerFrameMs, fail })).registerEngine(fakeEngine('motion-canvas', { delayPerFrameMs, fail })),
}).catch((e) => {
  console.error(`worker --once failed to start: ${(e as Error).message}`);
  return 1;
});
process.exit(code);
