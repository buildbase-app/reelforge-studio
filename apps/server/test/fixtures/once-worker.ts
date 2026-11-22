/**
 * `reelforge worker --once` with fake engines (worker-once.processes.test.ts):
 * the same runWorkerOnce() the CLI and main.ts call, so start-up, the role
 * guard, the claim, signals and exit statuses are the real ones; only the
 * engines are fakes (no browser). FAKE_DELAY_PER_FRAME_MS slows them down,
 * FAKE_FAIL=1 makes them fail. GATE_CLAIM=1 holds the claim open before its
 * status event (as QUE-14 does), prints "claim gated" and lets it go on only
 * after SIGTERM has started the shutdown: SIGTERM in the claim gap (#172).
 */
import { DEFAULT_WORKSPACE_ID, PluginRegistry, scrubSecretEnv, type Repositories } from '@reelforge/core';
import { Database, createPrismaRepositories } from '@reelforge/db';
import { fakeEngine } from '../../../../packages/core/test/helpers';
import { onceArgs, runWorkerOnce } from '../../src/worker';

const delayPerFrameMs = Number(process.env.FAKE_DELAY_PER_FRAME_MS ?? 0);
const fail = process.env.FAKE_FAIL === '1';
const env = { ...process.env };
scrubSecretEnv(process.env);
if (process.env.GATE_CLAIM === '1') {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  // Registered before runWorkerOnce's handler, so it runs first: open the gate once that handler has started shutdown().
  process.on('SIGTERM', () => setImmediate(open));
  const gatedRepos = new WeakMap<Database, Repositories>();
  Database.prototype.repositories = function (this: Database, workspaceId = DEFAULT_WORKSPACE_ID) {
    let r = gatedRepos.get(this);
    if (!r) {
      const gated = this.prisma.$extends({
        query: {
          jobEvent: {
            async create({ args, query }) {
              const data = args.data as { type?: string; message?: string };
              if (data.type === 'status' && data.message === 'running') {
                console.log('claim gated');
                await opened;
              }
              return query(args);
            },
          },
        },
      }) as unknown as Database['prisma'];
      r = createPrismaRepositories(gated, workspaceId, this.kind);
      gatedRepos.set(this, r);
    }
    return r;
  };
}
const code = await runWorkerOnce(env, {
  ...onceArgs(process.argv.slice(2)),
  registry: () => new PluginRegistry().registerEngine(fakeEngine('remotion', { delayPerFrameMs, fail })).registerEngine(fakeEngine('motion-canvas', { delayPerFrameMs, fail })),
}).catch((e) => {
  console.error(`worker --once failed to start: ${(e as Error).message}`);
  return 1;
});
process.exit(code);
