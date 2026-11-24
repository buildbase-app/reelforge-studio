import { z } from 'zod';
import { migrate } from './migrate';
import {
  projectSchemaFor,
  projectShapeSchema,
  sceneFrames,
  type Project,
  type RenderScene,
  type Scene,
} from './project';
import { BUILTIN_CATALOG, type TemplateCatalog } from './templates';
import { fpsLabel, fpsValue, framesToSeconds } from './common';
import {
  CAPTION_RULES,
  buildCuesFromText,
  buildCuesFromWords,
  checkCaptions,
  type CaptionCue,
  type CaptionMode,
  type CaptionQa,
} from './captions';

export * from './common';
export * from './project';
export * from './templates';
export * from './themes';
export * from './captions';
export * from './migrate';
export * from './layout';
export { projectV01, V01_SCHEMA_VERSION, type ProjectV01, type ProjectV01Input } from './v01';

export interface ValidationIssue {
  /** Dotted path into the manifest, e.g. "scenes.1.props.headline". */
  path: string;
  message: string;
}

export interface ValidationWarning {
  path: string;
  message: string;
}

export type ParseResult =
  | { ok: true; project: Project; warnings: ValidationWarning[]; migratedFrom: string | null }
  | { ok: false; issues: ValidationIssue[] };

export interface ParseOptions {
  /** Engines and templates that exist (defaults to every built-in template). */
  catalog?: TemplateCatalog;
}

/**
 * Validate an untrusted manifest (an agent plan, a file from disk), migrating
 * older versions first. Never throws for bad input: every problem is reported
 * at once so a user or an agent can fix them in one pass (TEST_PLAN §1).
 */
export function parseProject(input: unknown, opts: ParseOptions = {}): ParseResult {
  const migrated = migrate(input);
  if (!migrated.ok) return { ok: false, issues: migrated.issues };
  const result = projectSchemaFor(opts.catalog ?? BUILTIN_CATALOG).safeParse(migrated.manifest);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => ({
        path: i.path.map(String).join('.') || '(root)',
        message: i.message,
      })),
    };
  }
  return {
    ok: true,
    project: result.data,
    warnings: collectWarnings(result.data),
    migratedFrom: migrated.migratedFrom,
  };
}

function collectWarnings(p: Project): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  p.assets.forEach((a, i) => {
    if (!a.license) {
      warnings.push({
        path: `assets.${i}.license`,
        message: `asset "${a.id}" has no license metadata; make sure you have the rights to use it`,
      });
    }
    if (a.uri.startsWith('https://')) {
      warnings.push({
        path: `assets.${i}.uri`,
        message: `asset "${a.id}" is a remote URL; import it with add_asset_from_url before rendering`,
      });
    }
  });
  p.scenes.forEach((s, i) => {
    if (s.durationSeconds !== undefined) {
      const exact = s.durationSeconds * fpsValue(p.output.fps);
      if (Math.abs(exact - Math.round(exact)) > 1e-6) {
        warnings.push({
          path: `scenes.${i}.durationSeconds`,
          message: `${s.durationSeconds}s is ${exact.toFixed(3)} frames at ${fpsLabel(p.output.fps)} fps; rounded to ${Math.round(exact)}`,
        });
      }
    }
  });
  warnings.push(...captionWarnings(p));
  if (p.audio.music?.ducking) {
    warnings.push({ path: 'audio.music.ducking', message: 'ducking is not applied by this server version yet' });
  }
  if (p.audio.voice && !p.audio.voice.asset) {
    warnings.push({
      path: 'audio.voice.asset',
      message: 'the voice track has no audio asset yet; run generate_voice (or set an asset) before rendering',
    });
  }
  if (p.brief?.targetSeconds) {
    const seconds = framesToSeconds(totalFrames(p), p.output.fps);
    if (Math.abs(seconds - p.brief.targetSeconds) > Math.max(1, p.brief.targetSeconds * 0.1)) {
      warnings.push({
        path: 'brief.targetSeconds',
        message: `the scenes add up to ${seconds.toFixed(1)}s but the brief targets ${p.brief.targetSeconds}s`,
      });
    }
  }
  return warnings;
}

