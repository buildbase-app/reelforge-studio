import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENTS, CELL_ENGINES } from '../cells';
import { allPages, caseId, cellPage, statusOf } from '../docs';
import { anchorsOf, checkFile, linksOf, markdownFiles, slug } from '../links';
import { REPO } from '../lib/studio';
import type { Proof } from '../prove';

describe('link checker', () => {
  it('makes GitHub-style anchors', () => {
    expect(slug('3. Ask for the reel')).toBe('3-ask-for-the-reel');
    expect(slug('Claude Code over MCP + Remotion')).toBe('claude-code-over-mcp--remotion');
    expect([...anchorsOf('# A\n## A\n```\n# not a heading\n```\n### B `x`')]).toEqual(['a', 'a-1', 'b-x']);
  });
  it('finds links outside code', () => {
    expect(linksOf('[a](x.md) `[b](y.md)` ![p](i.jpg)\n```\n[c](z.md)\n```')).toEqual(['x.md', 'i.jpg']);
  });
  it('reports missing files and anchors', () => {
    const d = mkdtempSync(join(tmpdir(), 'links-'));
    writeFileSync(join(d, 'b.md'), '# Real heading\n');
    writeFileSync(join(d, 'a.md'), '[ok](b.md#real-heading) [bad](b.md#nope) [gone](c.md) [web](https://example.com) [self](#top)\n# Top\n');
    const problems = checkFile(join(d, 'a.md'));
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toMatch(/no heading #nope/);
    expect(problems.join('\n')).toMatch(/missing .*c\.md/);
  });
  it('every link in docs/tutorials resolves', () => {
    const problems = markdownFiles([join(REPO, 'docs/tutorials')]).flatMap(checkFile);
    expect(problems).toEqual([]);
  });
});

describe('generated pages', () => {
  it('are up to date with cells.ts and the recorded proofs (pnpm tutorials:docs)', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const stale = [...allPages()].filter(([f, body]) => !existsSync(f) || readFileSync(f, 'utf8') !== body).map(([f]) => f);
    expect(stale).toEqual([]);
  });
  it('number the cells TUT-01..25 in matrix order', () => {
    expect(caseId('claude-code', 'remotion')).toBe('TUT-01');
    expect(caseId('local-ai', 'multi-engine')).toBe('TUT-25');
    const ids = AGENTS.flatMap((a) => CELL_ENGINES.map((e) => caseId(a, e)));
    expect(new Set(ids).size).toBe(25);
  });
  it('never call a cell proven without a passed proof', () => {
    const failed = { status: 'failed', date: '2026-11-21T00:00:00Z', problems: ['x'], toolCalls: [], sceneEngines: [] } as unknown as Proof;
    expect(statusOf('codex', 'html', null)).toMatch(/^📝 documented, not proven \(needs an OpenAI API key/);
    expect(statusOf('rest', 'html', failed)).toBe('❌ failed 2026-11-21');
    expect(cellPage('codex', 'html', null)).toContain('**Not proven yet**');
    expect(cellPage('codex', 'html', null)).not.toContain('✅');
  });
});
