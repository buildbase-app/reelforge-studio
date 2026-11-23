import { z } from 'zod';
import {
  CAPTION_MODES,
  CUE_KINDS,
  MAX_PROJECT_SECONDS,
  captionCue,
  isLanguageTag,
  languageTag,
  resolveCaptions,
  sameLanguage,
  type CaptionCue,
  type CaptionMode,
  type CaptionQa,
  type Project,
  type ResolvedCaptionTrack,
} from '@reelforge/project-schema';
import { captionsEtag, type CaptionManifest } from './captions';
import { ApiError, badRequest, notFound } from './errors';

/**
 * Caption approval (#300, D-110): what get_captions shows, and how
 * update_captions edits cues with an etag check. Pure functions over a
 * manifest; the service does the storage, the audit entry and the response.
 */

/** update_captions input (without expectedVersion, which REST takes as If-Match too). */
export const updateCaptionsInput = z
  .object({
    etag: z.string().min(1).max(100).describe('The etag from get_captions; the update is refused if the captions changed since.'),
    language: languageTag.optional().describe('Language to edit (BCP 47). Default: the primary language. A new tag adds a language.'),
    cues: z.array(captionCue).max(2000).optional().describe('Replace every cue of this language (captions and descriptions). [] removes them.'),
    edits: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(1999).describe('Position in get_captions cues (or descriptions with kind "description").'),
            kind: z.enum(CUE_KINDS).optional(),
            text: z.string().min(1).max(500).optional(),
            start: z.number().min(0).max(MAX_PROJECT_SECONDS).optional(),
            end: z.number().min(0).max(MAX_PROJECT_SECONDS).optional(),
            delete: z.literal(true).optional(),
          })
          .strict()
      )
      .max(500)
      .optional(),
    mode: z.enum(CAPTION_MODES).optional(),
    burnLanguage: languageTag.nullable().optional(),
    highlight: z.enum(['none', 'word']).optional(),
    approve: z.boolean().optional().describe('true: record that the user approved the captions as they are after this update; false: withdraw an approval.'),
  })
  .strict();
export type UpdateCaptionsInput = z.infer<typeof updateCaptionsInput>;

export const getCaptionsInput = z
  .object({
    projectId: z.string().min(1).max(200).optional(),
    renderId: z.string().min(1).max(200).optional(),
    language: languageTag.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.projectId) !== Boolean(v.renderId), { message: 'give projectId or renderId (one of them)' });

export const transcribeInput = z
  .object({
    language: z
      .string()
      .min(2)
      .max(35)
      .refine((v) => v === 'auto' || isLanguageTag(v), '"auto" or a BCP 47 language tag')
      .optional()
      .describe('Spoken language; default captions.stt.language ("auto" detects it).'),
    provider: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/).optional(),
    replaceCues: z.boolean().optional().describe('Remove the manual caption cues of the primary language, so the transcription is what shows.'),
  })
  .strict();

/** Zod errors as a 400 with every problem. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown, what: string): z.infer<T> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    throw badRequest(`invalid ${what}: ${r.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`, {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

const unquote = (etag: string) => etag.trim().replace(/^W\//, '').split('"').join('');

/** One language as get_captions shows it. */
export interface CaptionLanguageView {
  language: string | null;
  primary: boolean;
  burned: boolean;
  source: ResolvedCaptionTrack['source'];
  cues: CaptionCue[];
  descriptions: CaptionCue[];
  qa: CaptionQa;
  files?: Record<string, string>;
}

/** get_captions for a project: every language's cues and quality check, the etag and the approval state. */
export function projectCaptionsView(project: Project, version: number, defaultMode: CaptionMode, language?: string) {
  const r = resolveCaptions(project, { defaultMode });
  const etag = captionsEtag(project, r);
  const tracks = language ? r.tracks.filter((t) => sameLanguage(t.language, language)) : r.tracks;
  if (language && !tracks.length) throw notFound('caption language', language, { languages: r.tracks.map((t) => t.language) });
  const approval = project.captions.approval ?? null;
  return {
    projectId: project.projectId,
    version,
    etag,
    mode: r.mode,
    modeSource: r.modeSource,
    burnLanguage: r.burnLanguage,
    highlight: r.highlight,
    maxLineChars: r.maxLineChars,
    approved: approval?.etag === etag,
    approval,
    languages: tracks.map(
      (t): CaptionLanguageView => ({ language: t.language, primary: t.primary, burned: t.burned, source: t.source, cues: t.cues, descriptions: t.descriptions, qa: t.qa })
    ),
    next: 'Show the user these captions (text and times) and the qa issues. To change them call update_captions with this etag; when the user approves, update_captions with approve: true; then render_project.',
  };
}

