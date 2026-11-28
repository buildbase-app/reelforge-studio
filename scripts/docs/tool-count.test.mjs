// The MCP tool count in hand-written docs must match the generated tool
// reference. Run: pnpm test:docs (node --test, no dependencies).
//
// docs/public/mcp/tools.md is generated from the server's tool registry
// (`pnpm docs:reference`, checked by apps/server/test/docs-reference.test.ts).
// README.md and docs/AGENT_PLATFORM.md state the count only
// between `<!-- mcp-tool-count -->` markers, which `pnpm docs:reference` fills
// in. This test fails when a marker drifts from the reference or when a count
// is typed by hand outside a marker.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

/** Keep in step with TOOL_COUNT_FILES in scripts/docs/reference.ts. */
const FILES = ['README.md', 'docs/AGENT_PLATFORM.md'];
const MARKER = /<!-- mcp-tool-count -->([^<]*)<!-- \/mcp-tool-count -->/g;
/** Ways a total was typed by hand before ("46 MCP tools", "51 tools in total", "All 24 + 22 extras"); not section numbers ("§7 MCP tools"). */
const HAND_TYPED = /(?<!§)\b\d+ MCP tools\b|\b\d+ tools in total\b|\b\d+ \+ \d+ extras\b/g;

function referenceCount() {
  const m = read('docs/public/mcp/tools.md').match(/offers \*\*(\d+) tools\*\*/);
  assert.ok(m, 'docs/public/mcp/tools.md does not state "offers **N tools**"; run `pnpm docs:reference`');
  return Number(m[1]);
}

describe('MCP tool count in the docs', () => {
  const expected = referenceCount();

  it('the generated reference lists as many tools as it states', () => {
    const headings = read('docs/public/mcp/tools.md').match(/^### `[a-z_]+`$/gm) ?? [];
    assert.equal(headings.length, expected);
  });

  for (const file of FILES) {
    it(`${file}: every tool-count marker matches the generated reference`, () => {
      const values = [...read(file).matchAll(MARKER)].map((m) => m[1]);
      assert.ok(values.length > 0, `${file} has no <!-- mcp-tool-count --> marker`);
      for (const v of values) {
        assert.equal(v, String(expected), `${file} says ${v} MCP tools, the reference says ${expected}; run \`pnpm docs:reference\``);
      }
    });

    it(`${file}: no tool count typed outside a marker`, () => {
      const unmarked = read(file).replace(MARKER, '').match(HAND_TYPED) ?? [];
      assert.deepEqual(unmarked, [], `${file}: put the count between <!-- mcp-tool-count --> markers or link docs/public/mcp/tools.md`);
    });
  }
});
