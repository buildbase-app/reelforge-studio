import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Skills for agents: rules for the steps of making a video, in the Agent Skills format (a Markdown file with
 * `name` and `description` front matter). The built-in ones are in this folder; an operator adds more with the
 * `skills.dir` setting (their house rules, or a skills pack), and one with a built-in's name replaces it.
 * Served by the get_skill tool, GET /v1/skills and the renderweld://skills resources, generated into the public
 * docs, and exported as SKILL.md folders by `renderweld skills export`.
 *
 * They cover craft and standards, not content: timing in frames, motion curves, camera grammar, physical
 * plausibility of moving things and people, loudness, voice, captions, sync, brand and review, each rule with its
 * number and its source (founder decision 2026-11-25: public, so an agent with no video knowledge is guided). What a
 * video says, its structure and its music stay with the user (D-128). The tests tie every number the studio also
 * enforces to the constant it enforces it with.
 */
export interface Skill {
  name: string;
  title: string;
  description: string;
  /** The Markdown after the front matter. */
  body: string;
  /** `built-in`, or `custom` for one read from `skills.dir`. */
  source: 'built-in' | 'custom';
}

const DIR = dirname(fileURLToPath(import.meta.url));

/** The built-ins in the order agents meet them: brief first, review last. */
export const SKILL_ORDER = [
  'video-brief',
  'script-timing',
  'layout-and-type',
  'motion-design',
  'camera-language',
  'physical-plausibility',
  'sound-and-mix',
  'voice-over',
  'captions-and-accessibility',
  'av-sync',
  'brand-consistency',
  'review-and-qa',
] as const;

/** Agent Skills naming: lowercase letters, digits and single hyphens, at most 64 characters. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 1024;
export const MAX_SKILL_BYTES = 256 * 1024;
export const MAX_CUSTOM_SKILLS = 200;

export class SkillError extends Error {}

/**
 * Front matter fields as strings. Handles what SKILL.md files use: `key: value`, quoted values, and `>` / `|`
 * block scalars for a long description. Nested maps (e.g. `metadata:`) are skipped.
 */
function frontMatterFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    const key = kv[1]!;
    let value = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === '')) parts.push(lines[++i]!.trim());
      value = value.startsWith('>') ? parts.filter(Boolean).join(' ') : parts.join('\n').trim();
    } else if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (/^'.*'$/.test(value)) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    fields[key] = value;
  }
  return fields;
}

const titleFrom = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ');

export function parseSkill(text: string, file: string, source: Skill['source'] = 'built-in'): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!m) throw new SkillError(`${file}: no front matter (--- name, description ---)`);
  const fields = frontMatterFields(m[1]!.replace(/\r\n/g, '\n'));
  const name = fields.name ?? '';
  const description = fields.description ?? '';
  if (!name) throw new SkillError(`${file}: front matter has no name`);
  if (!SKILL_NAME.test(name) || name.length > MAX_SKILL_NAME) throw new SkillError(`${file}: name "${name}" must be lowercase letters, digits and single hyphens, at most ${MAX_SKILL_NAME} characters`);
  if (!description) throw new SkillError(`${file}: front matter has no description`);
  if (description.length > MAX_SKILL_DESCRIPTION) throw new SkillError(`${file}: description is ${description.length} characters; at most ${MAX_SKILL_DESCRIPTION}`);
  const body = m[2]!.replace(/\r\n/g, '\n').trimStart();
  if (!body.trim()) throw new SkillError(`${file}: no text after the front matter`);
  return { name, title: fields.title || titleFrom(name), description, body, source };
}

function readSkillFile(path: string, label: string, source: Skill['source']): Skill {
  const size = statSync(path).size;
  if (size > MAX_SKILL_BYTES) throw new SkillError(`${label}: ${size} bytes; a skill may be at most ${MAX_SKILL_BYTES}`);
  return parseSkill(readFileSync(path, 'utf8'), label, source);
}

