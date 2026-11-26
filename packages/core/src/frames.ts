import { join } from 'node:path';
import { badRequest } from './errors';

/**
 * get_frames (#379): which frames of a render an agent should look at, and their labels. The images come from
 * framesImage (media-pipeline) on the stored output; this module only plans.
 *
 * - `auto` (default): the first frame, each scene's middle frame, both frames of every cut (the last frame of
 *   scene i and the first of scene i+1) and the last frame.
 * - `at`: chosen times (seconds), frame indices or `{ sceneId, position }`.
 * - `everySeconds`: one frame every N seconds from 0.
 */
export const FRAMES_MAX_TILES = 24;
export const FRAMES_DEFAULT_WIDTH = 360;
export const FRAMES_MIN_WIDTH = 120;
export const FRAMES_MAX_WIDTH = 720;
/** The image (or all images of a `separate` answer) stays under this many bytes. */
export const FRAMES_MAX_BYTES = 1_000_000;
export const FRAMES_MIN_EVERY_SECONDS = 0.25;

/** Where get_frames caches one render's images: removed with the render (project delete, retention cleanup). */
export const framesCacheDir = (cacheDir: string, runId: string) => join(cacheDir, 'frames', runId);

export type FramePosition = 'first' | 'mid' | 'cut-out' | 'cut-in' | 'last' | 'start' | 'end' | 'at' | 'every';

export type FrameAt = number | { seconds: number } | { frame: number } | { sceneId: string; position?: 'start' | 'mid' | 'end' };

export interface FramesRequest {
  at?: FrameAt[];
  everySeconds?: number;
  width?: number;
  layout?: 'sheet' | 'separate';
  overlay?: 'none' | 'safe';
}

export interface SceneSpan {
  sceneId: string;
  first: number;
  last: number;
}

export interface PlannedTile {
  frame: number;
  seconds: number;
  sceneId: string | null;
  position: FramePosition;
  label: string;
}

export interface FramesPlan {
  mode: 'auto' | 'at' | 'every';
  tiles: PlannedTile[];
  /** auto only: candidates left out to stay within FRAMES_MAX_TILES (ask for them with `at`). */
  omitted: PlannedTile[];
}

/** One span per scene from the render manifest's clips (a fanned-out scene has several chunks), in timeline order. */
export function sceneSpans(clips: ReadonlyArray<{ sceneId: string; startFrame: number; frames: number }>): SceneSpan[] {
  const byId = new Map<string, SceneSpan>();
  for (const c of clips) {
    const last = c.startFrame + c.frames - 1;
    const s = byId.get(c.sceneId);
    if (s) {
      s.first = Math.min(s.first, c.startFrame);
      s.last = Math.max(s.last, last);
    } else byId.set(c.sceneId, { sceneId: c.sceneId, first: c.startFrame, last });
  }
  return [...byId.values()].sort((a, b) => a.first - b.first);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The plan for a request, on a render of `frames` frames at `fps`. Throws bad_request for impossible requests. */
export function planFrames(req: FramesRequest, video: { frames: number; fps: number; scenes: SceneSpan[] }): FramesPlan {
  const { frames, fps, scenes } = video;
  if (frames < 1) throw badRequest('the render has no frames');
  const sceneAt = (f: number) => scenes.find((s) => f >= s.first && f <= s.last)?.sceneId ?? null;
  const tile = (frame: number, position: FramePosition, sceneId = sceneAt(frame)): PlannedTile => {
    const seconds = round3(frame / fps);
    return { frame, seconds, sceneId, position, label: `${sceneId ?? '-'} · ${position} · f${frame} · ${seconds.toFixed(2)}s` };
  };
  if (req.at && req.everySeconds !== undefined) throw badRequest('give at or everySeconds, not both');

  if (req.at) {
    if (!req.at.length) throw badRequest('at is empty; omit it for the automatic selection');
    if (req.at.length > FRAMES_MAX_TILES) throw badRequest(`at has ${req.at.length} entries; at most ${FRAMES_MAX_TILES}`);
    const tiles = req.at.map((a) => {
      if (typeof a === 'number' || 'seconds' in a) {
        const s = typeof a === 'number' ? a : a.seconds;
        if (!Number.isFinite(s) || s < 0) throw badRequest(`at: ${s} is not a time in seconds`);
        const f = Math.floor(s * fps + 1e-6);
        if (f >= frames) throw badRequest(`at: ${s} s is past the end (${round3(frames / fps)} s, ${frames} frames)`);
        return tile(f, 'at');
      }
      if ('frame' in a) {
        if (!Number.isInteger(a.frame) || a.frame < 0 || a.frame >= frames) throw badRequest(`at: frame ${a.frame} is not in 0..${frames - 1}`);
        return tile(a.frame, 'at');
      }
      const span = scenes.find((s) => s.sceneId === a.sceneId);
      if (!span) throw badRequest(`at: no scene "${a.sceneId}" in this render; scenes: ${scenes.map((s) => s.sceneId).join(', ')}`);
      const position = a.position ?? 'mid';
      const f = position === 'start' ? span.first : position === 'end' ? span.last : Math.floor((span.first + span.last) / 2);
      return tile(f, position === 'mid' ? 'mid' : position, span.sceneId);
    });
    return { mode: 'at', tiles, omitted: [] };
  }

  if (req.everySeconds !== undefined) {
    const every = req.everySeconds;
    if (!Number.isFinite(every) || every < FRAMES_MIN_EVERY_SECONDS) throw badRequest(`everySeconds must be at least ${FRAMES_MIN_EVERY_SECONDS}`);
    const count = Math.floor((frames - 1) / fps / every + 1e-9) + 1;
    if (count > FRAMES_MAX_TILES) {
      throw badRequest(`everySeconds ${every} gives ${count} frames; at most ${FRAMES_MAX_TILES}: use at least ${Math.ceil(((frames - 1) / fps / (FRAMES_MAX_TILES - 1)) * 100) / 100}`);
    }
    const tiles = Array.from({ length: count }, (_, k) => tile(Math.min(frames - 1, Math.floor(k * every * fps + 1e-6)), 'every'));
    return { mode: 'every', tiles, omitted: [] };
  }

  // auto: candidates in priority order (first and last, then every middle, then cut pairs), one per frame.
  const first = tile(0, 'first');
  const last = tile(frames - 1, 'last');
  const mids = scenes.map((s) => tile(Math.floor((s.first + s.last) / 2), 'mid', s.sceneId));
  const cuts = scenes.slice(1).map((s, i) => [tile(scenes[i]!.last, 'cut-out', scenes[i]!.sceneId), tile(s.first, 'cut-in', s.sceneId)] as const);
  const chosen = new Map<number, PlannedTile>();
  const omitted: PlannedTile[] = [];
  const room = (n: number) => chosen.size + n <= FRAMES_MAX_TILES;
  const add = (group: readonly PlannedTile[]) => {
    const fresh = group.filter((t) => !chosen.has(t.frame));
    if (!fresh.length) return;
    if (!room(fresh.length)) {
      omitted.push(...fresh);
      return;
    }
    for (const t of fresh) chosen.set(t.frame, t);
  };
  add([first]);
  add([last]);
  for (const m of mids) add([m]);
  for (const pair of cuts) add(pair);
  return { mode: 'auto', tiles: [...chosen.values()].sort((a, b) => a.frame - b.frame), omitted: omitted.sort((a, b) => a.frame - b.frame) };
}