/** get_captions for a render: the cues as they were rendered (render manifest), with the sidecar file names. */
export function renderCaptionsView(renderId: string, projectId: string, m: { captions?: CaptionManifest; project?: Project }, language?: string) {
  const c = m.captions;
  if (!c) return { renderId, projectId, mode: 'off' as CaptionMode, burned: false, burnLanguage: null, approved: false, languages: [] as CaptionLanguageView[] };
  let languages: CaptionLanguageView[];
  if (c.tracks) {
    languages = c.tracks.map((t) => ({ language: t.language, primary: t.primary, burned: t.burned, source: t.source, cues: t.cues, descriptions: t.descriptions, qa: t.qa, files: t.files as Record<string, string> }));
  } else {
    // A render from before languages were recorded (#316): the primary language, resolved from the project it rendered.
    const r = m.project ? resolveCaptions(m.project, { mode: c.mode }) : null;
    languages = [{ language: c.language, primary: true, burned: c.burned, source: c.source, cues: r?.cues ?? [], descriptions: [], qa: c.qa, files: c.files as Record<string, string> }];
  }
  if (language) {
    languages = languages.filter((t) => sameLanguage(t.language, language));
    if (!languages.length) throw notFound('caption language', language);
  }
  return { renderId, projectId, mode: c.mode, burned: c.burned, burnLanguage: c.burnLanguage ?? (c.burned ? c.language : null), approved: c.approved ?? false, languages };
}

const byStart = (a: CaptionCue, b: CaptionCue) => a.start - b.start;

/**
 * The project's `captions` after an update_captions call (not yet validated):
 * checks the etag against the current captions, replaces or edits the cues
 * of one language (materialising cues built from the voice or scenes into
 * captions.cues), and sets mode, burn language and highlight. Each kind is
 * kept in time order.
 */
export function applyCaptionUpdate(project: Project, input: UpdateCaptionsInput, defaultMode: CaptionMode): { captions: Record<string, unknown>; etagBefore: string; language: string | null; cues?: number } {
  const r = resolveCaptions(project, { defaultMode });
  const etagBefore = captionsEtag(project, r);
  if (unquote(input.etag) !== unquote(etagBefore)) {
    throw new ApiError('captions_conflict', 409, 'the captions changed since you read them; call get_captions again, show the user the current captions, then retry with the new etag', { etag: etagBefore });
  }
  const captions: Record<string, unknown> = structuredClone(project.captions);
  const primaryTrack = r.tracks[0]!;
  // The primary language unless another one is named; a primary without a tag takes the first tag it is given.
  let track = input.language ? r.tracks.find((t) => sameLanguage(t.language, input.language)) : primaryTrack;
  if (!track && input.language && primaryTrack.language === null) {
    track = primaryTrack;
    captions.language = input.language;
  }
  const language = track?.language ?? input.language ?? null;
  const isPrimary = track ? track.primary : false;
  let written: number | undefined;
  if (input.cues !== undefined || input.edits?.length) {
    let caps: CaptionCue[];
    let descs: CaptionCue[];
    if (input.cues !== undefined) {
      caps = input.cues.filter((c) => c.kind !== 'description').map(({ kind: _k, ...c }) => c);
      descs = input.cues.filter((c) => c.kind === 'description');
    } else {
      caps = (track?.cues ?? []).map((c) => structuredClone(c));
      descs = (track?.descriptions ?? []).map((c) => ({ ...structuredClone(c), kind: 'description' as const }));
    }
    const drop = { caption: new Set<number>(), description: new Set<number>() };
    for (const e of input.edits ?? []) {
      const kind = e.kind ?? 'caption';
      const list = kind === 'description' ? descs : caps;
      const cue = list[e.index];
      if (!cue) throw badRequest(`edits: there is no ${kind} cue ${e.index} in ${language ?? 'the primary language'} (it has ${list.length}); indexes are those of get_captions`);
      if (e.delete) {
        drop[kind].add(e.index);
        continue;
      }
      if (e.text !== undefined && e.text !== cue.text) {
        cue.text = e.text;
        // Word timings belong to the old text: the highlight would be wrong.
        delete cue.words;
      }
      if (e.start !== undefined) cue.start = e.start;
      if (e.end !== undefined) cue.end = e.end;
    }
    caps = caps.filter((_, i) => !drop.caption.has(i)).sort(byStart);
    descs = descs.filter((_, i) => !drop.description.has(i)).sort(byStart);
    const list = [...caps, ...descs];
    written = list.length;
    if (isPrimary) {
      if (list.length) captions.cues = list;
      else delete captions.cues;
    } else {
      const tracks = { ...((captions.tracks as Record<string, unknown> | undefined) ?? {}) };
      const key = Object.keys(tracks).find((k) => sameLanguage(k, language)) ?? language!;
      if (list.length) tracks[key] = { cues: list };
      else delete tracks[key];
      if (Object.keys(tracks).length) captions.tracks = tracks;
      else delete captions.tracks;
    }
  }
  if (input.mode !== undefined) captions.mode = input.mode;
  if (input.highlight !== undefined) captions.highlight = input.highlight;
  if (input.burnLanguage === null) delete captions.burnLanguage;
  else if (input.burnLanguage !== undefined) captions.burnLanguage = input.burnLanguage;
  if (input.approve === false) delete captions.approval;
  return { captions, etagBefore, language, ...(written !== undefined ? { cues: written } : {}) };
}
