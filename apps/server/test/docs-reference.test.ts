import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/index';
import { renderToolsDoc, staleOutputs, TOOL_GROUPS } from '../../../scripts/docs/reference';

/**
 * The public docs' MCP tool list, REST endpoint table and template catalog are
 * generated from the code (scripts/docs/reference.ts). A new tool must be put
 * in a group, and the committed pages must match what the code generates.
 */
describe('generated public docs', () => {
  it('every MCP tool is in exactly one group', () => {
    const grouped = TOOL_GROUPS.flatMap((g) => g.tools).sort();
    expect(grouped).toEqual(TOOLS.map((t) => t.name).sort());
    expect(() => renderToolsDoc()).not.toThrow();
  });

  it('docs/public reference pages are up to date (run `pnpm docs:reference`)', () => {
    expect(staleOutputs()).toEqual([]);
  });
});
