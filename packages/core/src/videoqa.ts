import type { FlashWindow, LoopSeam, MotionStretch, VideoInterval } from '@renderweld/media-pipeline';

/**
 * Picture checks on a finished render (#294, render.qa.*): pictures that freeze, pictures that are black, flashes,
 * motion energy and pictures that barely move, and the loop seam of a looping video,
 * measured on every frame after the encode. Results go to the render manifest (`videoQa`, `checks.freeze`,
 * `checks.black`) and get_render_output, so an agent that cannot watch its video still learns it froze.
 */
export interface VideoQaSettings {
  video: 'off' | 'warn' | 'fail';
  freezeSeconds: number;
  blackSeconds: number;
  /** Report pictures that barely move for this long (seconds); 0: motion is measured but no stretch is reported. */
  lowMotionSeconds: number;
  /** A frame that differs from the picture a second before by less than this (mean 8-bit luma levels on a 32x32 grid) counts as still. */
  motionFloor: number;
}

export const VIDEO_QA_DEFAULTS: VideoQaSettings = { video: 'warn', freezeSeconds: 3, blackSeconds: 0.5, lowMotionSeconds: 3, motionFloor: 0.4 };

export interface VideoQaIssue {
  rule: 'video.freeze' | 'video.black' | 'video.flash' | 'video.motion' | 'video.loop';
  severity: 'warning' | 'error';
  message: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  /** The scenes the stretch overlaps, in timeline order. */
  scenes: string[];
}

export interface VideoQaManifest {
  mode: VideoQaSettings['video'];
  thresholds: { freezeSeconds: number; blackSeconds: number | null };
  freezes: VideoInterval[];
  blacks: VideoInterval[];
  /** More than three general or red flashes in a second over a quarter of the picture (WCAG 2.2 SC 2.3.1). */
  flashes: FlashWindow[];
  /**
   * Motion energy per second, the stretches that barely move (outside the frozen ones) and, for a project with
   * `output.loop`, the seam from the last frame back to the first.
   */
  motion?: { floor: number; lowSeconds: number; energyPerSecond: number[]; lows: MotionStretch[]; loop?: LoopSeam };
  issues: VideoQaIssue[];
}

/**
 * The low-motion stretches that are not already reported as frozen: what is left of each after the freezes are taken
 * out, kept when still at least `lowSeconds` long (a freeze is the stronger finding for the same pictures).
 */
export function lowMotionOutsideFreezes(lows: MotionStretch[], freezes: VideoInterval[], lowSeconds: number): MotionStretch[] {
  const out: MotionStretch[] = [];
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  for (const low of lows) {
    let pieces: Array<[number, number]> = [[low.startSeconds, low.endSeconds]];
    for (const fz of freezes) {
      pieces = pieces.flatMap(([a, b]): Array<[number, number]> => {
        if (fz.endSeconds <= a || fz.startSeconds >= b) return [[a, b]];
        return [
          ...(fz.startSeconds > a ? [[a, fz.startSeconds] as [number, number]] : []),
          ...(fz.endSeconds < b ? [[fz.endSeconds, b] as [number, number]] : []),
        ];
      });
    }
    for (const [a, b] of pieces) if (b - a >= lowSeconds - 1e-6) out.push({ startSeconds: r3(a), endSeconds: r3(b), durationSeconds: r3(b - a), peakMotion: low.peakMotion });
  }
  return out;
}

/** Where each scene sits in the output, in seconds (a preview of some scenes starts at its first clip). */
export function sceneTimes(clips: ReadonlyArray<{ sceneId: string; startFrame: number; frames: number }>, fps: number): Array<{ sceneId: string; start: number; end: number }> {
  if (!clips.length) return [];
  const offset = Math.min(...clips.map((c) => c.startFrame));
  const byId = new Map<string, { sceneId: string; start: number; end: number }>();
  for (const c of clips) {
    const start = (c.startFrame - offset) / fps;
    const end = (c.startFrame - offset + c.frames) / fps;
    const s = byId.get(c.sceneId);
    if (s) {
      s.start = Math.min(s.start, start);
      s.end = Math.max(s.end, end);
    } else byId.set(c.sceneId, { sceneId: c.sceneId, start, end });
  }
  return [...byId.values()].sort((a, b) => a.start - b.start);
}

const fmt = (s: number) => `${s.toFixed(2)} s`;
const sceneWords = (ids: string[]) => (ids.length === 0 ? '' : ids.length === 1 ? ` (scene "${ids[0]}")` : ` (scenes ${ids.map((i) => `"${i}"`).join(', ')})`);