function loadBuiltIns(): Skill[] {
  const byName = new Map<string, Skill>();
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.md'))) {
    const s = readSkillFile(join(DIR, f), f, 'built-in');
    if (`${s.name}.md` !== f) throw new SkillError(`${f}: name "${s.name}" does not match the file name`);
    byName.set(s.name, s);
  }
  const order = SKILL_ORDER as readonly string[];
  const missing = order.filter((n) => !byName.has(n));
  const extra = [...byName.keys()].filter((n) => !order.includes(n));
  if (missing.length || extra.length) throw new SkillError(`skills: SKILL_ORDER and the files differ (missing ${missing.join(', ') || 'none'}; not listed ${extra.join(', ') || 'none'})`);
  return order.map((n) => byName.get(n)!);
}

export const BUILT_IN_SKILLS: readonly Skill[] = Object.freeze(loadBuiltIns());

/**
 * The skills in a `skills.dir` folder: `<name>.md` files and `<name>/SKILL.md` folders (the layout agent tools
 * use), each named after its front matter `name`. Anything else in the folder is ignored. Throws SkillError
 * naming the file when one cannot be used, so a broken pack stops the start instead of vanishing.
 */
export function readSkillsDir(dir: string): Skill[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new SkillError(`skills.dir ${dir} is not a directory`);
  const found: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    let s: Skill | undefined;
    let expected: string;
    if (entry.isDirectory()) {
      const file = join(path, 'SKILL.md');
      if (!existsSync(file)) continue;
      s = readSkillFile(file, `${entry.name}/SKILL.md`, 'custom');
      expected = entry.name;
    } else if (entry.name.endsWith('.md') && statSync(path).isFile()) {
      s = readSkillFile(path, entry.name, 'custom');
      expected = entry.name.slice(0, -3);
    } else continue;
    if (s.name !== expected) throw new SkillError(`skills.dir ${entry.name}: name "${s.name}" does not match "${expected}"`);
    if (found.some((x) => x.name === s.name)) throw new SkillError(`skills.dir: "${s.name}" is defined twice (${s.name}.md and ${s.name}/SKILL.md)`);
    found.push(s);
    if (found.length > MAX_CUSTOM_SKILLS) throw new SkillError(`skills.dir ${dir}: more than ${MAX_CUSTOM_SKILLS} skills`);
  }
  return found;
}

/** Built-ins (a custom skill with the same name takes its place), then the other custom skills by name. */
export function mergeSkills(builtIns: readonly Skill[], custom: readonly Skill[]): readonly Skill[] {
  const byName = new Map(custom.map((s) => [s.name, s]));
  const merged = builtIns.map((b) => byName.get(b.name) ?? b);
  const rest = custom.filter((s) => !builtIns.some((b) => b.name === s.name));
  return Object.freeze([...merged, ...rest]);
}

const cache = new Map<string, readonly Skill[]>();

/** The skills this server serves: the built-ins plus `skills.dir` (a start-up setting, read once per folder). */
export function skillsFor(dir?: string): readonly Skill[] {
  if (!dir) return BUILT_IN_SKILLS;
  let skills = cache.get(dir);
  if (!skills) {
    skills = mergeSkills(BUILT_IN_SKILLS, readSkillsDir(dir));
    cache.set(dir, skills);
  }
  return skills;
}

export function findSkill(skills: readonly Skill[], name: string): Skill | undefined {
  return skills.find((s) => s.name === name);
}

export const skillNames = (skills: readonly Skill[]) => skills.map((s) => s.name).join(', ');

/** One skill as a self-contained document. */
export function skillMarkdown(s: Skill): string {
  return s.body.endsWith('\n') ? s.body : `${s.body}\n`;
}

/** One line per skill: for the list answers of get_skill and GET /v1/skills. */
export function skillSummary(s: Skill) {
  return { name: s.name, title: s.title, description: s.description, source: s.source };
}

/** The index: one line per skill, for the renderweld://skills resource. */
export function skillsIndex(skills: readonly Skill[], uri: (name: string) => string): string {
  return [
    '# Skills',
    '',
    'Rules for the steps of making a video: published standards and how to apply them with these tools. Read the one for the step you are on (also the get_skill tool).',
    '',
    ...skills.map((s) => `- **${s.title}** (${uri(s.name)}): ${s.description}`),
    '',
  ].join('\n');
}

/** A SKILL.md for agent tools that load skills from folders (Claude Code, Codex and others). */
export function exportSkillFile(s: Skill, prefix: string): string {
  return `---\nname: ${prefix}${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n${skillMarkdown(s)}`;
}
