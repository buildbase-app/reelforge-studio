import { z } from 'zod';

/**
 * The project glossary (issue #486, docs/CAPTIONS.md#glossary): exact
 * spellings for captions and speech-to-text, pronunciations for
 * text-to-speech, and terms a translation must keep. The user (or their agent)
 * writes every entry; the engine only applies them (D-128). Everything here
 * is pure.
 */

/** Most entries one project carries. */
export const MAX_GLOSSARY_TERMS = 200;

const phrase = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, 'must not be empty'));

export const glossaryEntry = z
  .object({
    /** The exact spelling captions must show, e.g. "RenderWeld" or "Claude Code". */
    term: phrase(100),
    /** How the voice should say it, as a respelling sent to the TTS provider in place of the term ("render weld"). Captions keep `term`. */
    spoken: phrase(200).optional(),
    /** Spellings speech-to-text tends to produce ("render weld", "rendaweld"); replaced by `term` after transcription. The term in any letter case is always replaced. */
    alternatives: z.array(phrase(100)).max(20).optional(),
    /** A translation keeps the term as written (localisation, #308). Stored for agents and translation tools; the engine translates nothing itself. */
    doNotTranslate: z.boolean().optional(),
  })
  .strict();

export const projectGlossary = z
  .array(glossaryEntry)
  .max(MAX_GLOSSARY_TERMS)
  .superRefine((entries, ctx) => {
    const seen = new Map<string, number>();
    entries.forEach((e, i) => {
      const key = phraseKey(e.term);
      if (!key) ctx.addIssue({ code: 'custom', path: [i, 'term'], message: 'the term has no letters or digits' });
      else if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [i, 'term'], message: `"${e.term}" is already entry ${seen.get(key)}` });
      else seen.set(key, i);
    });
  });

export type GlossaryEntry = z.infer<typeof glossaryEntry>;
export type ProjectGlossary = z.infer<typeof projectGlossary>;

// ---- tokens -----------------------------------------------------------------

const LEADING = new Set(['(', '[', '"', "'", '“', '‘', '¿', '¡', '«']);
const TRAILING = new Set([')', ']', '"', "'", '”', '’', '»', '.', ',', '!', '?', ';', ':', '…']);

/** A word split into its leading punctuation, its core and its trailing punctuation ("(RenderWeld)," -> "(", "RenderWeld", "),"). A linear scan. */
export function splitToken(w: string): { lead: string; core: string; tail: string } {
  let a = 0;
  let b = w.length;
  while (a < b && LEADING.has(w[a]!)) a++;
  while (b > a && TRAILING.has(w[b - 1]!)) b--;
  return { lead: w.slice(0, a), core: w.slice(a, b), tail: w.slice(b) };
}

/** The words of a phrase, each without its surrounding punctuation, in lower case ("Claude Code." -> ["claude", "code"]). */
export function phraseTokens(s: string): string[] {
  return s
    .split(/\s+/)
    .map((w) => splitToken(w).core.toLowerCase())
    .filter(Boolean);
}

const phraseKey = (s: string) => phraseTokens(s).join(' ');

// ---- speech-to-text ---------------------------------------------------------

/** Longest prompt passed to speech-to-text (Whisper reads at most about 224 tokens of it). */
export const GLOSSARY_PROMPT_MAX_CHARS = 600;

/**
 * The terms as a speech-to-text prompt (faster-whisper `initial_prompt`): a
 * plain comma-separated list in glossary order, cut at whole terms to
 * GLOSSARY_PROMPT_MAX_CHARS. Undefined for an empty glossary.
 */
export function glossaryPrompt(glossary: readonly GlossaryEntry[] | undefined): string | undefined {
  if (!glossary?.length) return undefined;
  let out = '';
  for (const e of glossary) {
    const next = out ? `${out}, ${e.term}` : e.term;
    if (next.length + 1 > GLOSSARY_PROMPT_MAX_CHARS) break;
    out = next;
  }
  return out ? `${out}.` : undefined;
}

// ---- timed words ------------------------------------------------------------

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

