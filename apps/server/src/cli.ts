#!/usr/bin/env -S npx tsx
/**
 * reelforge CLI (operator tasks that need no running server).
 *
 *   pnpm keys:create [--name NAME] [--scopes read,write,render,admin]
 *   pnpm reelforge keys list
 *   pnpm reelforge keys delete <keyId>
 *
 * Uses REELFORGE_DATA_DIR (default ./data). The key is printed once.
 */
import { KeyStore, SCOPES, type Scope } from '@reelforge/core';
import { loadConfig } from './config';

function arg(name: string, args: string[]): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

async function main(argv: string[]) {
  const [group, cmd, ...rest] = argv;
  const keys = new KeyStore(loadConfig().dataDir);
  if (group === 'keys' && cmd === 'create') {
    const name = arg('name', rest) ?? 'default';
    const scopes = (arg('scopes', rest) ?? 'read,write,render').split(',').map((s) => s.trim()) as Scope[];
    const { key, record } = await keys.create(name, scopes);
    console.log(`Created API key "${record.name}" (${record.id}) with scopes ${record.scopes.join(', ')}.`);
    console.log('Store it now; it is not shown again:\n');
    console.log(key);
    return;
  }
  if (group === 'keys' && cmd === 'list') {
    for (const k of await keys.list()) console.log(`${k.id}  ${k.prefix}…  ${k.name.padEnd(20)} ${k.scopes.join(',').padEnd(24)} created ${k.createdAt}${k.lastUsedAt ? `, last used ${k.lastUsedAt}` : ''}`);
    return;
  }
  if (group === 'keys' && cmd === 'delete' && rest[0]) {
    await keys.delete(rest[0]);
    console.log(`Deleted ${rest[0]}`);
    return;
  }
  console.log(`usage:
  reelforge keys create [--name NAME] [--scopes ${SCOPES.join(',')}]
  reelforge keys list
  reelforge keys delete <keyId>`);
  process.exitCode = group ? 1 : 0;
}

main(process.argv.slice(2)).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
