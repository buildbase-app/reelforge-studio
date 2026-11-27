import { SEEK_GRID, SEEK_MAX_DIFF, type FlashWindow, type LoopSeam, type MotionStretch, type VideoInterval } from '@renderweld/media-pipeline';
import { TEXT_SAMPLES_PER_SECOND, type ClipTextCheck, type TextOverflowRule } from '@renderweld/project-schema';

/**
 * Picture checks on a finished render (#294, render.qa.*): pictures that freeze, pictures that are black, flashes,
 * motion energy and pictures that barely move, and the loop seam of a looping video,
 * measured on every frame after the encode; and the seek check, a few frames rendered again on their own. Results go to the render manifest (`videoQa`, `checks.freeze`,
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
  /** Frames of each render rendered again on their own and compared (scenes whose engine renders frame ranges); 0: off. */
  seekFrames: number;
  /** Report text that runs out of the frame or its box for this long (seconds, sampled while DOM engines render); 0: off. */
  textSeconds: number;
}

export const VIDEO_QA_DEFAULTS: VideoQaSettings = { video: 'warn', freezeSeconds: 3, blackSeconds: 0.5, lowMotionSeconds: 3, motionFloor: 0.4, seekFrames: 2, textSeconds: 1 };

/** Whether scenes are rendered with text samples (EngineRenderContext.textCheck) under these settings. */
export function textCheckOn(qa: VideoQaSettings | undefined): boolean {
  const q = qa ?? VIDEO_QA_DEFAULTS;
  return q.video !== 'off' && (q.textSeconds ?? VIDEO_QA_DEFAULTS.textSeconds) > 0;
}

/** Text that broke a rule for `render.qa.textSeconds` or longer, placed on the video's timeline. */
export interface TextQaRun {
  sceneId: string;
  rule: TextOverflowRule;
  text: string;
  /** The element's box in frame pixels when it was first found. */
  box: { x: number; y: number; width: number; height: number };
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
}

/** The text check in the render manifest (`videoQa.text`). */
export interface TextQaManifest {
  minSeconds: number;
  samplesPerSecond: number;
  /** Scenes whose engine sampled their text, and scenes it could not check (engines that draw text without a DOM page). */
  sampledScenes: string[];
  notSampledScenes: string[];
  /** Runs at least `minSeconds` long (reported as `video.text`). */
  runs: TextQaRun[];
  /** Shorter runs, not reported: text sliding across an edge on its way in or out. */
  shortRuns: number;
}

/** Joins the clips' text samples into the video's timeline and keeps the runs at least `minSeconds` long. */
export function textQa(clips: ReadonlyArray<{ sceneId: string; startFrame: number; text?: ClipTextCheck }>, fps: number, minSeconds: number): TextQaManifest {
  const offset = clips.length ? Math.min(...clips.map((c) => c.startFrame)) : 0;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const runs: TextQaRun[] = [];
  let shortRuns = 0;
  for (const c of clips) {
    for (const run of c.text?.runs ?? []) {
      const start = (c.startFrame - offset + run.startFrame) / fps;
      const end = (c.startFrame - offset + run.endFrame) / fps;
      if (end - start < minSeconds - 1e-6) {
        shortRuns++;
        continue;
      }
      runs.push({ sceneId: c.sceneId, rule: run.rule, text: run.text, box: run.box, startSeconds: r3(start), endSeconds: r3(end), durationSeconds: r3(end - start) });
    }
  }
  const sampled = [...new Set(clips.filter((c) => c.text).map((c) => c.sceneId))];
  const notSampled = [...new Set(clips.filter((c) => !c.text).map((c) => c.sceneId))].filter((id) => !sampled.includes(id));
  return { minSeconds, samplesPerSecond: TEXT_SAMPLES_PER_SECOND, sampledScenes: sampled, notSampledScenes: notSampled, runs: runs.sort((a, b) => a.startSeconds - b.startSeconds), shortRuns };
}

export interface VideoQaIssue {
  rule: 'video.freeze' | 'video.black' | 'video.flash' | 'video.motion' | 'video.loop' | 'video.seek' | 'video.text';
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
  /** The seek check: each frame rendered on its own against the same frame of the video (SEEK_GRID luma grid). */
  seek?: { grid: number; maxDiff: number; frames: SeekResult[] };
  /** The text overflow check: text cut by the frame edge, by a clipping box, or running out of its own box. */
  text?: TextQaManifest;
  issues: VideoQaIssue[];
}

