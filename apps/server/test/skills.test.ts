import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@renderweld/core';
import { TOOLS, WORKFLOW_GUIDE, startServer, type StartedServer } from '../src/index';
import { runCli } from '../src/cli';
import { BUILT_IN_SKILLS, MAX_SKILL_BYTES, SKILL_ORDER, SkillError, mergeSkills, parseSkill, readSkillsDir, skillsFor } from '../src/skills/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/** Skills for agents (#313): the built-ins, skills.dir, and the same set over REST, MCP and the CLI. */
const { dir, cleanup } = tempDir('renderweld-skills-');
const PROMPTS = ['brief_intake', 'make_reel', 'plan_reel', 'review_reel'];

const skillFile = (name: string, body = `# ${name}\n\n1. A rule.\n`, extra = '') => `---\nname: ${name}\ndescription: Use for ${name}.\n${extra}---\n${body}`;

/** A skills.dir with one replacement of a built-in, one new skill as a file and one as a folder, and noise. */
function packDir(): string {
  const p = join(dir, 'pack');
  mkdirSync(join(p, 'motion-house'), { recursive: true });
  mkdirSync(join(p, 'empty-folder'), { recursive: true });
  writeFileSync(join(p, 'av-sync.md'), skillFile('av-sync', '# Our sync rules\n\n1. Picture first.\n'));
  writeFileSync(join(p, 'house-style.md'), skillFile('house-style', '# House style\n\n1. Logo bottom right.\n', 'title: House style\n'));
  writeFileSync(join(p, 'motion-house', 'SKILL.md'), skillFile('motion-house'));
  writeFileSync(join(p, 'README.txt'), 'not a skill');
  writeFileSync(join(p, '.hidden.md'), 'not read');
  return p;
}

describe('built-in skills', () => {
  it('SKL-01 load in SKILL_ORDER, each with rules, how to apply them here, a checklist and sources', () => {
    expect(BUILT_IN_SKILLS.map((s) => s.name)).toEqual([...SKILL_ORDER]);
    for (const s of BUILT_IN_SKILLS) {
      expect(s.source).toBe('built-in');
      expect(s.description.length).toBeGreaterThan(40);
      expect(s.description.length).toBeLessThanOrEqual(1024);
      expect(s.body.startsWith(`# ${s.title}\n`)).toBe(true);
      for (const h of ['## Rules', '## In RenderWeld', '## Sources']) expect(s.body, `${s.name}: ${h}`).toContain(`\n${h}\n`);
      expect(s.body, `${s.name}: a checklist`).toMatch(/\n- \[ \] /);
    }
  });

  it('SKL-02 name only tools and prompts that exist, and only other built-in skills', () => {
    const tools = new Set([...TOOLS.map((t) => t.name), ...PROMPTS]);
    const skills = new Set<string>(SKILL_ORDER);
    for (const s of BUILT_IN_SKILLS) {
      for (const [, name] of s.body.matchAll(/`([a-z]+(?:_[a-z]+)+)(?=[`\s])/g)) expect(tools.has(name!), `${s.name} names "${name}", which is not a tool or prompt`).toBe(true);
      for (const [, name] of s.body.matchAll(/see `([a-z]+(?:-[a-z]+)+)`/g)) expect(skills.has(name!), `${s.name} points to skill "${name}"`).toBe(true);
    }
  });
});

describe('parseSkill', () => {
  it('SKL-03 reads Agent Skills front matter: quotes, block scalars, CRLF, a BOM, extra keys; title from the name', () => {
    const s = parseSkill('﻿---\r\nname: house-style\r\ndescription: >\r\n  Our rules,\r\n  in two lines.\r\nlicense: Proprietary\r\nmetadata:\r\n  version: "2"\r\n---\r\n# House\r\n\r\n1. One.\r\n', 'x.md', 'custom');
    expect(s).toMatchObject({ name: 'house-style', title: 'House style', description: 'Our rules, in two lines.', source: 'custom', body: '# House\n\n1. One.\n' });
    expect(parseSkill('---\nname: "a-b"\ndescription: \'it\'\'s quoted\'\ntitle: "A: B"\n---\nBody\n', 'y.md')).toMatchObject({ name: 'a-b', description: "it's quoted", title: 'A: B' });
  });

  it('SKL-04 refuses a file it cannot serve, naming it', () => {
    expect(() => parseSkill('# no front matter', 'a.md')).toThrow('a.md: no front matter');
    expect(() => parseSkill('---\ndescription: d\n---\nx', 'b.md')).toThrow('b.md: front matter has no name');
    expect(() => parseSkill('---\nname: Bad_Name\ndescription: d\n---\nx', 'c.md')).toThrow(/c\.md: name "Bad_Name" must be lowercase/);
    expect(() => parseSkill(`---\nname: ${'a'.repeat(65)}\ndescription: d\n---\nx`, 'd.md')).toThrow(/at most 64/);
    expect(() => parseSkill('---\nname: e\n---\nx', 'e.md')).toThrow('e.md: front matter has no description');
    expect(() => parseSkill(`---\nname: f\ndescription: ${'d'.repeat(1025)}\n---\nx`, 'f.md')).toThrow('f.md: description is 1025 characters');
    expect(() => parseSkill('---\nname: g\ndescription: d\n---\n  \n', 'g.md')).toThrow('g.md: no text after the front matter');
  });
});

