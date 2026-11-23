import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProject } from '@reelforge/project-schema';
import { describe, expect, it } from 'vitest';
import { CELL_ENGINES, ENGINE_INFO, HYGEN, HYGEN_TMPLS, hygenArgs, projectIdFor } from '../cells';
import { REPO } from '../lib/studio';

/** Run the real hygen CLI with the repository's generators, in an empty directory. */
function hygen(args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'hygen-'));
  const r = spawnSync(join(REPO, 'node_modules/.bin/hygen'), args, { cwd, encoding: 'utf8', env: { ...process.env, HYGEN_TMPLS: join(REPO, HYGEN_TMPLS) } });
  return { cwd, code: r.status, output: r.stdout + r.stderr };
}

function generate(args: string[]) {
  const r = hygen(args);
  expect(r.output, r.output).not.toMatch(/Error/);
  expect(r.code).toBe(0);
  const flag = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
  const file = join(r.cwd, flag('--out') ?? `reels/${flag('--name')}.json`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('Hygen reel generators', () => {
  it.each(CELL_ENGINES)('%s: writes a valid v0.2 manifest equal to the tutorial manifest', (engine) => {
    const id = projectIdFor('hygen', engine);
    const manifest = generate(hygenArgs(engine, id, 'reel.json'));
    const parsed = parseProject(manifest);
    expect(parsed.ok && parsed.warnings).toEqual([]);
    const expected = JSON.parse(readFileSync(join(REPO, ENGINE_INFO[engine].manifest), 'utf8'));
    expect(manifest).toEqual({ ...expected, projectId: id });
  });

  it('fills every field from the flags, with defaults for the rest', () => {
    const m = generate(['reel', 'kinetic-title', '--name', 'launch-01', '--headline', 'Ship "it" today', '--subline', '2026', '--accent', '#ff3366', '--seconds', '6']);
    expect(parseProject(m).ok).toBe(true);
    expect(m).toMatchObject({ projectId: 'launch-01', title: 'Ship "it" today', theme: 'midnight' });
    expect(m.scenes).toEqual([
      { id: 'hook', engine: 'remotion', template: 'kinetic-title', durationSeconds: 6, props: { headline: 'Ship "it" today', subline: '2026', accent: '#ff3366' } },
    ]);
    const e = generate(['reel', 'animated-explainer', '--name', 'steps', '--headline', 'Plan', '--points', 'One|Two', '--points', 'Three', '--theme', 'default', '--out', 'x.json']);
    expect(parseProject(e).ok).toBe(true);
    expect(e.theme).toBe('default');
    expect(e.scenes[0].props).toEqual({ title: 'Plan', points: ['One', 'Two', 'Three'] });
  });

  it.each([
    [['reel', 'html-title', '--headline', 'x'], /--name is required/],
    [['reel', 'html-title', '--name', 'Bad Name', '--headline', 'x'], /--name "Bad Name" is not a valid project id/],
    [['reel', 'kinetic-title', '--name', 'a'], /--headline is required/],
    [['reel', 'kinetic-title', '--name', 'a', '--headline', 'x'.repeat(61)], /--headline is 61 characters, at most 60 allowed/],
    [['reel', 'kinetic-title', '--name', 'a', '--headlin', 'x'], /unknown flag --headlin/],
    [['reel', 'kinetic-title', '--name', 'a', '--headline', 'x', '--seconds', '20'], /scenes last 1.5 to 8 s/],
    [['reel', 'animated-explainer', '--name', 'a', '--headline', 'x', '--points', 'a|b|c|d|e'], /--points has 5 points, at most 4 allowed/],
    [['reel', 'hyperframes-title', '--name', 'a', '--headline', 'x', '--accent', 'red'], /--accent "red" must be a 6-digit hex colour/],
    [['reel', 'multi-engine', '--name', 'a', '--headline', 'x', '--steps-title', 'y', '--points', 'z', '--card', 'c'], /--outro is required/],
  ])('fails clearly and writes nothing: %j', (args, message) => {
    const r = hygen(args);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(message);
    expect(r.output).toMatch(/Usage: hygen reel /);
    expect(existsSync(join(r.cwd, 'reels'))).toBe(false);
  });

  it('has one generator per matrix column', () => {
    for (const e of CELL_ENGINES) expect(existsSync(join(REPO, HYGEN_TMPLS, 'reel', HYGEN[e].action, 'manifest.ejs.t'))).toBe(true);
  });
});