export interface GlossaryReplacement {
  /** The words as they came from the provider. */
  from: string;
  /** What replaced them (the term, with the original punctuation around it). */
  to: string;
  term: string;
  /** Start of the first replaced word, in seconds (same time base as the words). */
  start: number;
}

interface Pattern {
  tokens: string[];
  term: string;
}

/**
 * Where a match of `tokens` starting at word `i` ends (exclusive), or -1. A
 * word may hold several tokens; matching goes token by token across whole words.
 */
function matchAt(cores: readonly string[][], i: number, tokens: readonly string[]): number {
  let j = i;
  let k = 0;
  while (j < cores.length && k < tokens.length) {
    const ws = cores[j]!;
    if (!ws.length || k + ws.length > tokens.length || ws.some((t, n) => t !== tokens[k + n])) break;
    k += ws.length;
    j++;
  }
  return k === tokens.length && j > i ? j : -1;
}

/**
 * Replace word sequences in timed words: each pattern's words (compared
 * without surrounding punctuation and ignoring letter case) become one word
 * with the term, the first word's leading punctuation, the last word's
 * trailing punctuation, and the span of the words it replaces. Longer
 * patterns win; a match never overlaps another. Words already equal to the
 * term are left alone and not reported.
 */
function replaceWords<W extends TimedWord>(words: readonly W[], patterns: readonly Pattern[]): { words: W[]; replacements: GlossaryReplacement[] } {
  const sorted = [...patterns].filter((p) => p.tokens.length).sort((a, b) => b.tokens.length - a.tokens.length);
  const cores = words.map((w) => phraseTokens(w.text));
  const out: W[] = [];
  const replacements: GlossaryReplacement[] = [];
  let i = 0;
  while (i < words.length) {
    let done = false;
    for (const p of sorted) {
      const j = matchAt(cores, i, p.tokens);
      if (j < 0) continue;
      const first = words[i]!;
      const last = words[j - 1]!;
      const text = `${splitToken(first.text.split(/\s+/)[0] ?? '').lead}${p.term}${splitToken(last.text.split(/\s+/).at(-1) ?? '').tail}`;
      const from = words
        .slice(i, j)
        .map((w) => w.text)
        .join(' ');
      if (from !== text) replacements.push({ from, to: text, term: p.term, start: first.start });
      out.push({ ...first, text, start: first.start, end: Math.max(last.end, first.start) });
      i = j;
      done = true;
      break;
    }
    if (!done) out.push(words[i++]!);
  }
  return { words: out, replacements };
}

/**
 * Speech-to-text words with the glossary applied: every term in any letter
 * case and every listed alternative becomes the term's exact spelling.
 * Exact word matches only (no fuzzy matching, which would rewrite real words).
 */
export function applyGlossaryToTranscript<W extends TimedWord>(words: readonly W[], glossary: readonly GlossaryEntry[] | undefined) {
  if (!glossary?.length) return { words: [...words], replacements: [] as GlossaryReplacement[] };
  const patterns: Pattern[] = glossary.flatMap((e) => [e.term, ...(e.alternatives ?? [])].map((s) => ({ tokens: phraseTokens(s), term: e.term })));
  return replaceWords(words, patterns);
}

/** TTS word timings back to the spelling of the script: each `spoken` respelling becomes its term again. */
export function restoreGlossaryTerms<W extends TimedWord>(words: readonly W[], glossary: readonly GlossaryEntry[] | undefined) {
  const patterns: Pattern[] = (glossary ?? []).filter((e) => e.spoken).map((e) => ({ tokens: phraseTokens(e.spoken!), term: e.term }));
  if (!patterns.length) return { words: [...words], replacements: [] as GlossaryReplacement[] };
  return replaceWords(words, patterns);
}

// ---- text-to-speech ---------------------------------------------------------

/**
 * The text a TTS provider should read: each term with a `spoken` form
 * (whole words, any letter case) replaced by it, punctuation and spacing
 * kept. Returns the text unchanged and 0 when nothing applies.
 */
