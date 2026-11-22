/**
 * Checks the relative links (and #anchors) in Markdown files: every target
 * file must exist and every anchor must match a heading, GitHub-style.
 *
 *   pnpm tsx scripts/tutorials/links.ts [files or folders...]   # default: docs/tutorials
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { REPO } from './lib/studio';

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

export function anchorsOf(markdown: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

/** Links outside code blocks and inline code: [text](target) and ![alt](target). */
export function linksOf(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const text = line.replace(/`[^`]*`/g, '');
    for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push(m[1]!);
  }
  return out;
}

export function checkFile(file: string): string[] {
  const md = readFileSync(file, 'utf8');
  const problems: string[] = [];
  for (const link of linksOf(md)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue; // http(s), mailto: checked by humans, not offline
    const [path, anchor] = link.split('#') as [string, string | undefined];
    const target = path ? resolve(dirname(file), decodeURI(path)) : file;
    const where = `${relative(REPO, file)}: ${link}`;
    if (!existsSync(target)) {
      problems.push(`${where} (missing ${relative(REPO, target)})`);
      continue;
    }
    if (anchor && target.endsWith('.md') && !anchorsOf(readFileSync(target, 'utf8')).has(anchor)) problems.push(`${where} (no heading #${anchor})`);
  }
  return problems;
}

export function markdownFiles(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) out.push(...markdownFiles(readdirSync(p).map((f) => join(p, f))));
    else if (p.endsWith('.md')) out.push(p);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const files = markdownFiles(args.length ? args.map((a) => resolve(a)) : [join(REPO, 'docs/tutorials')]);
  const problems = files.flatMap(checkFile);
  console.log(`${files.length} files checked`);
  if (problems.length) {
    console.error(`broken links:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
}
