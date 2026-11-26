/**
 * Writes prisma/<provider>/schema.prisma from prisma/base.prisma (the single
 * source). `--check` fails if a generated schema is out of date (CI/tests).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSchema, PROVIDERS } from '../src/schema-source';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = readFileSync(join(root, 'prisma/base.prisma'), 'utf8');
const check = process.argv.includes('--check');
let stale = 0;
for (const p of PROVIDERS) {
  const file = join(root, 'prisma', p, 'schema.prisma');
  const next = renderSchema(base, p);
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // first run
  }
  if (current === next) continue;
  if (check) {
    console.error(`${file} is out of date; run pnpm --filter @renderweld/db schemas`);
    stale++;
    continue;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  console.log(`wrote ${file}`);
}
if (stale) process.exit(1);
