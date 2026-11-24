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
import {
  CAPTION_RULES,
  isLanguageTag,
  sameLanguage,
  splitCueKinds,
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
  /** The server's captions.defaultMode, for the caption warnings of projects without captions.mode. */
  captionsDefaultMode?: CaptionMode;
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
    warnings: collectWarnings(result.data, opts.captionsDefaultMode),
    migratedFrom: migrated.migratedFrom,
  };
}

function collectWarnings(p: Project, captionsDefaultMode?: CaptionMode): ValidationWarning[] {
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
      const exact = s.durationSeconds * p.output.fps;
      if (Math.abs(exact - Math.round(exact)) > 1e-6) {
        warnings.push({
          path: `scenes.${i}.durationSeconds`,
          message: `${s.durationSeconds}s is ${exact.toFixed(3)} frames at ${p.output.fps} fps; rounded to ${Math.round(exact)}`,
        });
      }
    }
  });
  warnings.push(...captionWarnings(p, captionsDefaultMode));
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
    const seconds = totalFrames(p) / p.output.fps;
    if (Math.abs(seconds - p.brief.targetSeconds) > Math.max(1, p.brief.targetSeconds * 0.1)) {
      warnings.push({
        path: 'brief.targetSeconds',
        message: `the scenes add up to ${seconds.toFixed(1)}s but the brief targets ${p.brief.targetSeconds}s`,
      });
    }
  }
  return warnings;
}

function captionWarnings(p: Project, defaultMode?: CaptionMode): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const c = resolveCaptions(p, defaultMode ? { defaultMode } : {});
  if (p.captions.enabled && !p.captions.mode) {
    warnings.push({ path: 'captions.enabled', message: 'captions.enabled does nothing; set captions.mode to "burned", "sidecar" or "both" to render captions' });
  }
  const tracksWithCues = c.tracks.filter((t) => !t.primary && t.cues.length);
  if (c.mode === 'off') {
    if (c.cues.length) {
      warnings.push({ path: 'captions.mode', message: `${c.cues.length} caption cue(s) (from ${c.source}) are not rendered while captions.mode is "off"; set it to "burned", "sidecar" or "both" (or pass captions to render_project)` });
    }
    // Quality rules matter once captions are shown; for manual cues they are useful while editing too.
    if (c.source !== 'cues' && !tracksWithCues.length) return warnings;
  } else if (!c.cues.length && !tracksWithCues.length) {
    warnings.push({ path: 'captions.mode', message: `captions.mode is "${c.mode}" but there are no cues: add captions.cues (or import_captions), generate the voice with word timestamps, transcribe the voice (transcribe_captions), or give scenes captions.text` });
  }
  for (const t of c.tracks) {
    if (!t.primary && !t.cues.length) continue;
    if (t.primary && c.mode === 'off' && c.source !== 'cues') continue;
    const manual = t.source === 'cues';
    const base = t.primary ? 'captions.cues' : `captions.tracks.${t.language}.cues`;
    for (const issue of t.qa.issues) {
      warnings.push({
        path: manual ? `${base}.${t.captionIndex[issue.cue] ?? issue.cue}` : 'captions',
        message: `caption ${issue.cue + 1}${t.primary ? '' : ` (${t.language})`}${manual ? '' : ` (built from ${t.source})`} [${issue.rule}]: ${issue.message}`,
      });
    }
  }
  return warnings;
}

/** The cues of one language, resolved for a render. */
export interface ResolvedCaptionTrack {
  /** BCP 47 tag; null for a primary language that is not set. */
  language: string | null;
  /** The primary language (captions.cues / voice / scenes); the others come from captions.tracks. */
  primary: boolean;
  /** Burned into the video by this render (modes burned and both, the burn language). */
  burned: boolean;
  source: 'cues' | 'voice' | 'scenes' | 'none';
  /** Caption cues (shown and burned). */
  cues: CaptionCue[];
  /** Description cues (WebVTT kind=descriptions sidecar only). */
  descriptions: CaptionCue[];
  /** For manual cues: the index of each caption cue in the manifest's list (descriptions may sit in between). */
  captionIndex: number[];
  qa: CaptionQa;
}

