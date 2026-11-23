import { z } from 'zod';
import { MAX_PROJECT_SECONDS } from './common';
import { captionStyle } from './themes';

/**
 * Captions (issue #300, docs/CAPTIONS.md): the cue model stored in the
 * manifest, SRT / WebVTT import and export, the line breaker, the cue builder
 * for word timestamps and the quality rules. Everything here is pure; the ASS
 * file and the burn-in pass live in core and the media pipeline.
 */

/** One timed word, in seconds. In `audio.voice.words` the times are relative to the voice start; in cues they are video time. */
export const captionWord = z
  .object({
    text: z.string().min(1).max(100),
    start: z.number().min(0).max(MAX_PROJECT_SECONDS),
    end: z.number().min(0).max(MAX_PROJECT_SECONDS),
  })
  .strict();

/** One caption cue, in seconds of video time. `text` may contain "\n" to force a line break. */
export const captionCue = z
  .object({
    start: z.number().min(0).max(MAX_PROJECT_SECONDS),
    end: z.number().min(0).max(MAX_PROJECT_SECONDS),
    text: z.string().min(1).max(500),
    /** Word timings inside the cue (video time). Enables the word highlight ("karaoke") style. */
    words: z.array(captionWord).max(200).optional(),
  })
  .strict();

export const CAPTION_MODES = ['off', 'burned', 'sidecar', 'both'] as const;
export type CaptionMode = (typeof CAPTION_MODES)[number];
export const captionMode = z.enum(CAPTION_MODES);

/** Netflix-style limits (docs/CAPTIONS.md#quality-rules). */
export const CAPTION_RULES = {
  maxLineChars: 42,
  maxLines: 2,
  maxCharsPerSecond: 20,
  minSeconds: 0.833,
  maxSeconds: 7,
  minGapFrames: 2,
} as const;

export const projectCaptions = z
  .object({
    /** Deprecated (manifest v0.2 before #300): does nothing; use `mode`. Kept so older manifests stay valid. */
    enabled: z.boolean().default(false),
    /** off (default), burned into the video, sidecar files (SRT, WebVTT, ASS) next to final.mp4, or both. render_project can override it per render. */
    mode: captionMode.optional(),
    /** BCP 47 language of the cues (written into the WebVTT header and the render manifest). Default: brief.language. */
    language: z.string().min(2).max(35).optional(),
    /** Caption style on top of the theme's captionStyle tokens. */
    style: captionStyle.partial().optional(),
    /** "word" highlights the word being spoken when the cue has word timings (the default then); "none" never does. */
    highlight: z.enum(['none', 'word']).optional(),
    /** Line length for the automatic line break (≤ 42). Default: 42 for landscape and square output, 32 for portrait. */
    maxLineChars: z.number().int().min(16).max(CAPTION_RULES.maxLineChars).optional(),
    /** Characters per cue when cues are built from word timestamps or scene text. Default: two lines. */
    maxCharsPerCue: z.number().int().min(16).max(CAPTION_RULES.maxLineChars * 2).optional(),
    /** Manual cues (or imported with import_captions). When empty, cues are built from the voice's word timestamps, else from scene caption text. */
    cues: z.array(captionCue).max(2000).optional(),
  })
  .strict();

export type CaptionWord = z.infer<typeof captionWord>;
export type CaptionCue = z.infer<typeof captionCue>;
export type ProjectCaptions = z.infer<typeof projectCaptions>;

// ---- line breaking ----------------------------------------------------------

/**
 * Words a line must not end with: articles and possessive determiners stay
 * with their noun (Netflix Timed Text Style Guide, "line treatment"). English
 * only; other languages get the punctuation and balance rules.
 */
const NEVER_BREAK_AFTER = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'mr.', 'mrs.', 'ms.', 'dr.']);
/** Words a second line may well start with: conjunctions and prepositions. */
const GOOD_BREAK_BEFORE = new Set(['and', 'but', 'or', 'so', 'because', 'which', 'who', 'that', 'when', 'while', 'if', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'about', 'into']);