describe('skills.dir', () => {
  it('SKL-05 reads <name>.md and <name>/SKILL.md, skips other files; a custom skill replaces a built-in in place', () => {
    const p = packDir();
    expect(readSkillsDir(p).map((s) => s.name)).toEqual(['av-sync', 'house-style', 'motion-house']);
    const all = skillsFor(p);
    expect(all.map((s) => s.name)).toEqual([...SKILL_ORDER, 'house-style', 'motion-house']);
    expect(all.find((s) => s.name === 'av-sync')).toMatchObject({ source: 'custom', title: 'Av sync' });
    expect(all.find((s) => s.name === 'video-brief')?.source).toBe('built-in');
    expect(skillsFor(p)).toBe(all); // read once per folder
    expect(mergeSkills(BUILT_IN_SKILLS, [])).toEqual(BUILT_IN_SKILLS);
  });

  it('SKL-06 a broken folder fails with the file named: name mismatch, defined twice, too large, not a folder', () => {
    const p = (n: string) => {
      const d = join(dir, n);
      mkdirSync(d, { recursive: true });
      return d;
    };
    const a = p('mismatch');
    writeFileSync(join(a, 'one.md'), skillFile('two'));
    expect(() => readSkillsDir(a)).toThrow('skills.dir one.md: name "two" does not match "one"');
    const b = p('twice');
    mkdirSync(join(b, 'dup'));
    writeFileSync(join(b, 'dup.md'), skillFile('dup'));
    writeFileSync(join(b, 'dup', 'SKILL.md'), skillFile('dup'));
    expect(() => readSkillsDir(b)).toThrow('"dup" is defined twice');
    const c = p('large');
    writeFileSync(join(c, 'big.md'), skillFile('big', `# Big\n\n${'x'.repeat(MAX_SKILL_BYTES)}\n`));
    expect(() => readSkillsDir(c)).toThrow(/big\.md: \d+ bytes; a skill may be at most 262144/);
    expect(() => readSkillsDir(join(dir, 'missing'))).toThrow(SkillError);
  });
});

