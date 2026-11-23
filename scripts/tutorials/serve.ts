/**
 * Starts the studio exactly like `pnpm start` (apps/server/src/main.ts). It has
 * its own file name so that a `pkill -f apps/server/src/main.ts` run for
 * another local server does not stop a proof run halfway.
 */
export {};

const entry = '../../apps/server/src/main.ts';
await import(entry);
