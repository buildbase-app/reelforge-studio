#!/usr/bin/env node
// Release guards: fail when a known Milestone 1 problem comes back.
//
// Rules live in guards.config.json next to this file. Each rule names the
// files it looks at (`paths`, regular expressions on repo-relative paths) and,
// optionally, a `pattern` to look for inside them. A rule without `pattern`
// flags the file itself (for files that must not be in the repo at all).
//
// Occurrences that already exist are listed in guards.baseline.json as
// "rule-id path" lines, so the check fails only on new ones. When an issue
// fixes a baseline entry, the check reports it as stale: delete the line.
//
//   node scripts/guards/release-guards.mjs                    check
//   node scripts/guards/release-guards.mjs --update-baseline  rewrite the baseline (maintainers)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function loadRules(config) {
  return config.rules.map((r) => ({
    ...r,
    paths: r.paths.map((p) => new RegExp(p)),
    exclude: (r.exclude || []).map((p) => new RegExp(p)),
    pattern: r.pattern ? new RegExp(r.pattern, r.flags || '') : null,
  }));
}

/** @returns {string[]} "rule-id path" findings, sorted */
export function findViolations(rules, files, read) {
  const out = new Set();
  for (const file of files) {
    for (const rule of rules) {
      if (!rule.paths.some((re) => re.test(file))) continue;
      if (rule.exclude.some((re) => re.test(file))) continue;
      if (!rule.pattern) {
        out.add(`${rule.id} ${file}`);
        continue;
      }
      const text = read(file);
      if (text !== null && rule.pattern.test(text)) out.add(`${rule.id} ${file}`);
    }
  }
  return [...out].sort();
}

/** Split findings into new ones (fail) and baseline entries that no longer occur (stale). */
export function compare(findings, baseline) {
  const base = new Set(baseline);
  const found = new Set(findings);
  return {
    fresh: findings.filter((f) => !base.has(f)),
    stale: baseline.filter((b) => !found.has(b)),
  };
}

function main() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const config = JSON.parse(readFileSync(join(here, 'guards.config.json'), 'utf8'));
  const rules = loadRules(config);
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const read = (f) => {
    const p = join(root, f);
    if (!existsSync(p)) return null;
    const buf = readFileSync(p);
    return buf.includes(0) ? null : buf.toString('utf8');
  };
  const findings = findViolations(rules, files, read);
  const baselinePath = join(here, 'guards.baseline.json');
  if (process.argv.includes('--update-baseline')) {
    writeFileSync(baselinePath, JSON.stringify(findings, null, 2) + '\n');
    console.log(`Baseline rewritten with ${findings.length} entries.`);
    return;
  }
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : [];
  const { fresh, stale } = compare(findings, baseline);
  const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
  for (const s of stale) console.log(`Fixed, remove from scripts/guards/guards.baseline.json: ${s}`);
  if (fresh.length === 0) {
    console.log(`Release guards passed (${findings.length} known, ${stale.length} fixed).`);
    return;
  }
  for (const f of fresh) {
    const [id, ...rest] = f.split(' ');
    console.error(`✘ ${rest.join(' ')}: ${byId[id].message}`);
  }
  console.error(`\n${fresh.length} new problem(s). See "Release rules" in AGENTS.md.`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