/** The issues for what was measured: one per stretch, naming its scenes and what to change. */
export function videoQaIssues(
  measured: { freezes: VideoInterval[]; blacks: VideoInterval[]; flashes?: FlashWindow[]; lows?: MotionStretch[]; loop?: LoopSeam },
  scenes: ReadonlyArray<{ sceneId: string; start: number; end: number }>,
  severity: VideoQaIssue['severity']
): VideoQaIssue[] {
  // A stretch overlaps a scene when it covers more than a frame or so of it (cuts land on frame edges).
  const overlapping = (iv: VideoInterval) => scenes.filter((s) => Math.min(s.end, iv.endSeconds) - Math.max(s.start, iv.startSeconds) > 0.05).map((s) => s.sceneId);
  const issues: VideoQaIssue[] = [];
  for (const iv of measured.freezes) {
    const ids = overlapping(iv);
    issues.push({
      rule: 'video.freeze',
      severity,
      message: `the picture does not change for ${fmt(iv.durationSeconds)}, from ${fmt(iv.startSeconds)} to ${fmt(iv.endSeconds)}${sceneWords(ids)}: a still that long reads as a frozen video. Add motion, shorten the scene, or raise render.qa.freezeSeconds if the hold is deliberate`,
      ...iv,
      scenes: ids,
    });
  }
  for (const iv of measured.blacks) {
    const ids = overlapping(iv);
    const opening = iv.startSeconds === 0;
    issues.push({
      rule: 'video.black',
      severity,
      message: `${fmt(iv.durationSeconds)} of black or near-black, empty picture from ${fmt(iv.startSeconds)}${sceneWords(ids)}${opening ? ': the first frame is black, so platforms show a black thumbnail and viewers scroll past' : ': nothing on screen that long reads as a gap. Bring the first element in sooner, and check that every layer and asset rendered'}`,
      ...iv,
      scenes: ids,
    });
  }
  for (const w of measured.flashes ?? []) {
    const iv = { startSeconds: w.startSeconds, endSeconds: w.endSeconds, durationSeconds: Math.round((w.endSeconds - w.startSeconds) * 1000) / 1000 };
    const ids = overlapping(iv);
    issues.push({
      rule: 'video.flash',
      severity,
      message: `${w.kind === 'red' ? 'saturated red flashes' : 'flashes'} at up to ${w.transitionsPerSecond / 2} a second over a quarter of the picture or more, from ${fmt(iv.startSeconds)} to ${fmt(iv.endSeconds)}${sceneWords(ids)}: more than three a second can trigger seizures (WCAG 2.2, 2.3.1). Slow them to three a second or fewer, shrink the flashing area below a quarter of the frame, or lower the contrast`,
      ...iv,
      scenes: ids,
    });
  }
  for (const low of measured.lows ?? []) {
    const ids = overlapping(low);
    issues.push({
      rule: 'video.motion',
      severity,
      message: `the picture barely moves for ${fmt(low.durationSeconds)}, from ${fmt(low.startSeconds)} to ${fmt(low.endSeconds)}${sceneWords(ids)}: at most ${low.peakMotion} luma levels of change in any second, which reads as a stuck video even though it is not a perfect still. Add visible motion (a move, a zoom, the next line of text), shorten the scene, or raise render.qa.lowMotionSeconds if the hold is deliberate`,
      startSeconds: low.startSeconds,
      endSeconds: low.endSeconds,
      durationSeconds: low.durationSeconds,
      scenes: ids,
    });
  }
  if (measured.loop?.jump) {
    const last = scenes.at(-1);
    const first = scenes[0];
    const end = last?.end ?? 0;
    issues.push({
      rule: 'video.loop',
      severity,
      message: `the loop does not join: going from the last frame back to the first changes the picture by ${measured.loop.seamMotion} luma levels, against ${measured.loop.typicalMotion} for a normal frame change inside the video, so viewers see a jump each time it repeats. End on the picture you start with (bring every element back to its first position), or drop output.loop if the video is not meant to repeat`,
      startSeconds: end,
      endSeconds: end,
      durationSeconds: 0,
      scenes: [...new Set([last?.sceneId, first?.sceneId].filter((x): x is string => !!x))],
    });
  }
  return issues.sort((a, b) => a.startSeconds - b.startSeconds);
}
