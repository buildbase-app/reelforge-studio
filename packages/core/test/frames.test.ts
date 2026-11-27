import { describe, expect, it } from 'vitest';
import { CONTACT_SHEET_DEFAULTS, FRAMES_MAX_TILES, planContactSheet, planFrames, sceneSpans } from '../src/frames';

/** get_frames selection (#379): which frames an agent looks at. */
const three = sceneSpans([
  { sceneId: 'hook', startFrame: 0, frames: 30 },
  { sceneId: 'middle', startFrame: 30, frames: 20 },
  { sceneId: 'middle', startFrame: 50, frames: 25 }, // a fanned-out scene's second chunk
  { sceneId: 'outro', startFrame: 75, frames: 25 },
]);
const video = { frames: 100, fps: 30, scenes: three };

describe('planFrames', () => {
  it('FRM-01 sceneSpans merges chunks of one scene and keeps timeline order', () => {
    expect(three).toEqual([
      { sceneId: 'hook', first: 0, last: 29 },
      { sceneId: 'middle', first: 30, last: 74 },
      { sceneId: 'outro', first: 75, last: 99 },
    ]);
  });

  it('FRM-02 auto: first frame, every scene middle, both frames of every cut, last frame (1 + 3 + 2 x 2 + 1 = 9)', () => {
    const p = planFrames({}, video);
    expect(p.mode).toBe('auto');
    expect(p.tiles.map((t) => [t.frame, t.sceneId, t.position])).toEqual([
      [0, 'hook', 'first'],
      [14, 'hook', 'mid'],
      [29, 'hook', 'cut-out'],
      [30, 'middle', 'cut-in'],
      [52, 'middle', 'mid'],
      [74, 'middle', 'cut-out'],
      [75, 'outro', 'cut-in'],
      [87, 'outro', 'mid'],
      [99, 'outro', 'last'],
    ]);
    expect(p.tiles[4]).toMatchObject({ seconds: 1.733, label: 'middle · mid · f52 · 1.73s' });
    expect(p.omitted).toEqual([]);
  });

  it('FRM-03 auto keeps at most 24 tiles: first, last and middles first, then whole cut pairs; the rest is listed as omitted', () => {
    const scenes = Array.from({ length: 12 }, (_, i) => ({ sceneId: `s${i}`, first: i * 10, last: i * 10 + 9 }));
    const p = planFrames({}, { frames: 120, fps: 30, scenes });
    expect(p.tiles.length).toBeLessThanOrEqual(FRAMES_MAX_TILES);
    expect(p.tiles.filter((t) => t.position === 'mid')).toHaveLength(12);
    expect(p.tiles[0]!.frame).toBe(0);
    expect(p.tiles.at(-1)!.frame).toBe(119);
    // Pairs stay whole: every cut-out shown has its cut-in.
    const outs = p.tiles.filter((t) => t.position === 'cut-out').map((t) => t.frame + 1);
    expect(p.tiles.filter((t) => t.position === 'cut-in').map((t) => t.frame)).toEqual(outs);
    expect(p.tiles.length + p.omitted.length).toBe(1 + 12 + 11 * 2 + 1);
  });

  it('FRM-04 a one-frame scene is shown once, under its first label', () => {
    const p = planFrames({}, { frames: 3, fps: 30, scenes: [{ sceneId: 'a', first: 0, last: 0 }, { sceneId: 'b', first: 1, last: 2 }] });
    expect(p.tiles.map((t) => `${t.frame}:${t.position}`)).toEqual(['0:first', '1:mid', '2:last']);
  });

  it('FRM-05 at: seconds, frames and scene positions', () => {
    const p = planFrames({ at: [1.5, { seconds: 0 }, { frame: 99 }, { sceneId: 'middle' }, { sceneId: 'outro', position: 'start' }, { sceneId: 'hook', position: 'end' }] }, video);
    expect(p.mode).toBe('at');
    expect(p.tiles.map((t) => [t.frame, t.sceneId, t.position])).toEqual([
      [45, 'middle', 'at'],
      [0, 'hook', 'at'],
      [99, 'outro', 'at'],
      [52, 'middle', 'mid'],
      [75, 'outro', 'start'],
      [29, 'hook', 'end'],
    ]);
  });

  it('FRM-06 everySeconds: one frame per interval from 0, capped at 24 with the interval to use', () => {
    expect(planFrames({ everySeconds: 1 }, video).tiles.map((t) => t.frame)).toEqual([0, 30, 60, 90]);
    expect(() => planFrames({ everySeconds: 1 }, { frames: 1800, fps: 30, scenes: [] })).toThrow('everySeconds 1 gives 60 frames; at most 24: use at least 2.61');
  });

  it('FRM-08 the stored sheet: auto is get_frames\' default; every widens an interval that would give more than 24 frames', () => {
    expect(planContactSheet(CONTACT_SHEET_DEFAULTS, video)).toEqual(planFrames({}, video));
    const every = { ...CONTACT_SHEET_DEFAULTS, select: 'every' as const };
    expect(planContactSheet(every, video)).toMatchObject({ mode: 'every', everySeconds: 2.5, tiles: [{ frame: 0 }, { frame: 75 }] });
    // A minute at 2.5 s is 24 frames and fits; at 1 s it would be 60, so the interval becomes the smallest that fits.
    const minute = { frames: 1800, fps: 30, scenes: [] };
    expect(planContactSheet(every, minute).tiles).toHaveLength(24);
    const wide = planContactSheet({ ...every, everySeconds: 1 }, minute);
    expect(wide.everySeconds).toBe(2.5);
    expect(wide.tiles).toHaveLength(FRAMES_MAX_TILES);
    // An hour still gets a sheet.
    expect(planContactSheet(every, { frames: 108_000, fps: 30, scenes: [] }).tiles).toHaveLength(24);
  });

  it('FRM-07 refuses what cannot be shown', () => {
    expect(() => planFrames({ at: [4] }, video)).toThrow('at: 4 s is past the end (3.333 s, 100 frames)');
    expect(() => planFrames({ at: [{ frame: 100 }] }, video)).toThrow('at: frame 100 is not in 0..99');
    expect(() => planFrames({ at: [{ sceneId: 'nope' }] }, video)).toThrow('no scene "nope" in this render; scenes: hook, middle, outro');
    expect(() => planFrames({ at: Array.from({ length: 25 }, () => 0) }, video)).toThrow('at has 25 entries; at most 24');
    expect(() => planFrames({ at: [] }, video)).toThrow('at is empty');
    expect(() => planFrames({ at: [0], everySeconds: 1 }, video)).toThrow('give at or everySeconds, not both');
    expect(() => planFrames({ everySeconds: 0.1 }, video)).toThrow('everySeconds must be at least 0.25');
  });
});