export function spokenText(text: string, glossary: readonly GlossaryEntry[] | undefined): { text: string; replaced: number } {
  const patterns = (glossary ?? [])
    .filter((e) => e.spoken)
    .map((e) => ({ tokens: phraseTokens(e.term), spoken: e.spoken! }))
    .filter((p) => p.tokens.length)
    .sort((a, b) => b.tokens.length - a.tokens.length);
  if (!patterns.length) return { text, replaced: 0 };
  // Words and the whitespace after each, so the text is rebuilt exactly where nothing matches.
  const parts = text.split(/(\s+)/);
  const lead = parts[0] === '' ? (parts.splice(0, 2)[1] ?? '') : '';
  const words: string[] = [];
  const spaces: string[] = [];
  for (let n = 0; n < parts.length; n += 2) {
    if (parts[n]) {
      words.push(parts[n]!);
      spaces.push(parts[n + 1] ?? '');
    }
  }
  const cores = words.map((w) => phraseTokens(w));
  let out = lead;
  let replaced = 0;
  for (let i = 0; i < words.length; ) {
    const hit = patterns.map((p) => ({ p, j: matchAt(cores, i, p.tokens) })).find((m) => m.j > 0);
    if (!hit) {
      out += words[i]! + spaces[i]!;
      i++;
      continue;
    }
    out += splitToken(words[i]!).lead + hit.p.spoken + splitToken(words[hit.j - 1]!).tail + spaces[hit.j - 1]!;
    replaced++;
    i = hit.j;
  }
  return { text: replaced ? out : text, replaced };
}

// ---- caption check ----------------------------------------------------------

export type GlossaryIssueRule = 'missingFromCaptions' | 'notInScript';

export interface GlossaryIssue {
  term: string;
  rule: GlossaryIssueRule;
  /** Times in the script (any letter case) and in the captions (exact spelling). */
  inScript: number;
  inCaptions: number;
  message: string;
}

/** How often a phrase occurs in a text, as whole words; `exact` compares the spelling, else letter case is ignored. */
export function countPhrase(text: string, phrase: string, exact: boolean): number {
  const want = phrase.split(/\s+/).map((w) => splitToken(w).core).filter(Boolean);
  if (!want.length) return 0;
  const words = text.split(/\s+/).map((w) => splitToken(w).core).filter(Boolean);
  const eq = (a: string, b: string) => (exact ? a === b : a.toLowerCase() === b.toLowerCase());
  let n = 0;
  for (let i = 0; i + want.length <= words.length; i++) {
    if (want.every((t, k) => eq(words[i + k]!, t))) {
      n++;
      i += want.length - 1;
    }
  }
  return n;
}

/**
 * Compare the script with the captions for every term: a term the script
 * says more often than the captions spell it exactly is `missingFromCaptions`
 * (misheard or misspelled); a term the captions show more often than the
 * script says it is `notInScript` (speech-to-text inserted it). Empty without
 * a script or a glossary.
 */
export function checkGlossary(script: string | undefined, captionText: string, glossary: readonly GlossaryEntry[] | undefined): GlossaryIssue[] {
  if (!script?.trim() || !glossary?.length) return [];
  const issues: GlossaryIssue[] = [];
  for (const e of glossary) {
    const inScript = countPhrase(script, e.term, false);
    const inCaptions = countPhrase(captionText, e.term, true);
    if (inScript > inCaptions) {
      issues.push({
        term: e.term,
        rule: 'missingFromCaptions',
        inScript,
        inCaptions,
        message: `"${e.term}" is in the script ${inScript} time(s) but spelled that way in the captions ${inCaptions} time(s); correct the cues or add the misheard spelling to the glossary's alternatives`,
      });
    } else if (inCaptions > inScript) {
      issues.push({
        term: e.term,
        rule: 'notInScript',
        inScript,
        inCaptions,
        message: `"${e.term}" is in the captions ${inCaptions} time(s) but in the script ${inScript} time(s); check what was said there`,
      });
    }
  }
  return issues;
}
