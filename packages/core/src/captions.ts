import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PipelineError, burnSubtitles, type Tools } from '@reelforge/media-pipeline';
import {
  breakLines,
  captionColor,
  checkCaptions,
  cueTokens,
  formatSrt,
  formatVtt,
  fpsValue,
  resolveCaptions,
  type CaptionCue,
  type CaptionMode,
  type CaptionQa,
  type ResolvedCaptions,
  type OutputSettings,
  type Project,
  type ThemeTokens,
} from '@reelforge/project-schema';

/**
 * Captions in a render (issue #300, D-107, docs/CAPTIONS.md): the style from
 * the theme's caption tokens, an ASS file generated from it, sidecar files and
 * the libass burn-in pass that runs after assembly.
 */

export interface SafeArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Where captions may go without being covered by platform UI. Portrait (9:16
 * social): 12% top, 20% bottom (the caption, buttons and progress bar of
 * TikTok / Reels / Shorts), 8% sides. Landscape and square: 10% "title safe".
 *
 * TODO(#287): a local helper; switch to the shared safe-area helper of the
 * any-format work when it lands.
 */
export function captionSafeArea(width: number, height: number): SafeArea {
  if (height > width) {
    return { top: Math.round(height * 0.12), bottom: Math.round(height * 0.2), left: Math.round(width * 0.08), right: Math.round(width * 0.08) };
  }
  return { top: Math.round(height * 0.1), bottom: Math.round(height * 0.1), left: Math.round(width * 0.1), right: Math.round(width * 0.1) };
}

/** The caption style a render uses: theme tokens, then the project's `captions.style`, resolved to pixels. */
export interface CaptionRenderStyle {
  fontName: string;
  /** Font size in pixels (fontScale x min(width, height), reduced if a full line would not fit the safe width). */
  fontPx: number;
  bold: boolean;
  color: string;
  background: string | null;
  backgroundOpacity: number;
  outline: string | null;
  highlightColor: string;
  position: 'top' | 'center' | 'bottom';
  safeArea: SafeArea;
  maxLineChars: number;
}

/** Average advance of a character in em, for the "does a full line fit" estimate (bold sans fonts are about 0.5-0.55). */
const CHAR_EM = 0.55;

/** The first family of a CSS font-family list, unquoted (libass takes one name and asks fontconfig for the closest match). */
export function firstFontFamily(list: string): string {
  const first = (list.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '').trim();
  return first || 'sans-serif';
}

const installedFonts = new Map<string, string | null>();

/**
 * The installed family fontconfig picks for a CSS font-family list (the first
 * installed one, aliases such as Arial -> Liberation Sans included), so libass
 * draws what the list asks for and the manifest records what was used. Null
 * when fc-match is not installed; libass then gets the list's first family.
 */
export function installedFontFamily(list: string): string | null {
  if (installedFonts.has(list)) return installedFonts.get(list)!;
  const pattern = list
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)
    .map((f) => f.replace(/[-\\:]/g, (m) => `\\${m}`))
    .join(',');
  const r = spawnSync('fc-match', ['-f', '%{family[0]}', pattern], { encoding: 'utf8', timeout: 5000 });
  const family = r.status === 0 && r.stdout.trim() && !/[,{}\\]/.test(r.stdout) ? r.stdout.trim() : null;
  installedFonts.set(list, family);
  return family;
}

export function captionRenderStyle(project: Project, theme: ThemeTokens, output: OutputSettings, maxLineChars: number): CaptionRenderStyle {
  const s = { ...theme.captionStyle, ...Object.fromEntries(Object.entries(project.captions.style ?? {}).filter(([, v]) => v !== undefined)) };
  const safeArea = captionSafeArea(output.width, output.height);
  const background = captionColor(s.background);
  const wanted = s.fontScale * Math.min(output.width, output.height);
  const pad = background ? wanted * 0.22 : 0;
  const safeWidth = output.width - safeArea.left - safeArea.right - 2 * pad;
  const fontPx = Math.max(8, Math.round(Math.min(wanted, safeWidth / (maxLineChars * CHAR_EM))));
  return {
    fontName: firstFontFamily(s.fontFamily ?? theme.fontFamily),
    fontPx,
    bold: (s.weight ?? 700) >= 600,
    color: s.color,
    background,
    backgroundOpacity: s.backgroundOpacity ?? 0.8,
    outline: s.outline === undefined ? '#000000' : captionColor(s.outline),
    highlightColor: s.highlightColor ?? theme.colors.accent,
    position: s.position,
    safeArea,
    maxLineChars,
  };
}