function captionWarnings(p: Project): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const c = resolveCaptions(p);
  if (p.captions.enabled && !p.captions.mode) {
    warnings.push({ path: 'captions.enabled', message: 'captions.enabled does nothing; set captions.mode to "burned", "sidecar" or "both" to render captions' });
  }
  if (c.mode === 'off') {
    if (c.cues.length) {
      warnings.push({ path: 'captions.mode', message: `${c.cues.length} caption cue(s) (from ${c.source}) are not rendered while captions.mode is "off"; set it to "burned", "sidecar" or "both" (or pass captions to render_project)` });
    }
    // Quality rules matter once captions are shown; for manual cues they are useful while editing too.
    if (c.source !== 'cues') return warnings;
  } else if (!c.cues.length) {
    warnings.push({ path: 'captions.mode', message: `captions.mode is "${c.mode}" but there are no cues: add captions.cues (or import_captions), generate the voice with word timestamps, or give scenes captions.text` });
  }
  const base = c.source === 'cues' ? 'captions.cues' : 'captions';
  for (const issue of c.qa.issues) {
    warnings.push({
      path: c.source === 'cues' ? `${base}.${issue.cue}` : base,
      message: `caption ${issue.cue + 1}${c.source === 'cues' ? '' : ` (built from ${c.source})`} [${issue.rule}]: ${issue.message}`,
    });
  }
  return warnings;
}

export interface ResolvedCaptions {
  mode: CaptionMode;
  /** Where the cues came from: the manifest's cues, the voice's word timestamps, scene caption text, or none. */
  source: 'cues' | 'voice' | 'scenes' | 'none';
  cues: CaptionCue[];
  language?: string;
  maxLineChars: number;
  maxCharsPerCue: number;
  highlight: 'none' | 'word';
  qa: CaptionQa;
}

/**
 * The captions a render shows, in video seconds: the manifest's cues when
 * there are any, else cues built from the voice's word timestamps (shifted by
 * the voice start), else from scene `captions.text` over each scene. `mode`
 * overrides `captions.mode` (render_project's `captions` option).
 */
export function resolveCaptions(p: Project, opts: { mode?: CaptionMode } = {}): ResolvedCaptions {
  const fps = fpsValue(p.output.fps);
  const endSeconds = framesToSeconds(totalFrames(p), p.output.fps);
  const portrait = p.output.height > p.output.width;
  const maxLineChars = p.captions.maxLineChars ?? (portrait ? 32 : CAPTION_RULES.maxLineChars);
  const maxCharsPerCue = p.captions.maxCharsPerCue ?? maxLineChars * CAPTION_RULES.maxLines;
  let source: ResolvedCaptions['source'] = 'none';
  let cues: CaptionCue[] = [];
  const voice = p.audio.voice;
  if (p.captions.cues?.length) {
    source = 'cues';
    cues = p.captions.cues;
  } else if (voice?.words?.length) {
    source = 'voice';
    cues = buildCuesFromWords(voice.words, { offsetSeconds: voice.startFrame / fps, maxCharsPerCue, fps, endSeconds });
  } else {
    for (const s of timeline(p)) {
      if (!s.captions?.text || s.captions.source !== 'text') continue;
      source = 'scenes';
      cues.push(...buildCuesFromText(s.captions.text, s.startFrame / fps, s.endFrame / fps, { maxCharsPerCue, fps, endSeconds }));
    }
  }
  const language = p.captions.language ?? p.brief?.language;
  return {
    mode: opts.mode ?? p.captions.mode ?? 'off',
    source,
    cues,
    ...(language ? { language } : {}),
    maxLineChars,
    maxCharsPerCue,
    highlight: p.captions.highlight ?? 'word',
    qa: checkCaptions(cues, { fps, maxLineChars, endSeconds }),
  };
}

export interface TimelineScene extends Scene {
  durationFrames: number;
  startFrame: number;
  endFrame: number;
}

/** Scenes with their duration in frames and computed start/end frames (end exclusive). */
export function timeline(p: Project): TimelineScene[] {
  let cursor = 0;
  return p.scenes.map((s) => {
    const frames = sceneFrames(s, p.output.fps);
    const start = cursor;
    cursor += frames;
    return { ...s, durationFrames: frames, startFrame: start, endFrame: cursor };
  });
}

export function totalFrames(p: Project): number {
  return p.scenes.reduce((n, s) => n + sceneFrames(s, p.output.fps), 0);
}

/** The engine-facing view of a scene. */
export function toRenderScene(s: TimelineScene): RenderScene {
  return {
    id: s.id,
    engine: s.engine,
    template: s.template,
    html: s.html,
    css: s.css,
    durationFrames: s.durationFrames,
    props: s.props,
    assets: s.assets,
  };
}

/**
 * JSON Schema for the manifest, for external agents (Claude Code, Codex) that
 * write plans. It describes the shape only; cross-field rules such as template
 * props and timing are enforced by `parseProject` (and the validate endpoint).
 */
export function projectJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(projectShapeSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}
