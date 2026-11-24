#!/usr/bin/env -S npx tsx
/**
 * `reelforge`: the old name of the `renderweld` CLI (#412). Same commands and
 * the same stdout; one deprecation line on stderr only, so scripts that parse
 * stdout keep working. Removed after the date announced in the release notes
 * (docs/RENAMED.md).
 */
import { runCli } from './cli';

const REELFORGE_CLI_NOTICE =
  'reelforge: this command is now called renderweld (ReelForge is now RenderWeld); "reelforge" keeps working until a removal date announced in the release notes (docs/RENAMED.md).';

process.stderr.write(`${REELFORGE_CLI_NOTICE}\n`);
runCli(process.argv.slice(2), 'reelforge').catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