export interface ResolvedCaptions {
  mode: CaptionMode;
  /** Where the mode came from: render_project's captions, the project's captions.mode, the server default (captions.defaultMode) or off by default. */
  modeSource: 'render' | 'project' | 'server' | 'default';
  /** Where the primary language's cues came from: the manifest's cues, the voice's word timestamps, scene caption text, or none. */
  source: 'cues' | 'voice' | 'scenes' | 'none';
  /** Caption cues of the primary language. */
  cues: CaptionCue[];
  /** Description cues of the primary language. */
  descriptions: CaptionCue[];
  language?: string;
  /** The language burned in (null: the primary one, which has no tag). */
  burnLanguage: string | null;
  maxLineChars: number;
  maxCharsPerCue: number;
  highlight: 'none' | 'word';
  /** Quality check of the primary language's caption cues. */
  qa: CaptionQa;
  /** Every language: the primary one first, then captions.tracks in manifest order. */
  tracks: ResolvedCaptionTrack[];
}

/**
 * The captions a render shows, in video seconds. Primary language: the
 * manifest's caption cues when there are any, else cues built from the
 * voice's word timestamps (shifted by the voice start), else from scene
 * `captions.text` over each scene. Other languages: captions.tracks. Mode:
 * `opts.mode` (render_project's `captions`), else `captions.mode`, else
 * `opts.defaultMode` (the server's captions.defaultMode), else off.
 */
export function resolveCaptions(p: Project, opts: { mode?: CaptionMode; defaultMode?: CaptionMode } = {}): ResolvedCaptions {
  const fps = p.output.fps;
  const endSeconds = totalFrames(p) / fps;
  const portrait = p.output.height > p.output.width;
  const maxLineChars = p.captions.maxLineChars ?? (portrait ? 32 : CAPTION_RULES.maxLineChars);
  const maxCharsPerCue = p.captions.maxCharsPerCue ?? maxLineChars * CAPTION_RULES.maxLines;
  const qaOf = (cues: CaptionCue[]) => checkCaptions(cues, { fps, maxLineChars, endSeconds });
  let source: ResolvedCaptions['source'] = 'none';
  let cues: CaptionCue[] = [];
  const own = splitCueKinds(p.captions.cues ?? []);
  let captionIndex: number[] = [];
  const voice = p.audio.voice;
  if (own.captions.length) {
    source = 'cues';
    cues = own.captions;
    captionIndex = own.captionIndex;
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
  const language = p.captions.language ?? (p.brief?.language && isLanguageTag(p.brief.language) ? p.brief.language : undefined);
  const mode = opts.mode ?? p.captions.mode ?? opts.defaultMode ?? 'off';
  const modeSource: ResolvedCaptions['modeSource'] = opts.mode ? 'render' : p.captions.mode ? 'project' : opts.defaultMode && opts.defaultMode !== 'off' ? 'server' : 'default';
  const burnLanguage = p.captions.burnLanguage ?? language ?? null;
  const burning = mode === 'burned' || mode === 'both';
  const qa = qaOf(cues);
  const tracks: ResolvedCaptionTrack[] = [
    { language: language ?? null, primary: true, burned: false, source, cues, descriptions: own.descriptions, captionIndex, qa },
    ...Object.entries(p.captions.tracks ?? {}).map(([lang, t]): ResolvedCaptionTrack => {
      const k = splitCueKinds(t.cues);
      return { language: lang, primary: false, burned: false, source: k.captions.length ? 'cues' : 'none', cues: k.captions, descriptions: k.descriptions, captionIndex: k.captionIndex, qa: qaOf(k.captions) };
    }),
  ];
  if (burning) {
    const burned = (burnLanguage && tracks.find((t) => sameLanguage(t.language, burnLanguage))) || tracks[0]!;
    burned.burned = true;
  }
  return {
    mode,
    modeSource,
    source,
    cues,
    descriptions: own.descriptions,
    ...(language ? { language } : {}),
    burnLanguage,
    maxLineChars,
    maxCharsPerCue,
    highlight: p.captions.highlight ?? 'word',
    qa,
    tracks,
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
