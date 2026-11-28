// Every error code the server can answer is listed in the REST error table
// (docs/public/api/rest-api.md), so the table cannot drift again (#406).
// Codes are read from the source: `new ApiError('code', ...)`,
// `errorBody('code', ...)` and `{ status: NNN, code: 'code' }`.
// Run: pnpm test:docs (node --test, no dependencies).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The TypeScript sources under a folder, tests left out. */
function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules' && name !== 'test' && name !== 'dist') out.push(...sources(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const CODE = [/new ApiError\(\s*'([a-z_]+)'/g, /errorBody\(\s*'([a-z_]+)'/g, /\{ status: \d{3}, code: '([a-z_]+)'/g];

function codesInSource() {
  const dirs = [join(root, 'apps', 'server', 'src'), ...readdirSync(join(root, 'packages')).map((p) => join(root, 'packages', p, 'src'))];
  const codes = new Set();
  for (const dir of dirs) {
    let files;
    try {
      files = sources(dir);
    } catch {
      continue; // a package without src
    }
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const re of CODE) for (const m of text.matchAll(re)) codes.add(m[1]);
    }
  }
  return codes;
}

describe('REST error table (#406)', () => {
  it('lists every error code the server returns', () => {
    const doc = readFileSync(join(root, 'docs', 'public', 'api', 'rest-api.md'), 'utf8');
    const start = doc.indexOf('| Status | Codes |');
    assert.ok(start >= 0, 'the error table is in docs/public/api/rest-api.md');
    const table = doc.slice(start, doc.indexOf('\n\n', start));
    const codes = codesInSource();
    assert.ok(codes.size > 40, `found ${codes.size} codes in the source; the patterns no longer match`);
    const missing = [...codes].filter((c) => !table.includes(`\`${c}\``)).sort();
    assert.deepEqual(missing, [], `add these codes to the error table in docs/public/api/rest-api.md: ${missing.join(', ')}`);
  });
});