describe('over REST and MCP', () => {
  let plain: StartedServer;
  let custom: StartedServer;
  let readKey: string;
  let customKey: string;
  const drops: Array<() => Promise<void>> = [];

  const start = async (name: string, skillsDir?: string) => {
    const database = await testDatabase(join(dir, name));
    drops.push(database.drop);
    const registry = new PluginRegistry().registerEngine(fakeEngine('remotion'));
    return startServer({ dataDir: join(dir, name, 'data'), port: 0, host: '127.0.0.1', ...(skillsDir ? { skillsDir } : {}) }, { registry, env: { ...database.env, REELFORGE_LICENCE_MODE: 'off' }, quiet: true });
  };
  const connect = async (server: StartedServer, key: string) => {
    const client = new Client({ name: 'skills-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    return client;
  };
  const json = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text);

  beforeAll(async () => {
    plain = await start('plain');
    custom = await start('custom', packDir());
    readKey = (await plain.service.keys.create('reader', ['read'])).key;
    customKey = (await custom.service.keys.create('reader', ['read'])).key;
  });
  afterAll(async () => {
    await plain?.close();
    await custom?.close();
    for (const d of drops) await d();
    cleanup();
  });

  it('SKL-07 GET /v1/skills lists them and GET /v1/skills/:name answers Markdown; a read key is enough, no key is 401', async () => {
    const auth = { Authorization: `Bearer ${readKey}` };
    expect((await fetch(`${plain.url}/v1/skills`)).status).toBe(401);
    const list = await (await fetch(`${plain.url}/v1/skills`, { headers: auth })).json();
    expect(list.skills.map((s: any) => s.name)).toEqual([...SKILL_ORDER]);
    expect(list.skills[0]).toMatchObject({ name: 'video-brief', title: 'Video brief', source: 'built-in', url: '/v1/skills/video-brief' });
    const one = await fetch(`${plain.url}/v1/skills/captions-and-accessibility`, { headers: auth });
    expect(one.status).toBe(200);
    expect(one.headers.get('content-type')).toMatch(/^text\/markdown/);
    expect(await one.text()).toContain('# Captions and accessibility\n');
    const missing = await fetch(`${plain.url}/v1/skills/nope`, { headers: auth });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatchObject({ code: 'not_found', message: expect.stringContaining('skills: video-brief, layout-and-type') });
  });

  it('SKL-08 get_skill and the renderweld://skills resources serve the same set; the guide points to them', async () => {
    const client = await connect(plain, readKey);
    const listed = json(await client.callTool({ name: 'get_skill', arguments: {} }));
    expect(listed.skills.map((s: any) => s.name)).toEqual([...SKILL_ORDER]);
    expect(listed.skills[1]).toMatchObject({ name: 'layout-and-type', uri: 'renderweld://skills/layout-and-type' });
    const one = json(await client.callTool({ name: 'get_skill', arguments: { name: 'sound-and-mix' } }));
    expect(one).toMatchObject({ name: 'sound-and-mix', title: 'Sound and mix', source: 'built-in' });
    expect(one.markdown).toBe(readFileSync(new URL('../src/skills/sound-and-mix.md', import.meta.url), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, ''));
    const unknown = await client.callTool({ name: 'get_skill', arguments: { name: 'nope' } });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.content)).toContain('not_found');

    const index = await client.readResource({ uri: 'renderweld://skills' });
    expect(index.contents[0]!.text).toContain('- **Review and QA** (renderweld://skills/review-and-qa)');
    const res = await client.readResource({ uri: 'renderweld://skills/av-sync' });
    expect(res.contents[0]).toMatchObject({ mimeType: 'text/markdown', text: expect.stringContaining('# Audio and video sync\n') });
    expect((await client.readResource({ uri: 'reelforge://skills/av-sync' })).contents[0]!.text).toBe(res.contents[0]!.text); // the old scheme still reads
    const { resources } = await client.listResources();
    const skillUris = resources.map((r) => r.uri).filter((u) => u.startsWith('renderweld://skills/'));
    expect(skillUris).toEqual(SKILL_ORDER.map((n) => `renderweld://skills/${n}`));
    expect(resources.some((r) => r.uri.startsWith('reelforge://skills/'))).toBe(false); // listed once, under the new scheme
    expect(WORKFLOW_GUIDE).toContain('get_skill');
    await client.close();
  });

  it('SKL-09 with skills.dir, REST, MCP and resources all serve the custom skills and the replacement', async () => {
    const auth = { Authorization: `Bearer ${customKey}` };
    const list = await (await fetch(`${custom.url}/v1/skills`, { headers: auth })).json();
    expect(list.skills.map((s: any) => `${s.name}:${s.source}`)).toEqual([
      ...SKILL_ORDER.map((n) => `${n}:${n === 'av-sync' ? 'custom' : 'built-in'}`),
      'house-style:custom',
      'motion-house:custom',
    ]);
    expect(await (await fetch(`${custom.url}/v1/skills/av-sync`, { headers: auth })).text()).toBe('# Our sync rules\n\n1. Picture first.\n');
    const client = await connect(custom, customKey);
    expect(json(await client.callTool({ name: 'get_skill', arguments: { name: 'house-style' } }))).toMatchObject({ title: 'House style', source: 'custom', markdown: '# House style\n\n1. Logo bottom right.\n' });
    expect((await client.readResource({ uri: 'renderweld://skills/motion-house' })).contents[0]!.text).toBe('# motion-house\n\n1. A rule.\n');
    await client.close();
  });

  it('SKL-10 a skills.dir that cannot be used stops the start', async () => {
    const bad = join(dir, 'bad-pack');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'oops.md'), '# no front matter');
    await expect(start('bad', bad)).rejects.toThrow('oops.md: no front matter');
  });
});

describe('renderweld skills export', () => {
  it('SKL-11 writes one <prefix><name>/SKILL.md per skill, keeps a changed file unless --force', async () => {
    const out = join(dir, 'export');
    const env = { ...process.env };
    process.env.REELFORGE_DATA_DIR = join(dir, 'cli-data');
    const logs: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (l: string) => logs.push(String(l));
    console.error = (l: string) => logs.push(String(l));
    try {
      await runCli(['skills', 'export', out]);
      expect(logs.at(-1)).toContain('exported 7 skills');
      const file = join(out, 'renderweld-av-sync', 'SKILL.md');
      const text = readFileSync(file, 'utf8');
      expect(text).toMatch(/^---\nname: renderweld-av-sync\ndescription: "Tolerances for sound/);
      expect(parseSkill(text, 'SKILL.md').name).toBe('renderweld-av-sync');
      await runCli(['skills', 'export', out]);
      expect(logs.at(-1)).toContain('(0 new, 0 updated, 7 unchanged)');
      writeFileSync(file, `${text}local edit\n`);
      process.exitCode = 0;
      await runCli(['skills', 'export', out]);
      expect(process.exitCode).toBe(1);
      expect(logs.at(-1)).toContain('renderweld-av-sync/SKILL.md');
      expect(readFileSync(file, 'utf8')).toContain('local edit');
      process.exitCode = 0;
      await runCli(['skills', 'export', out, '--force']);
      expect(readFileSync(file, 'utf8')).toBe(text);
      await runCli(['skills', 'export', join(dir, 'export2'), '--prefix', 'acme-']);
      expect(readFileSync(join(dir, 'export2', 'acme-video-brief', 'SKILL.md'), 'utf8')).toMatch(/^---\nname: acme-video-brief\n/);
    } finally {
      console.log = log;
      console.error = err;
      process.exitCode = 0;
      process.env = env;
    }
  });
});
