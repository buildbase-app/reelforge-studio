import type { FlashWindow, VideoInterval } from '@renderweld/media-pipeline';

/**
 * Picture checks on a finished render (#294, render.qa.*): pictures that freeze and pictures that are black,
 * measured on every frame after the encode. Results go to the render manifest (`videoQa`, `checks.freeze`,
 * `checks.black`) and get_render_output, so an agent that cannot watch its video still learns it froze.
 */
export interface VideoQaSettings {
  video: 'off' | 'warn' | 'fail';
  freezeSeconds: number;
  blackSeconds: number;
}

export const VIDEO_QA_DEFAULTS: VideoQaSettings = { video: 'warn', freezeSeconds: 3, blackSeconds: 0.5 };

export interface VideoQaIssue {
  rule: 'video.freeze' | 'video.black' | 'video.flash';
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
  issues: VideoQaIssue[];
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
  measured: { freezes: VideoInterval[]; blacks: VideoInterval[]; flashes?: FlashWindow[] },
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
    const what = w.kind === 'red' ? 'saturated red flashes' : 'flashes';
    issues.push({
      rule: 'video.flash',
      severity,
      message: w.extended
        ? `${what} at ${w.transitionsPerSecond / 2} a second, held for ${fmt(iv.durationSeconds)}, over a quarter of the picture or more, from ${fmt(iv.startSeconds)} to ${fmt(iv.endSeconds)}${sceneWords(ids)}: two to three flashes a second sustained for 5 s or more is a failure in EA IRIS (extended failure). Break it into bursts shorter than 5 s, slow it, shrink the flashing area below a quarter of the frame, or lower the contrast`
        : `${what} at up to ${w.transitionsPerSecond / 2} a second over a quarter of the picture or more, from ${fmt(iv.startSeconds)} to ${fmt(iv.endSeconds)}${sceneWords(ids)}: more than three a second can trigger seizures (WCAG 2.2, 2.3.1). Slow them to three a second or fewer, shrink the flashing area below a quarter of the frame, or lower the contrast`,
      ...iv,
      scenes: ids,
    });
  }
  return issues.sort((a, b) => a.startSeconds - b.startSeconds);
}