/** A frame the seek check renders on its own: frame `sceneFrame` of a scene, frame `timelineFrame` of the video. */
export interface SeekSample {
  sceneId: string;
  sceneFrame: number;
  timelineFrame: number;
}

/** What the seek check found for one frame; `error` when it could not be rendered or read (the render goes on). */
export interface SeekResult extends SeekSample {
  seconds: number;
  meanDiff?: number;
  maxDiff?: number;
  /** The engine's time for the frame on its own. */
  renderMillis?: number;
  error?: string;
}

/**
 * The frames to check: `count` frames spread evenly over the clips whose engine renders frame ranges, never the first
 * frame of a clip (the engine starts there in the render too, so it proves nothing). A chunk of a split scene counts
 * as a clip of its own.
 */
export function seekSamples(
  clips: ReadonlyArray<{ sceneId: string; engine: string; startFrame: number; frames: number; frameRange?: readonly [number, number] }>,
  canSeek: (engine: string) => boolean,
  count: number
): SeekSample[] {
  const spans = clips.filter((c) => c.frames > 1 && canSeek(c.engine));
  const total = spans.reduce((n, c) => n + c.frames - 1, 0);
  const k = Math.min(Math.max(0, Math.floor(count)), total);
  const out: SeekSample[] = [];
  for (let j = 0; j < k; j++) {
    let at = Math.floor(((j + 0.5) * total) / k);
    for (const c of spans) {
      if (at < c.frames - 1) {
        const offset = at + 1;
        out.push({ sceneId: c.sceneId, sceneFrame: (c.frameRange?.[0] ?? 0) + offset, timelineFrame: c.startFrame + offset });
        break;
      }
      at -= c.frames - 1;
    }
  }
  return out;
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
  measured: { freezes: VideoInterval[]; blacks: VideoInterval[]; flashes?: FlashWindow[]; lows?: MotionStretch[]; loop?: LoopSeam; seeks?: SeekResult[]; texts?: TextQaRun[] },
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
  for (const s of measured.seeks ?? []) {
    if (s.maxDiff === undefined || s.maxDiff <= SEEK_MAX_DIFF) continue;
    issues.push({
      rule: 'video.seek',
      severity,
      message: `frame ${s.sceneFrame} of scene "${s.sceneId}" (${fmt(s.seconds)} into the video) is not the same picture when the engine starts at it as in the full render: up to ${s.maxDiff} luma levels apart on a ${SEEK_GRID}x${SEEK_GRID} grid, where encoding alone stays under ${SEEK_MAX_DIFF}. The scene depends on the frames before it (random numbers without a seed, the clock, or state kept from frame to frame), so a render split into chunks (render.fanOut: scenes+chunks) can jump where the chunks meet. Work everything out from the frame number (in Remotion: useCurrentFrame, and random() with a seed)`,
      startSeconds: s.seconds,
      endSeconds: s.seconds,
      durationSeconds: 0,
      scenes: [s.sceneId],
    });
  }
  for (const t of measured.texts ?? []) {
    const what =
      t.rule === 'text.frame'
        ? 'runs off the edge of the frame, so part of it is cut off'
        : t.rule === 'text.clip'
          ? 'is cut off by a box that hides what overflows it (overflow: hidden)'
          : 'does not fit its box and runs out of it';
    const fix =
      t.rule === 'text.frame'
        ? 'Keep text inside the safe area (the --rf-safe-* variables), make it smaller or let it wrap, or move it wholly off the frame; mark text that is meant to run off with data-layout-allow-overflow'
        : 'Make the box bigger or the text smaller, or let it wrap (data-rf-fit shrinks text to its box)';
    issues.push({
      rule: 'video.text',
      severity,
      message: `the text "${t.text}" ${what} for ${fmt(t.durationSeconds)}, from ${fmt(t.startSeconds)} to ${fmt(t.endSeconds)} (scene "${t.sceneId}", its box at ${t.box.x},${t.box.y}, ${t.box.width}x${t.box.height} px). ${fix}`,
      startSeconds: t.startSeconds,
      endSeconds: t.endSeconds,
      durationSeconds: t.durationSeconds,
      scenes: [t.sceneId],
    });
  }
  return issues.sort((a, b) => a.startSeconds - b.startSeconds);
}