/** "#rrggbb" + opacity -> ASS "&HAABBGGRR" (AA = transparency). */
export function assColor(hex: string, opacity = 1): string {
  const h = hex.replace('#', '');
  const a = Math.round((1 - opacity) * 255);
  const to = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  return `&H${to(a)}${h.slice(4, 6).toUpperCase()}${h.slice(2, 4).toUpperCase()}${h.slice(0, 2).toUpperCase()}`;
}

/** Seconds -> ASS "h:mm:ss.cc". */
export function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Text for an ASS event: braces would start override blocks and a backslash an escape, so neither reaches libass as such. */
function assText(s: string): string {
  return s.replace(/\\/g, '\\⁠').replace(/\{/g, '(').replace(/\}/g, ')');
}

/**
 * An ASS script for the cues: one style from the theme tokens (PlayRes = the
 * output size, so every number is a pixel), lines broken by our line breaker
 * (WrapStyle 0 only as a safety net). With word timings and
 * `highlight: "word"`, a second layer draws only the word being spoken, in
 * the highlight colour and with the same layout (the other words are fully
 * transparent), so the box under the cue stays one piece.
 */
export function toAss(cues: readonly CaptionCue[], output: Pick<OutputSettings, 'width' | 'height'>, st: CaptionRenderStyle, highlight: 'none' | 'word', language?: string | null): string {
  const box = st.background !== null;
  const pad = Math.round(st.fontPx * 0.22);
  const outlineWidth = box ? pad : st.outline ? Math.max(1, Math.round(st.fontPx * 0.08)) : 0;
  const edge = box ? assColor(st.background!, st.backgroundOpacity) : assColor(st.outline ?? '#000000');
  const alignment = st.position === 'top' ? 8 : st.position === 'center' ? 5 : 2;
  const marginV = st.position === 'top' ? st.safeArea.top : st.position === 'bottom' ? st.safeArea.bottom : 0;
  const styleLine = (name: string, primary: string, borderStyle: number, outline: number) =>
    [name, st.fontName.replace(/,/g, ' '), st.fontPx, primary, primary, edge, edge, st.bold ? -1 : 0, 0, 0, 0, 100, 100, 0, 0, borderStyle, outline, 0, alignment, st.safeArea.left, st.safeArea.right, marginV, 1].join(',');
  const events: string[] = [];
  const event = (layer: number, style: string, start: number, end: number, text: string) => {
    if (assTime(end) === assTime(start)) return;
    events.push(`Dialogue: ${layer},${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`);
  };
  let highlighted = false;
  for (const c of cues) {
    const lines = breakLines(c.text, st.maxLineChars);
    event(0, 'Caption', c.start, c.end, lines.map(assText).join('\\N'));
    const tokens = highlight === 'word' ? cueTokens(c) : null;
    if (!tokens) continue;
    highlighted = true;
    const words = c.words!;
    const only = (active: number) => {
      let k = 0;
      const text = lines
        .map((line) =>
          line
            .split(' ')
            .map((w) => (tokens[k++]!.word === active ? `{\\1a&H00&}${assText(w)}{\\1a&HFF&}` : assText(w)))
            .join(' ')
        )
        .join('\\N');
      return `{\\1a&HFF&}${text}`;
    };
    words.forEach((w, i) => {
      const end = i + 1 < words.length ? words[i + 1]!.start : c.end;
      event(1, 'Word', Math.max(w.start, c.start), Math.min(end, c.end), only(i));
    });
  }
  return [
    '[Script Info]',
    '; Generated by ReelForge Studio (captions, docs/CAPTIONS.md)',
    'ScriptType: v4.00+',
    // BCP 47 tag of the cues (validated: letters, digits and hyphens only). libass ignores the line; editors show it.
    ...(language ? [`Language: ${language}`] : []),
    `PlayResX: ${output.width}`,
    `PlayResY: ${output.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${styleLine('Caption', assColor(st.color), box ? 3 : 1, outlineWidth)}`,
    ...(highlighted ? [`Style: ${styleLine('Word', assColor(st.highlightColor), 1, 0)}`] : []),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

/** A rendered clip's place in the source timeline and in the output (frames). */
export interface ClipSpan {
  startFrame: number;
  frames: number;
}

/**
 * Cues of a preview of a scene subset: each cue (and word) is clipped to the
 * rendered scenes and moved to where they play in the preview.
 */
export function mapCuesToClips(cues: readonly CaptionCue[], clips: readonly ClipSpan[], fps: number): CaptionCue[] {
  const out: CaptionCue[] = [];
  let at = 0;
  for (const clip of clips) {
    const from = clip.startFrame / fps;
    const to = (clip.startFrame + clip.frames) / fps;
    const shift = at / fps - from;
    for (const c of cues) {
      const start = Math.max(c.start, from);
      const end = Math.min(c.end, to);
      if (end <= start) continue;
      const words = c.words?.filter((w) => w.start >= from && w.start < to).map((w) => ({ ...w, start: w.start + shift, end: Math.min(w.end, to) + shift }));
      out.push({ start: start + shift, end: end + shift, text: c.text, ...(words?.length === c.words?.length && words ? { words } : {}) });
    }
    at += clip.frames;
  }
  return out;
}

/** Sidecar file names of one language: captions.srt/.vtt/.ass and descriptions.vtt for the primary one, captions.<tag>.* and descriptions.<tag>.vtt for the others. */
export function captionFileNames(language: string | null, primary: boolean): { srt: string; vtt: string; ass: string; descriptions: string } {
  const tag = primary || !language ? '' : `.${language}`;
  return { srt: `captions${tag}.srt`, vtt: `captions${tag}.vtt`, ass: `captions${tag}.ass`, descriptions: `descriptions${tag}.vtt` };
}

/** File names a render may have for captions (also checked when a file is served): the base names above, with an optional language tag. */
export const CAPTION_FILE_PATTERN = /^(?:captions|descriptions)(?:\.[A-Za-z0-9-]{2,35})?\.(?:srt|vtt|ass)$/;

/**
 * An etag of what the captions show: mode, burn language, highlight, style
 * and every language's resolved cues (built from the voice or scenes
 * included). It changes whenever any of them changes, so update_captions can
 * refuse edits made on a stale read, and an approval holds only for what was
 * approved. The approval itself is not part of it.
 */
export function captionsEtag(project: Project, r: ResolvedCaptions): string {
  const body = JSON.stringify({
    mode: project.captions.mode ?? null,
    burnLanguage: project.captions.burnLanguage ?? null,
    highlight: project.captions.highlight ?? null,
    style: project.captions.style ?? null,
    tracks: r.tracks.map((t) => [t.language, t.cues, t.descriptions]),
  });
  return `"c-${createHash('sha256').update(body).digest('hex').slice(0, 24)}"`;
}

/** One language of a render's captions (render manifest `captions.tracks`). */
export interface CaptionTrackManifest {
  language: string | null;
  primary: boolean;
  burned: boolean;
  source: 'cues' | 'voice' | 'scenes' | 'none';
  /** The cues as rendered (clipped to the output), for get_captions on a render. */
  cues: CaptionCue[];
  descriptions: CaptionCue[];
  files: { srt?: string; vtt?: string; ass?: string; descriptions?: string };
  qa: CaptionQa;
}

/** What a render records about its captions (render manifest `captions`). The top-level cue fields describe the primary language. */
export interface CaptionManifest {
  mode: CaptionMode;
  modeSource: ResolvedCaptions['modeSource'];
  source: 'cues' | 'voice' | 'scenes' | 'none';
  language: string | null;
  cues: number;
  /** Whether captions were burned into the video (in burnLanguage). */
  burned: boolean;
  burnLanguage: string | null;
  files: { srt?: string; vtt?: string; ass?: string; descriptions?: string };
  style: CaptionRenderStyle | null;
  highlight: 'none' | 'word';
  qa: CaptionQa;
  /** Etag of the captions rendered, and whether they were approved with update_captions (approve: true) in that state. */
  etag: string;
  approved: boolean;
  tracks: CaptionTrackManifest[];
  burnArgs?: string[];
}

export interface CaptionPassInput {
  project: Project;
  theme: ThemeTokens;
  output: OutputSettings;
  modeOverride?: CaptionMode;
  /** The server's captions.defaultMode when the job was queued. */
  defaultMode?: CaptionMode;
  /** The rendered clips, when they are a subset of the timeline (a preview). */
  subset?: readonly ClipSpan[];
  /** Output seconds. */
  durationSeconds: number;
  /** The render's directory (sidecars go next to final.mp4). */
  dir: string;
  /** Scratch directory (the ASS for burn-only renders). */
  workDir: string;
  /**
   * Another output format (#302): the encoder to burn with and whether the video keeps alpha.
   * null: the output has no pictures (audio only), so captions cannot be burned. Omitted: H.264.
   */
  encoding?: { video: string[]; alpha: boolean } | null;
  tools: Tools;
  signal: AbortSignal;
  log(line: string): void;
}

/**
 * The caption half of a render, after assembly: write the sidecars of every
 * language (modes sidecar and both) and the description tracks (every mode but
 * off: they are never burned), and burn the burn language's cues into
 * `finalFile` with libass (the assembled file is moved aside and replaced).
 * Returns null when captions are off.
 */
export async function captionPass(i: CaptionPassInput, finalFile: string): Promise<CaptionManifest | null> {
  const r = resolveCaptions(i.project, { ...(i.modeOverride ? { mode: i.modeOverride } : {}), ...(i.defaultMode ? { defaultMode: i.defaultMode } : {}) });
  if (r.mode === 'off') return null;
  const fit = (cs: readonly CaptionCue[]) =>
    (i.subset ? mapCuesToClips(cs, i.subset, fpsValue(i.output.fps)) : [...cs])
      .filter((c) => c.start < i.durationSeconds)
      .map((c) => (c.end > i.durationSeconds ? { ...c, end: i.durationSeconds } : c));
  const sidecar = r.mode === 'sidecar' || r.mode === 'both';
  const tracks: CaptionTrackManifest[] = r.tracks.map((t) => {
    const cues = fit(t.cues);
    return {
      language: t.language,
      primary: t.primary,
      burned: false,
      source: t.source,
      cues,
      descriptions: fit(t.descriptions).map(({ words: _w, ...c }) => ({ ...c, kind: 'description' as const })),
      files: {},
      qa: checkCaptions(cues, { fps: fpsValue(i.output.fps), maxLineChars: r.maxLineChars, endSeconds: i.durationSeconds }),
    };
  });
  const primary = tracks[0]!;
  const etag = captionsEtag(i.project, r);
  const base = {
    mode: r.mode,
    modeSource: r.modeSource,
    source: r.source,
    language: r.language ?? null,
    highlight: r.highlight,
    burnLanguage: r.mode === 'burned' || r.mode === 'both' ? (r.tracks.find((t) => t.burned)?.language ?? null) : null,
    etag,
    approved: i.project.captions.approval?.etag === etag,
  } as const;
  if (!tracks.some((t) => t.cues.length || t.descriptions.length)) {
    i.log(`captions: mode "${r.mode}" but no cues; nothing to render`);
    return { ...base, cues: 0, burned: false, files: {}, style: null, qa: primary.qa, tracks };
  }
  const style = captionRenderStyle(i.project, i.theme, i.output, r.maxLineChars);
  style.fontName = installedFontFamily(i.project.captions.style?.fontFamily ?? i.theme.captionStyle.fontFamily ?? i.theme.fontFamily) ?? style.fontName;
  for (const t of tracks) {
    const names = captionFileNames(t.language, t.primary);
    const lang = t.language ? { language: t.language } : {};
    if (sidecar && t.cues.length) {
      await writeFile(join(i.dir, names.srt), formatSrt(t.cues, r.maxLineChars));
      await writeFile(join(i.dir, names.vtt), formatVtt(t.cues, { maxLineChars: r.maxLineChars, ...lang }));
      await writeFile(join(i.dir, names.ass), toAss(t.cues, i.output, style, r.highlight, t.language));
      Object.assign(t.files, { srt: names.srt, vtt: names.vtt, ass: names.ass });
    }
    // Audio description as text (WebVTT for <track kind="descriptions">): never burned, so written in every mode but off.
    if (t.descriptions.length) {
      await writeFile(join(i.dir, names.descriptions), formatVtt(t.descriptions, { maxLineChars: 500, kind: 'descriptions', ...lang }));
      t.files.descriptions = names.descriptions;
    }
  }
  const manifest: CaptionManifest = { ...base, cues: primary.cues.length, burned: false, files: primary.files, style, qa: primary.qa, tracks };
  const burn = r.mode === 'burned' || r.mode === 'both' ? tracks[r.tracks.findIndex((t) => t.burned)] : undefined;
  if (burn?.cues.length) {
    const names = captionFileNames(burn.language, burn.primary);
    let assFile = join(i.dir, names.ass);
    await mkdir(i.workDir, { recursive: true });
    if (!burn.files.ass) {
      assFile = join(i.workDir, names.ass);
      await writeFile(assFile, toAss(burn.cues, i.output, style, r.highlight, burn.language));
    }
    i.log(
      `captions: burning ${burn.cues.length} cue(s)${burn.language ? ` in ${burn.language}` : ''} (${burn.source}, ${style.fontName} ${style.fontPx}px, ${style.position}${r.highlight === 'word' && burn.cues.some((c) => c.words?.length) ? ', word highlight' : ''})`
    );
    if (i.encoding === null) throw new PipelineError('captions:burn', 'captions cannot be burned into an audio-only output; use captions mode "sidecar"');
    const assembled = join(i.workDir, `assembled${extname(finalFile)}`);
    await rename(finalFile, assembled);
    const { args } = await burnSubtitles({ ffmpeg: i.tools.ffmpeg, input: assembled, assFile, out: finalFile, signal: i.signal, ...(i.encoding ? { video: i.encoding.video, alpha: i.encoding.alpha } : {}) });
    await rm(assembled, { force: true });
    burn.burned = true;
    manifest.burned = true;
    manifest.burnArgs = args;
  }
  const issues = tracks.reduce((n, t) => n + t.qa.issues.length, 0);
  if (issues) i.log(`captions: ${issues} quality warning(s); see the render manifest (captions.qa, captions.tracks)`);
  return manifest;
}