const OPENING_PUNCT = new Set(['(', '"', "'", '“', '‘', '¿', '¡']);
const CLOSING_PUNCT = new Set([')', '"', "'", '”', '’']);
/** The word in lower case without wrapping quotes or brackets (a linear scan, no regex backtracking). */
const bare = (w: string) => {
  let start = 0;
  let end = w.length;
  while (start < end && OPENING_PUNCT.has(w[start]!)) start++;
  while (end > start && CLOSING_PUNCT.has(w[end - 1]!)) end--;
  return w.slice(start, end).toLowerCase();
};

export function normalizeCaptionText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Break a cue's text into lines of at most `maxLineChars`. Author line breaks
 * ("\n") are kept. Otherwise one line when it fits, else the best two-line
 * split: after sentence or clause punctuation, before a conjunction or
 * preposition, never after an article, then the most even (slightly
 * bottom-heavy) shape. Text that does not fit in two lines is wrapped
 * greedily (the quality rules then report it).
 */
export function breakLines(text: string, maxLineChars: number = CAPTION_RULES.maxLineChars): string[] {
  const explicit = text.split(/\r?\n/).map(normalizeCaptionText).filter(Boolean);
  if (explicit.length > 1) return explicit;
  const t = explicit[0] ?? '';
  if (t.length <= maxLineChars) return t ? [t] : [];
  const words = t.split(' ');
  let best: { i: number; score: number } | null = null;
  for (let i = 1; i < words.length; i++) {
    const top = words.slice(0, i).join(' ');
    const bottom = words.slice(i).join(' ');
    if (top.length > maxLineChars || bottom.length > maxLineChars) continue;
    const prev = words[i - 1]!;
    let score = Math.abs(top.length - bottom.length);
    if (top.length > bottom.length) score += 4; // prefer a bottom-heavy pyramid
    if (i <= 2) score += 30; // avoid one or two words on the top line
    if (/[.!?…]["')\]”’]*$/.test(prev)) score -= 60;
    else if (/[,;:–—]["')\]”’]*$/.test(prev)) score -= 40;
    else if (GOOD_BREAK_BEFORE.has(bare(words[i]!))) score -= 15;
    if (NEVER_BREAK_AFTER.has(bare(prev))) score += 1000;
    if (!best || score < best.score) best = { i, score };
  }
  if (best) return [words.slice(0, best.i).join(' '), words.slice(best.i).join(' ')];
  // Does not fit in two lines: greedy wrap.
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > maxLineChars) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}

// ---- building cues from word timings ----------------------------------------

export interface CueBuildOptions {
  /** Added to every word time (the voice's start in the video). */
  offsetSeconds?: number;
  maxCharsPerCue: number;
  fps: number;
  /** End of the video: cues are clipped to it, cues after it dropped. */
  endSeconds?: number;
  /** A pause at least this long starts a new cue. */
  pauseSeconds?: number;
}

const SENTENCE_END = /[.!?…]["')\]”’]*$/;
const CLAUSE_END = /[,;:–—]["')\]”’]*$/;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Group timed words into cues: a cue ends at a sentence end, a long pause,
 * `maxCharsPerCue` or 7 seconds, and at a clause break once it is more than
 * half full. Timing then follows the quality rules where the words allow it:
 * at least 0.833 s on screen (extended into the following silence), at most
 * 7 s, a gap of at least two frames before the next cue, and gaps under half
 * a second closed to two frames (Netflix timing guidelines, "chaining").
 */
export function buildCuesFromWords(words: readonly CaptionWord[], o: CueBuildOptions): CaptionCue[] {
  const offset = o.offsetSeconds ?? 0;
  const pause = o.pauseSeconds ?? 0.7;
  const groups: CaptionWord[][] = [];
  let cur: CaptionWord[] = [];
  const len = (ws: CaptionWord[]) => ws.reduce((n, w) => n + w.text.length, 0) + Math.max(0, ws.length - 1);
  for (const raw of words) {
    const w = { text: normalizeCaptionText(raw.text), start: raw.start + offset, end: Math.max(raw.end, raw.start) + offset };
    if (!w.text) continue;
    const last = cur.at(-1);
    if (last && w.start - last.end >= pause) {
      groups.push(cur);
      cur = [];
    } else if (last && (len([...cur, w]) > o.maxCharsPerCue || w.end - cur[0]!.start > CAPTION_RULES.maxSeconds)) {
      // Full: end the cue at its last clause break when that leaves a third or more of it, and never on an article.
      let j = cur.length;
      for (let k = cur.length - 1; k > 0; k--) {
        if (CLAUSE_END.test(cur[k - 1]!.text) && len(cur.slice(0, k)) >= o.maxCharsPerCue / 3) {
          j = k;
          break;
        }
      }
      if (j === cur.length) while (j > 1 && NEVER_BREAK_AFTER.has(bare(cur[j - 1]!.text))) j--;
      groups.push(cur.slice(0, j));
      cur = cur.slice(j);
    }
    cur.push(w);
    if (SENTENCE_END.test(w.text) || (CLAUSE_END.test(w.text) && len(cur) >= o.maxCharsPerCue / 2)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  // A group too short to read that runs straight into the next one joins it when the two fit in one cue.
  for (let i = 0; i + 1 < groups.length; i++) {
    const g = groups[i]!;
    const next = groups[i + 1]!;
    const short = g.at(-1)!.end - g[0]!.start < CAPTION_RULES.minSeconds && next[0]!.start - g.at(-1)!.end < CAPTION_RULES.minSeconds;
    if (short && len([...g, ...next]) <= o.maxCharsPerCue && next.at(-1)!.end - g[0]!.start <= CAPTION_RULES.maxSeconds) {
      groups.splice(i, 2, [...g, ...next]);
      i--;
    }
  }

  const gap = CAPTION_RULES.minGapFrames / o.fps;
  const end = o.endSeconds ?? Infinity;
  const cues: CaptionCue[] = [];
  groups.forEach((g, i) => {
    const start = g[0]!.start;
    if (start >= end) return;
    const nextStart = groups[i + 1]?.[0]!.start ?? Infinity;
    // At least 0.833 s; a gap under half a second to the next cue is closed to two frames ("chaining").
    let stop = Math.max(g.at(-1)!.end, start + CAPTION_RULES.minSeconds, nextStart - g.at(-1)!.end < 0.5 ? nextStart - gap : 0);
    stop = Math.min(stop, start + CAPTION_RULES.maxSeconds, nextStart - gap, end);
    if (stop <= start) stop = Math.min(g.at(-1)!.end, end);
    if (stop <= start) return;
    cues.push({
      start: round3(start),
      end: round3(stop),
      text: g.map((w) => w.text).join(' '),
      words: g.map((w) => ({ text: w.text, start: round3(Math.min(w.start, stop)), end: round3(Math.min(w.end, stop)) })),
    });
  });
  return cues;
}

/**
 * Cues for a text shown over a time span with no word timings (scene caption
 * text): words get times in proportion to their length, then the same
 * grouping as for spoken words. The words are not kept (no highlight).
 */
export function buildCuesFromText(text: string, start: number, end: number, o: Omit<CueBuildOptions, 'offsetSeconds'>): CaptionCue[] {
  const tokens = normalizeCaptionText(text).split(' ').filter(Boolean);
  const total = tokens.reduce((n, t) => n + t.length + 1, 0);
  let t = start;
  const words = tokens.map((text) => {
    const d = ((end - start) * (text.length + 1)) / total;
    const w = { text, start: t, end: t + d };
    t += d;
    return w;
  });
  return buildCuesFromWords(words, { ...o, pauseSeconds: Infinity, endSeconds: Math.min(end, o.endSeconds ?? end) }).map(({ words: _w, ...c }) => c);
}

// ---- quality rules ----------------------------------------------------------

export type CaptionRule = 'lineLength' | 'lineCount' | 'readingSpeed' | 'minDuration' | 'maxDuration' | 'gap' | 'order' | 'pastEnd';

export interface CaptionIssue {
  cue: number;
  rule: CaptionRule;
  message: string;
}

export interface CaptionQa {
  ok: boolean;
  cues: number;
  rules: { maxLineChars: number; maxLines: number; maxCharsPerSecond: number; minSeconds: number; maxSeconds: number; minGapFrames: number };
  /** Highest reading speed of any cue (characters per second). */
  maxCps: number;
  issues: CaptionIssue[];
}

/** Characters a viewer reads: the text with whitespace collapsed (line breaks count as a space). */
export function cueChars(text: string): number {
  return normalizeCaptionText(text).length;
}

/**
 * Check cues against the quality rules: ≤ maxLineChars characters per line and
 * ≤ 2 lines after the automatic line break, ≤ 20 characters per second,
 * 0.833-7 s on screen, at least two frames between cues, in time order and
 * inside the video.
 */
export function checkCaptions(cues: readonly CaptionCue[], o: { fps: number; maxLineChars?: number; endSeconds?: number }): CaptionQa {
  const maxLineChars = o.maxLineChars ?? CAPTION_RULES.maxLineChars;
  const issues: CaptionIssue[] = [];
  const eps = 1e-6;
  let maxCps = 0;
  cues.forEach((c, i) => {
    const add = (rule: CaptionRule, message: string) => issues.push({ cue: i, rule, message });
    const d = c.end - c.start;
    const lines = breakLines(c.text, maxLineChars);
    const longest = Math.max(0, ...lines.map((l) => l.length));
    if (longest > maxLineChars) add('lineLength', `a line has ${longest} characters (max ${maxLineChars}); shorten the cue or split it`);
    if (lines.length > CAPTION_RULES.maxLines) add('lineCount', `${lines.length} lines (max ${CAPTION_RULES.maxLines}); split the cue`);
    const cps = d > 0 ? cueChars(c.text) / d : Infinity;
    maxCps = Math.max(maxCps, Number.isFinite(cps) ? cps : 0);
    if (cps > CAPTION_RULES.maxCharsPerSecond + eps) add('readingSpeed', `${cps.toFixed(1)} characters per second (max ${CAPTION_RULES.maxCharsPerSecond}); show it longer or shorten it`);
    if (d < CAPTION_RULES.minSeconds - eps) add('minDuration', `on screen for ${d.toFixed(3)}s (min ${CAPTION_RULES.minSeconds}s)`);
    if (d > CAPTION_RULES.maxSeconds + eps) add('maxDuration', `on screen for ${d.toFixed(3)}s (max ${CAPTION_RULES.maxSeconds}s)`);
    if (o.endSeconds !== undefined && c.end > o.endSeconds + eps) add('pastEnd', `ends at ${c.end}s, after the end of the video (${o.endSeconds}s); it is cut there`);
    const next = cues[i + 1];
    if (next) {
      const gap = next.start - c.end;
      if (next.start < c.start) add('order', `cue ${i + 1} starts before this one; cues must be in time order`);
      else if (gap < CAPTION_RULES.minGapFrames / o.fps - eps) {
        add('gap', gap < 0 ? `overlaps the next cue by ${(-gap).toFixed(3)}s` : `only ${Math.round(gap * o.fps)} frame(s) before the next cue (min ${CAPTION_RULES.minGapFrames})`);
      }
    }
  });
  return {
    ok: issues.length === 0,
    cues: cues.length,
    rules: { ...CAPTION_RULES, maxLineChars },
    maxCps: Math.round(maxCps * 10) / 10,
    issues,
  };
}

// ---- SRT / WebVTT -----------------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 1.5 -> "00:00:01,500" (SRT) or "00:00:01.500" (WebVTT). */
export function formatTimestamp(seconds: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

/** SubRip: numbered cues, line breaks from the line breaker. */
export function formatSrt(cues: readonly CaptionCue[], maxLineChars: number = CAPTION_RULES.maxLineChars): string {
  return cues
    .map((c, i) => `${i + 1}\n${formatTimestamp(c.start, ',')} --> ${formatTimestamp(c.end, ',')}\n${breakLines(c.text, maxLineChars).join('\n')}\n`)
    .join('\n');
}

const vttEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** WebVTT, with inline word timestamps (`<00:00:01.200>`) when the cue has word timings. */
export function formatVtt(cues: readonly CaptionCue[], o: { maxLineChars?: number; language?: string } = {}): string {
  const head = `WEBVTT${o.language ? `\nLanguage: ${o.language}` : ''}\n\n`;
  return (
    head +
    cues
      .map((c) => {
        const lines = breakLines(c.text, o.maxLineChars);
        let body = lines.map(vttEscape).join('\n');
        const tokens = cueTokens(c);
        if (tokens) {
          // Same line break, each word after the first preceded by its start time.
          let k = 0;
          body = lines
            .map((line) =>
              line
                .split(' ')
                .map((w) => {
                  const t = tokens[k++]!;
                  return (t.first && k > 1 ? `<${formatTimestamp(t.start, '.')}>` : '') + vttEscape(w);
                })
                .join(' ')
            )
            .join('\n');
        }
        return `${formatTimestamp(c.start, '.')} --> ${formatTimestamp(c.end, '.')}\n${body}\n`;
      })
      .join('\n')
  );
}

/**
 * The cue's display tokens (its text split on spaces) mapped to word timings,
 * or null when the cue has no words or its text no longer matches them (edited
 * text: no highlight rather than a wrong one). `first` marks the first token of
 * a word (a timed word may contain spaces).
 */
export function cueTokens(c: CaptionCue): Array<{ word: number; start: number; first: boolean }> | null {
  if (!c.words?.length) return null;
  const fromWords = c.words.flatMap((w, i) => normalizeCaptionText(w.text).split(' ').filter(Boolean).map((_, j) => ({ word: i, start: w.start, first: j === 0 })));
  const text = normalizeCaptionText(c.text).split(' ');
  if (fromWords.length !== text.length) return null;
  const joined = c.words.map((w) => normalizeCaptionText(w.text)).filter(Boolean).join(' ');
  return joined === normalizeCaptionText(c.text) ? fromWords : null;
}

export class CaptionParseError extends Error {
  constructor(readonly line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.name = 'CaptionParseError';
  }
}

const TIME = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;

function parseTime(s: string, line: number): number {
  const m = TIME.exec(s.trim());
  if (!m) throw new CaptionParseError(line, `"${s.trim()}" is not a timestamp like 00:00:01,500`);
  const [, h, mm, ss, frac] = m;
  if (Number(mm) > 59 || Number(ss) > 59) throw new CaptionParseError(line, `"${s.trim()}" is not a valid time`);
  return Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss) + Number(frac!.padEnd(3, '0')) / 1000;
}

/** Remove a pattern until none is left, so nested markup like `<scr<b>ipt>` cannot survive one pass. */
const removeAll = (s: string, pattern: RegExp) => {
  let prev: string;
  do {
    prev = s;
    s = s.replace(pattern, '');
  } while (s !== prev);
  return s;
};

const stripTags = (s: string) =>
  removeAll(removeAll(s, /<[^>]*>/g), /\{\\[^}]*\}/g)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

function parseBlocks(input: string, vtt: boolean): CaptionCue[] {
  const lines = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues: CaptionCue[] = [];
  let i = 0;
  if (vtt) {
    if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0] ?? '')) throw new CaptionParseError(1, 'a WebVTT file starts with "WEBVTT"');
    while (i < lines.length && lines[i]!.trim() !== '') i++; // header
  }
  while (i < lines.length) {
    while (i < lines.length && lines[i]!.trim() === '') i++;
    if (i >= lines.length) break;
    const blockStart = i;
    const block: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') block.push(lines[i++]!);
    if (vtt && /^(NOTE|STYLE|REGION)(\s|$)/.test(block[0]!)) continue;
    const t = block.findIndex((l) => l.includes('-->'));
    if (t < 0 || t > 1) throw new CaptionParseError(blockStart + 1, 'expected a "start --> end" timing line');
    const [a, rest] = block[t]!.split('-->') as [string, string];
    const b = rest.trim().split(/\s+/)[0] ?? '';
    const start = parseTime(a, blockStart + t + 1);
    const end = parseTime(b, blockStart + t + 1);
    if (end <= start) throw new CaptionParseError(blockStart + t + 1, 'the cue ends before it starts');
    const text = block
      .slice(t + 1)
      .map((l) => normalizeCaptionText(stripTags(l)))
      .filter(Boolean)
      .join('\n');
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

/** Parse SubRip (.srt). Formatting tags are removed; line breaks are kept. */
export function parseSrt(input: string): CaptionCue[] {
  return parseBlocks(input, false);
}

/** Parse WebVTT (.vtt). NOTE, STYLE and REGION blocks, cue settings and tags (incl. inline timestamps) are dropped. */
export function parseVtt(input: string): CaptionCue[] {
  return parseBlocks(input, true);
}

/** Parse SRT or WebVTT; the format is detected from the "WEBVTT" header when not given. */
export function parseCaptions(input: string, format?: 'srt' | 'vtt'): CaptionCue[] {
  const f = format ?? (/^﻿?WEBVTT/.test(input) ? 'vtt' : 'srt');
  return f === 'vtt' ? parseVtt(input) : parseSrt(input);
}
