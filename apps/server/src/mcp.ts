import { readFile } from 'node:fs/promises';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApiError, OLD_SERVER_NAMES, PRIORITIES, PRODUCT_NAME, ReelforgeService, SERVER_NAME, SERVER_TITLE, currentRequest, hasScope, runWithRequest, type AuthContext, type Scope } from '@renderweld/core';
import { auditAction, auditTarget } from './audit';
import { CUE_KINDS, SCHEMA_VERSION, captionCue, languageTag, renderAudioOptions, templateDurationLabel } from '@renderweld/project-schema';
import { z } from 'zod';
import type { ServerConfig } from './config';
import { resourceMetadataUrl } from './oauth';
import { findSkill, skillMarkdown, skillNames, skillsFor, skillsIndex, skillSummary } from './skills/index';

/**
 * MCP tools are thin wrappers over ReelforgeService (the same methods the REST
 * routes call). Names are experimental until v1.0 (docs/AGENT_PLATFORM.md §7).
 */

type Shape = Record<string, z.ZodType>;

interface ToolDef {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  input: Shape;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run(args: any, ctx: { service: ReelforgeService; auth: AuthContext; config: ServerConfig }): Promise<unknown>;
  /** Optional extra content (e.g. a poster image). */
  extra?(result: any, args: any, ctx: { service: ReelforgeService }): Promise<CallToolResult['content']>;
}

const projectId = z.string().describe('Project id (the manifest\'s projectId).');

/** get_frames: the local image files of a result, for its `extra` (never part of the JSON answer). */
const framePaths = new WeakMap<object, string[]>();

/** The render id from renderId, or from jobId once that job has succeeded. */
async function renderIdOf(service: ReelforgeService, renderId: string | undefined, jobId: string | undefined): Promise<string> {
  if (renderId) return renderId;
  if (jobId) {
    const job = await service.getJob(jobId);
    if (job.status !== 'succeeded') throw new ApiError('job_not_finished', 409, `job ${jobId} is ${job.status}; call get_job with waitSeconds: 45 until it succeeds`, { error: job.error });
    const id = job.result?.renderId;
    if (typeof id === 'string') return id;
  }
  throw new ApiError('bad_request', 400, 'give renderId or jobId');
}
const expectedVersion = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Optional optimistic-concurrency check: the project version you last read. The call fails with version_conflict if it changed.');
const manifestObj = z
  .record(z.string(), z.unknown())
  .describe('A project manifest (schemaVersion "0.2"; "0.1" is migrated). Call get_project_schema for the full JSON Schema.');
const licenseObj = z
  .object({
    name: z.string().describe('SPDX id or plain name, e.g. "CC0-1.0", "user-provided".'),
    source: z.string().optional(),
    author: z.string().optional(),
    attribution: z.string().optional(),
    redistributable: z.boolean(),
  })
  .optional()
  .describe('Licence metadata for the asset (recommended; missing licences produce a warning).');

/** Paged lists (D-102): the same arguments and nextCursor on list_projects, list_jobs and list_assets. */
const PAGING =
  ' Returns one page, newest first: at most `limit` items (default 50, max 200) and `nextCursor`. When nextCursor is not null there are more: call again with the same arguments plus `cursor: nextCursor` until it is null. Without a cursor you get the first (newest) page only, not everything.';
const pageArgs = {
  limit: z.number().int().min(1).max(200).optional().describe('Page size: 1 to 200, default 50.'),
  cursor: z.string().max(1024).optional().describe('nextCursor from the previous page of this list (same filters), unchanged. Omit for the first page.'),
};

/** What render_project and preview_scene answer when the queue cannot take more (D-090, D-103). */
const QUEUE_REFUSALS =
  ' When the server is busy it refuses with 429: too_many_jobs (your key has too many unfinished jobs), queue_full (the queue is full, or a new job would wait longer than limits.maxEstimatedWaitSeconds; details has the estimate and queued counts) or quota_exceeded. Wait details.retryAfterSeconds, then call again with the same idempotencyKey.';

const idempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe(
    'Optional idempotency key (e.g. a UUID you generate once per intended action): retrying the call with the same key and arguments returns the first result instead of doing it twice; the same key with different arguments fails with idempotency_conflict. Kept 24 h.'
  );
const keyLimits = {
  expiresAt: z.string().nullable().optional().describe('ISO-8601 time the key stops working, e.g. "2027-01-31T00:00:00Z"; null: never.'),
  expiresInDays: z.number().gt(0).max(3650).optional().describe('Shortcut for expiresAt: this many days from now.'),
  rateLimitPerMinute: z.number().int().min(0).nullable().optional().describe('Requests per minute for this key (null: the server default; 0: no limit).'),
  rendersPerDay: z.number().int().min(0).nullable().optional().describe('Render and preview jobs per UTC day (null: unlimited).'),
  rendersPerMonth: z.number().int().min(0).nullable().optional().describe('Render and preview jobs per calendar month, UTC (null: unlimited).'),
  ipAllowlist: z.array(z.string()).max(50).nullable().optional().describe('CIDR blocks the key may be used from, e.g. ["203.0.113.0/24"]; null or []: anywhere.'),
  maxPriority: z
    .enum(PRIORITIES)
    .nullable()
    .optional()
    .describe(
      'Highest job priority the key may ask for: "interactive" lets it start renders ahead of other renders; "batch" keeps all its jobs behind everyone else\'s. null: each job type\'s default (previews interactive, renders standard), so the key can lower a job\'s priority but not raise it.'
    ),
};
/** The priority argument of render_project / preview_scene (D-103). */
const priorityArg = (type: string, def: string) =>
  z
    .enum(PRIORITIES)
    .optional()
    .describe(
      `Queue priority: jobs are started interactive first, then standard, then batch (fairly across API keys within a class). Default "${def}" for a ${type}. Use "batch" for work that can wait. A higher class than your key allows (get_capabilities limits.priority.maxForThisKey) is refused with priority_not_allowed.`
    );
/** Key options from tool arguments (expiresInDays -> expiresAt). */
function keyOpts(a: Record<string, unknown>) {
  const o: Record<string, unknown> = {};
  for (const k of ['expiresAt', 'rateLimitPerMinute', 'rendersPerDay', 'rendersPerMonth', 'ipAllowlist', 'maxPriority']) if (a[k] !== undefined) o[k] = a[k];
  if (typeof a.expiresInDays === 'number') o.expiresAt = new Date(Date.now() + a.expiresInDays * 86_400_000).toISOString();
  return o;
}
const auditFilter = {
  from: z.string().optional().describe('Entries at or after this ISO time.'),
  to: z.string().optional().describe('Entries before this ISO time.'),
  actorId: z.string().optional().describe('Only this actor (API key id).'),
  action: z.string().optional().describe('Exact action ("key.rotate") or a prefix with * ("key.*").'),
  targetType: z.string().optional().describe('e.g. "key", "project", "config".'),
  targetId: z.string().optional(),
  result: z.enum(['success', 'failure', 'denied']).optional(),
};

const timing = (m: Parameters<typeof ReelforgeService.sceneTiming>[0]) => ReelforgeService.sceneTiming(m);

export const TOOLS: ToolDef[] = [
  {
    name: 'get_capabilities',
    title: 'Get server capabilities',
    description:
      'Start here. Returns what this RenderWeld server can do right now: installed engines (and whether each can render on this machine), templates, themes, media providers (configured or not, with cost notes), render backends, limits (fps, max duration, upload size) and tool versions. Never guess an engine, template or provider: use what this returns.',
    scope: 'read',
    input: {},
    annotations: { readOnlyHint: true },
    run: async (_a, { service }) => service.capabilitiesFor(),
  },
  {
    name: 'get_me',
    title: 'Get the calling API key',
    description:
      'Returns the API key this call uses: id, name, scopes (read, write, render, admin), expiry, limits and its render usage today and this month. Never the secret. Use it to see what this key may do before calling a tool that needs another scope.',
    scope: 'read',
    input: {},
    annotations: { readOnlyHint: true },
    run: async (_a, { service, auth }) => service.getMe(auth),
  },
  {
    name: 'get_project_schema',
    title: 'Get the project manifest JSON Schema',
    description:
      'Returns the JSON Schema of the project manifest (current schemaVersion). Use it to write valid manifests. Cross-field rules (template props, durations, asset references) are checked by validate_project.',
    scope: 'read',
    input: {},
    annotations: { readOnlyHint: true },
    run: async (_a, { service }) => service.projectSchema(),
  },
  {
    name: 'list_templates',
    title: 'List scene templates',
    description:
      'Lists scene templates with their engine, description, supported duration range in seconds, the theme tokens they read, and the JSON Schema of their props. A scene uses { engine, template, props }. The html engine also accepts raw { html, css } instead of a template.',
    scope: 'read',
    input: { engine: z.string().optional().describe('Only templates of this engine, e.g. "remotion".') },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => ({ templates: service.listTemplates(a.engine) }),
  },
  {
    name: 'get_skill',
    title: 'Read a craft skill',
    description:
      'Rules for one step of making a video, with numbers, so the result follows professional craft, published standards and the physical world instead of generic defaults. Built in: video-brief (what to ask before assuming), script-timing (words and reading time in frames), layout-and-type (safe areas for every aspect ratio, type size, contrast), motion-design (easing, durations, springs), camera-language (shot sizes, moves, cuts), physical-plausibility (gravity, weight, walking, blinking, artefacts in generated footage), sound-and-mix (loudness, ducking, sound-effect timing), voice-over (pace, pronunciation, consent), captions-and-accessibility (caption limits, flashing), av-sync (tolerances, frame arithmetic, lip sync), brand-consistency and review-and-qa. The operator may add more (skills.dir). Without name: the list. With name: the skill as Markdown. Also the resources renderweld://skills/<name>.',
    scope: 'read',
    input: { name: z.string().max(64).optional().describe('Skill name, e.g. "layout-and-type". Omit to list the skills.') },
    annotations: { readOnlyHint: true },
    run: async (a, { config }) => {
      const skills = skillsFor(config.skillsDir);
      if (!a.name) return { skills: skills.map((s) => ({ ...skillSummary(s), uri: resourceUri(`skills/${s.name}`) })) };
      const s = findSkill(skills, a.name);
      if (!s) throw new ApiError('not_found', 404, `no skill "${a.name}"; skills: ${skillNames(skills)}`);
      return { ...skillSummary(s), markdown: skillMarkdown(s) };
    },
  },
  {
    name: 'list_themes',
    title: 'List themes',
    description: 'Lists brand themes (built-in "default" and "midnight" plus custom ones) with their tokens: colours, font family, heading weight, motion speed, caption style.',
    scope: 'read',
    input: {},
    annotations: { readOnlyHint: true },
    run: async (_a, { service }) => ({ themes: await service.listThemes() }),
  },
  {
    name: 'create_theme',
    title: 'Create a theme',
    description:
      'Creates a reusable brand theme. tokens needs colors {background, surface, text, mutedText, accent, accent2} as #rrggbb and fontFamily (a CSS font-family list); optional headingWeight (100-900), radius, spacing, motionSpeed (0.25-4), captionStyle. Apply it with set_theme.',
    scope: 'write',
    input: {
      id: z.string().describe('Lowercase id, e.g. "acme".'),
      name: z.string(),
      description: z.string().optional(),
      tokens: z.record(z.string(), z.unknown()),
      idempotencyKey,
    },
    run: async ({ idempotencyKey: key, ...a }, { service }) => service.idempotent(key, 'create_theme', a, () => service.createTheme(a)),
  },
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'Lists projects on this server with title, version, scene count and duration (no manifests; get_project has the manifest).' + PAGING,
    scope: 'read',
    input: { ...pageArgs },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => service.listProjects({ limit: a.limit, cursor: a.cursor }),
  },
  {
    name: 'create_project',
    title: 'Create a project',
    description:
      'Creates a project from a manifest. Minimal manifest: { schemaVersion: "0.2", projectId, title, output: { width: 1080, height: 1920, fps: 30, format: "mp4" }, scenes: [{ id, engine, template, durationSeconds, props }] }. output can be any even size from 16 to 4096 px, e.g. 1920x1080 (16:9), 1080x1080 (1:1), 1080x1350 (4:5), 1080x1920 (9:16, the usual default) or 3840x2160 (4K); built-in templates lay themselves out for the aspect ratio and keep text inside the safe area. Optional: brief (brief.platform sets the safe area for app overlays), theme, audio, assets (scenes use them by id: template props media and logo, or asset:<id> in html), captions. The manifest is validated against installed engines and templates; on failure you get every problem with its path. v0.1 manifests are migrated automatically.',
    scope: 'write',
    input: { manifest: manifestObj, idempotencyKey },
    run: async (a, { service }) => {
      const r = await service.idempotent(a.idempotencyKey, 'create_project', { manifest: a.manifest }, () => service.createProject(a.manifest));
      return { ...r, timing: timing(r.manifest) };
    },
  },
  {
    name: 'get_project',
    title: 'Get a project',
    description: 'Returns the current manifest, its version number and the computed timing of every scene (start frame, duration in frames and seconds). Pass version to read an older saved version.',
    scope: 'read',
    input: { projectId, version: z.number().int().positive().optional() },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => {
      if (a.version) return { version: a.version, manifest: await service.projects.getVersion(a.projectId, a.version) };
      const r = await service.getProject(a.projectId);
      return { ...r, timing: timing(r.manifest) };
    },
  },
  {
    name: 'update_project',
    title: 'Update a project',
    description:
      'Changes a project. Give either patch (a JSON merge patch, RFC 7396: objects merge, null deletes a key, arrays replace) or manifest (a full replacement). Because null deletes, a patch cannot set a field to null: for caption style use "none" (captions.style.background "none" = no box, outline "none" = no outline); for other nullable fields send the full manifest. For single scenes prefer add_scene / update_scene. Every update is validated and saved as a new version.',
    scope: 'write',
    input: {
      projectId,
      patch: z.record(z.string(), z.unknown()).optional().describe('JSON merge patch, e.g. { "title": "New title", "brief": { "goal": "..." } }.'),
      manifest: manifestObj.optional(),
      expectedVersion,
    },
    run: async (a, { service }) => {
      if (!a.patch === !a.manifest) throw new ApiError('bad_request', 400, 'give exactly one of patch or manifest');
      const r = await service.updateProject(a.projectId, a.manifest ?? a.patch, a.expectedVersion);
      return { ...r, timing: timing(r.manifest) };
    },
  },
  {
    name: 'validate_project',
    title: 'Validate a project',
    description:
      'Full validation report: errors (block rendering) and warnings (e.g. missing licence, rounding of durationSeconds, caption quality rules), plus a summary (scenes, total frames, duration, size, engines). Checks schema, template props and durations, theme, assets on disk, render backend and engine availability on this machine.',
    scope: 'read',
    input: { projectId },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => service.validateProject(a.projectId),
  },
  {
    name: 'add_scene',
    title: 'Add a scene',
    description:
      'Adds a scene at index (default: the end). Scene: { id, engine, template, props, durationSeconds | durationFrames } or for the html engine { id, engine: "html", html, css, durationSeconds }. Scenes play back to back with hard cuts; timing is exact to the frame.',
    scope: 'write',
    input: {
      projectId,
      scene: z.record(z.string(), z.unknown()).describe('The scene object.'),
      index: z.number().int().min(0).optional().describe('Position (0 = first).'),
      expectedVersion,
      idempotencyKey,
    },
    run: async (a, { service }) => {
      const req = { projectId: a.projectId, scene: a.scene, index: a.index, expectedVersion: a.expectedVersion };
      const r = await service.idempotent(a.idempotencyKey, 'add_scene', req, () => service.addScene(a.projectId, a.scene, { index: a.index, expectedVersion: a.expectedVersion }));
      return { ...r, timing: timing(r.manifest) };
    },
  },
  {
    name: 'update_scene',
    title: 'Update a scene',
    description:
      'Changes one scene with a JSON merge patch, e.g. { "props": { "headline": "New" } } or { "durationSeconds": 4 }. Setting durationSeconds replaces durationFrames (and vice versa); setting template replaces html/css.',
    scope: 'write',
    input: { projectId, sceneId: z.string(), patch: z.record(z.string(), z.unknown()), expectedVersion },
    run: async (a, { service }) => {
      const r = await service.updateScene(a.projectId, a.sceneId, a.patch, a.expectedVersion);
      return { ...r, timing: timing(r.manifest) };
    },
  },
  {
    name: 'remove_scene',
    title: 'Remove a scene',
    description: 'Removes one scene (a project keeps at least one). Earlier versions stay readable with get_project { version }.',
    scope: 'write',
    input: { projectId, sceneId: z.string(), expectedVersion },
    annotations: { destructiveHint: true },
    run: async (a, { service }) => {
      const r = await service.removeScene(a.projectId, a.sceneId, a.expectedVersion);
      return { ...r, timing: timing(r.manifest) };
    },
  },
  {
    name: 'reorder_scenes',
    title: 'Reorder scenes',
    description: 'Sets the scene order. order must list every scene id exactly once.',
    scope: 'write',
    input: { projectId, order: z.array(z.string()), expectedVersion },
    annotations: { idempotentHint: true },
    run: async (a, { service }) => {
      const r = await service.reorderScenes(a.projectId, a.order, a.expectedVersion);
      return { ...r, timing: timing(r.manifest) };
    },
  },
  {
    name: 'set_theme',
    title: 'Set the project theme',
    description:
      'Sets the theme: a theme id (see list_themes) or inline tokens on top of a base theme, e.g. { "base": "midnight", "tokens": { "colors": { "accent": "#ff8800" } } }. Scene props such as accent/background still override per scene.',
    scope: 'write',
    input: {
      projectId,
      theme: z.union([z.string(), z.object({ base: z.string().optional(), tokens: z.record(z.string(), z.unknown()) })]),
      expectedVersion,
    },
    annotations: { idempotentHint: true },
    run: async (a, { service }) => service.setTheme(a.projectId, a.theme, a.expectedVersion),
  },
  {
    name: 'set_audio',
    title: 'Set music, voice and sound effects',
    description:
      'Merges into the project audio: { music: { asset, volume 0..1, fadeOutSeconds }, voice: { asset, volume, startFrame }, sfx: [{ asset, atFrame, volume }] }. Assets are project asset ids (add them with add_asset_from_url or generate_voice). Use null to remove music or voice. Every render has an AAC track (silence if no audio).',
    scope: 'write',
    input: { projectId, audio: z.record(z.string(), z.unknown()), expectedVersion },
    run: async (a, { service }) => service.setAudio(a.projectId, a.audio, a.expectedVersion),
  },
  {
    name: 'import_captions',
    title: 'Import captions (SRT or WebVTT)',
    description:
      'Parses an SRT or WebVTT file (content as text; format detected from the WEBVTT header unless given) into caption cues and stores them as the project\'s captions.cues, replacing any. Optionally sets captions.mode (off, burned, sidecar, both) and language. Cues are checked against the caption quality rules by validate_project (42 characters per line, 2 lines, 20 characters per second, 0.833-7 s, 2-frame gaps).',
    scope: 'write',
    input: {
      projectId,
      content: z.string().min(1).max(1_000_000).describe('The SRT or WebVTT file as text.'),
      format: z.enum(['srt', 'vtt']).optional(),
      mode: z.enum(['off', 'burned', 'sidecar', 'both']).optional(),
      language: languageTag.optional().describe('BCP 47 language tag, e.g. "en".'),
      expectedVersion,
    },
    run: async (a, { service }) => service.importCaptions(a.projectId, { content: a.content, format: a.format, mode: a.mode, language: a.language }, a.expectedVersion),
  },
  {
    name: 'get_captions',
    title: 'Get captions for review',
    description:
      'Returns the captions of a project (projectId) or of a finished render (renderId): for every language (BCP 47; the primary one first) the caption cues ({ start, end, text } in seconds, with word timings when known), the audio-description cues, which language is burned in, and the quality check (qa: characters per line, lines, reading speed, durations, gaps). For a project also the effective mode (and whether it comes from the project, the server default or nowhere), an etag and whether the user approved these captions. Before the final render, show the user the cue texts and times (and any qa issues) and ask whether to approve or change them; do not assume approval.',
    scope: 'read',
    input: {
      projectId: projectId.optional(),
      renderId: z.string().optional().describe('A render id: the captions as they were rendered.'),
      language: languageTag.optional().describe('Only this language.'),
    },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => service.getCaptions({ projectId: a.projectId, renderId: a.renderId, language: a.language }),
  },
  {
    name: 'update_captions',
    title: 'Edit or approve captions',
    description:
      'Edits the captions of a project with an optimistic-concurrency check: pass the etag from get_captions (refused with captions_conflict if anything changed since; read again and show the user the new state). Either replace every cue of one language (cues; a new language tag adds a language, [] removes it) or change some by their get_captions index (edits: { index, text?, start?, end?, delete? }, kind "description" for audio-description cues). Cues built from the voice are saved as manual cues when edited. Also sets mode (off, burned, sidecar, both), burnLanguage (the one language burned in) and highlight. approve: true records that the user approved the captions as they are after this call (only when the user said so); any later change voids it. Returns the same view as get_captions with the quality check re-run. Audit-logged.',
    scope: 'write',
    input: {
      projectId,
      etag: z.string().min(1).max(100).describe('etag from get_captions.'),
      language: languageTag.optional().describe('Language to edit; default the primary language.'),
      cues: z.array(captionCue).max(2000).optional().describe('All cues of this language: { start, end, text, kind? ("description" for audio description) }.'),
      edits: z
        .array(
          z
            .object({
              index: z.number().int().min(0).max(1999),
              kind: z.enum(CUE_KINDS).optional(),
              text: z.string().min(1).max(500).optional(),
              start: z.number().min(0).optional(),
              end: z.number().min(0).optional(),
              delete: z.literal(true).optional(),
            })
            .strict()
        )
        .max(500)
        .optional(),
      mode: z.enum(['off', 'burned', 'sidecar', 'both']).optional(),
      burnLanguage: languageTag.nullable().optional().describe('The language burned into the video; null: the primary language.'),
      highlight: z.enum(['none', 'word']).optional(),
      approve: z.boolean().optional().describe('true only after the user approved these captions; false withdraws an approval.'),
      expectedVersion,
    },
    run: async (a, { service }) => {
      const { projectId: id, expectedVersion: ev, ...rest } = a;
      return service.updateCaptions(id, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), ev);
    },
  },
  {
    name: 'transcribe_captions',
    title: 'Transcribe the voice-over (speech-to-text)',
    description:
      'Runs the server\'s local speech-to-text (faster-whisper, when installed: get_capabilities captions.stt.available) on the project\'s voice track and stores the word timings on it; caption cues are then built from them (like generate_voice timestamps). No network and no cost, but it takes CPU time (seconds to minutes) and one runs at a time (stt_busy: retry later). Upload the voice-over first (upload_asset with projectId, then set_audio { voice: { asset } }). language: "auto" (default from the server) or the spoken language. Manual caption cues take precedence: replaceCues: true removes them. Then get_captions and ask the user to review.',
    scope: 'render',
    input: {
      projectId,
      language: z.string().min(2).max(35).optional().describe('"auto" or a BCP 47 tag such as "en" or "pt-BR".'),
      provider: z.string().optional().describe('Speech-to-text provider id; default from the server (captions.stt.provider).'),
      replaceCues: z.boolean().optional(),
      expectedVersion,
    },
    run: async (a, { service }) => {
      const { projectId: id, expectedVersion: ev, ...rest } = a;
      return service.transcribeCaptions(id, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), ev);
    },
  },
  {
    name: 'generate_voice',
    title: 'Generate a voice-over (TTS provider)',
    description:
      'Creates a voice-over audio asset with a configured TTS provider (e.g. "elevenlabs") and returns word timestamps. This can cost the operator money: the first call without acknowledgeCost returns the cost note; ask the user, then call again with acknowledgeCost: true. Identical requests are served from cache for free. With projectId, the audio is added as asset "voice" and set as the project voice track.',
    scope: 'render',
    input: {
      provider: z.string().default('elevenlabs'),
      text: z.string().min(1).max(5000),
      voiceId: z.string().describe('Provider voice id.'),
      modelId: z.string().optional(),
      projectId: projectId.optional(),
      acknowledgeCost: z.boolean().optional(),
      idempotencyKey,
    },
    annotations: { openWorldHint: true },
    run: async (a, { service }) => {
      const providerId = a.provider ?? 'elevenlabs';
      const params = { text: a.text, voiceId: a.voiceId, ...(a.modelId ? { modelId: a.modelId } : {}) };
      const opts = { projectId: a.projectId, acknowledgeCost: a.acknowledgeCost === true };
      return service.idempotent(a.idempotencyKey, 'run_provider', { providerId, params, ...opts }, () => service.runProvider(providerId, params, opts));
    },
  },
  {
    name: 'add_asset_from_url',
    title: 'Import an asset from a URL',
    description:
      'Downloads an image, audio, video or font from a public https URL into the server asset store (size-limited, private networks refused, type checked from the bytes) and, with projectId, adds it to the project as assetId. Only use files you have the rights to; pass license metadata.' +
      ' Use it in scenes by its manifest id: template props media: { asset, fit: cover|contain|blur-fill, start (video in-point, s), dim } and logo: { asset, corner, size }, or asset:<id> in html scenes (<img src="asset:logo">, <video src="asset:clip">, url(asset:hero)). Video is frame-accurate at any frame rate; SVG is stored sanitised (no scripts, handlers or remote references). A font is used by naming its family (metadata.font.family) in the theme fontFamily; Inter, Source Serif 4 and JetBrains Mono are bundled. With projectId the asset belongs to that project; without, every project of the workspace may use it.',
    scope: 'write',
    input: { url: z.string().url(), projectId: projectId.optional(), assetId: z.string().optional().describe('Id to use in the manifest, e.g. "music".'), license: licenseObj, idempotencyKey },
    annotations: { openWorldHint: true },
    run: async (a, { service }) => {
      const opts = { projectId: a.projectId, assetId: a.assetId, license: a.license };
      return service.idempotent(a.idempotencyKey, 'add_asset_from_url', { url: a.url, ...opts }, () => service.addAssetFromUrl(a.url, opts));
    },
  },
  {
    name: 'list_assets',
    title: 'List assets',
    description:
      'Lists assets: with projectId, all of that project\'s manifest entries (one page, nextCursor null); otherwise the server asset store.' + PAGING,
    scope: 'read',
    input: { projectId: projectId.optional(), ...pageArgs },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => service.listAssets({ projectId: a.projectId }, { limit: a.limit, cursor: a.cursor }),
  },
  {
    name: 'preview_scene',
    title: 'Render a quick preview',
    description:
      'Starts a low-resolution preview render (default 1/3 size) of one scene, or of the whole project when sceneId is omitted; with variant, at that output variant\'s size and platform (the layout reflowed for it). Previews are queued at priority "interactive" (ahead of renders) by default. Returns a job; call get_job with waitSeconds: 45 until it finishes, then get_render_output (includes a poster image).' +
      QUEUE_REFUSALS,
    scope: 'render',
    input: {
      projectId,
      sceneId: z.string().optional(),
      scale: z.number().gt(0).max(1).optional(),
      variant: z.string().optional().describe('Preview at this output variant (an id from the manifest\'s variants). Omit for output.'),
      priority: priorityArg('preview', 'interactive'),
      idempotencyKey,
    },
    run: async (a, { service }) => {
      const opts = { sceneId: a.sceneId, scale: a.scale, ...(a.variant ? { variant: a.variant } : {}), ...(a.priority ? { priority: a.priority } : {}) };
      return service.idempotent(a.idempotencyKey, 'preview_scene', { projectId: a.projectId, ...opts }, async () => ({ job: await service.preview(a.projectId, opts) }));
    },
  },
  {
    name: 'plan_render',
    title: 'Plan a render (estimate before rendering)',
    description:
      'Before render_project: what the same call would render (each output with its size, frames, length and format; every variant when the project has variants and no variant is given), whether the project validates, and for each output an estimated render time and file size measured from this workspace\'s newest successful renders (basis "measured"; "partial" when an engine has no sample yet; "none" with no sample: then render or preview once). Also the queue it would join (jobs queued, measured claim rate, estimated wait) and the backend\'s cost note. Nothing is queued and nothing is charged. Show the user the estimate before an expensive render.',
    scope: 'read',
    input: { projectId: z.string(), variant: z.string().optional().describe('One of the project\'s variants; leave out for what render_project would render.') },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => service.planRender(a.projectId, { variant: a.variant }),
  },
  {
    name: 'render_project',
    title: 'Render the project',
    description:
      'Validates the project and starts the final render (every scene with its engine, assembled with audio, checked with ffprobe and a full decode). Returns a job immediately; renders take seconds to minutes. Renders are queued at priority "standard" by default. Then call get_job with waitSeconds: 45 (repeat while it is still running) until status is succeeded or failed, then call get_render_output. ' +
      'Several formats from one project: give the manifest variants, e.g. [{ id: "vertical", width: 1080, height: 1920 }, { id: "wide", width: 1920, height: 1080 }, { id: "square", width: 1080, height: 1080 }]; this call then starts one render per variant (each its own job and render id, the templates laid out again for each size) and answers { job, jobs, batchId }: wait for every job in jobs. Pass variant to render only one of them.' +
      QUEUE_REFUSALS,
    scope: 'render',
    input: {
      projectId,
      backend: z.string().optional().describe('Render backend id; default from the manifest ("local").'),
      variant: z.string().optional().describe('Render only this output variant (an id from the manifest\'s variants). Omit to render every variant, or output when the manifest has none.'),
      priority: priorityArg('render', 'standard'),
      captions: z
        .enum(['off', 'burned', 'sidecar', 'both'])
        .optional()
        .describe('Captions for this render, overriding the manifest\'s captions.mode (and the server default captions.defaultMode): off, burned into the video, sidecar files (SRT, WebVTT, ASS per language) next to final.mp4, or both.'),
      audio: renderAudioOptions
        .optional()
        .describe(
          'Audio for this render, overriding the manifest: mute (silence everything), voice / music / sfx (false leaves that track out), loudness (social -14 LUFS, broadcast-ebu -23, broadcast-atsc -24, podcast -16, off). E.g. { music: false } for a voice-only cut, { mute: true } for a silent autoplay version.'
        ),
      idempotencyKey,
    },
    run: async (a, { service }) => {
      const opts = { backend: a.backend, ...(a.variant ? { variant: a.variant } : {}), ...(a.priority ? { priority: a.priority } : {}), ...(a.captions ? { captions: a.captions } : {}), ...(a.audio ? { audio: a.audio } : {}) };
      return service.idempotent(a.idempotencyKey, 'render_project', { projectId: a.projectId, ...opts }, () => service.renderProject(a.projectId, opts));
    },
  },
  {
    name: 'get_job',
    title: 'Get job status',
    description:
      'Status of a render/preview job: queued, running (with progress stage and fraction), succeeded (result has renderId and output URLs), failed (error with code and stage) or cancelled. Renders take from seconds to several minutes: pass waitSeconds (up to 50) to wait for the job to finish instead of calling this repeatedly; it returns early as soon as the job finishes, otherwise the current progress.',
    scope: 'read',
    input: {
      jobId: z.string(),
      waitSeconds: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe('Wait up to this many seconds for the job to finish (0 = answer at once). Use 45 while a render runs.'),
    },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => service.waitForJob(a.jobId, a.waitSeconds ?? 0),
  },
  {
    name: 'cancel_job',
    title: 'Cancel a job',
    description: 'Cancels a queued or running job. A cancelled render leaves no partial output and never touches earlier renders.',
    scope: 'render',
    input: { jobId: z.string() },
    annotations: { destructiveHint: true, idempotentHint: true },
    run: async (a, { service }) => service.cancelJob(a.jobId),
  },
  {
    name: 'get_job_logs',
    title: 'Get job logs',
    description: 'Log lines of a job (use when a job failed to see the failing stage and tool output).',
    scope: 'read',
    input: { jobId: z.string(), tail: z.number().int().positive().optional().describe('Only the last N lines.') },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => ({ lines: await service.jobLogs(a.jobId, a.tail) }),
  },
  {
    name: 'get_render_output',
    title: 'Get a render output',
    description:
      'Returns the output of a finished render: format, codec, alpha, file and contentType (final.mp4 by default; final.mov, final.webm, final.gif, frames.zip, final.m4a or final.wav for other output.format values), downloadUrl (a signed link to that file that works WITHOUT a key until downloadUrlExpiresAt, about 1 hour; give this to the user or to curl), outputUrl (same file, needs Authorization: Bearer), poster (not for audio-only) and render-manifest URLs, size, fps, frame count, duration, checks and tool versions. checks.freeze, checks.black and checks.flash are "warn" when the picture froze, went black or flashes more than three times a second (a seizure risk); checks.motion is "warn" when it barely moves for seconds, checks.loop when a project with output.loop jumps where it repeats, and checks.seek when a frame rendered on its own differs from the video (the scene depends on earlier frames); videoQa.issues names the times and scenes: fix those scenes. Give renderId, or jobId of a succeeded job. includePoster (default true) attaches a small PNG so you can look at it: the first frame of an MP4, the middle frame of other formats (transparent where the render keeps alpha). contactSheet (absent for audio-only output or when render.contactSheet.select is off) is the labelled sheet stored with every render and preview: every scene and both sides of every cut, with the frame of each tile and a signed downloadUrl; includeContactSheet: true attaches it as an image, so you can look at the whole video in one call. For other frames, call get_frames.',
    scope: 'read',
    input: { renderId: z.string().optional(), jobId: z.string().optional(), includePoster: z.boolean().optional(), includeContactSheet: z.boolean().optional() },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => {
      let renderId = a.renderId as string | undefined;
      if (!renderId && a.jobId) {
        const job = await service.getJob(a.jobId);
        if (job.status !== 'succeeded') throw new ApiError('job_not_finished', 409, `job ${a.jobId} is ${job.status}; call get_job with waitSeconds: 45 until it succeeds`, { error: job.error });
        renderId = job.result?.renderId as string;
      }
      if (!renderId) throw new ApiError('bad_request', 400, 'give renderId or jobId');
      const summary = await service.getRender(renderId);
      const manifest = (await service.getRenderManifest(renderId)) as { output: Record<string, unknown>; versions: unknown; checks: unknown };
      return { ...summary, output: manifest.output, checks: manifest.checks, versions: manifest.versions };
    },
    extra: async (result, args, { service }) => {
      const images = [];
      if (args.includePoster !== false && result.posterUrl) {
        const { path } = await service.renderFile(result.renderId, 'poster.png');
        images.push({ type: 'image' as const, data: (await readFile(path)).toString('base64'), mimeType: 'image/png' });
      }
      if (args.includeContactSheet === true && result.contactSheet) {
        const { path } = await service.renderFile(result.renderId, result.contactSheet.file);
        images.push({ type: 'image' as const, data: (await readFile(path)).toString('base64'), mimeType: 'image/jpeg' });
      }
      return images;
    },
  },
  {
    name: 'get_frames',
    title: 'Look at frames of a render',
    description:
      'Stills of exact frames of a finished render or preview, so you can SEE what you made before calling it done: one labelled contact sheet (default) or one image per frame, taken from the stored file (no re-render). ' +
      'Default selection ("auto"): the first frame, the middle of every scene, both frames of every cut (last frame of a scene, first of the next) and the last frame, at most 24. ' +
      'Or at: times in seconds, { frame } indices or { sceneId, position: start|mid|end }; or everySeconds. Each tile is labelled scene · position · frame · time, and the JSON lists the same. ' +
      'overlay "safe" tints what lies outside the safe area for the render\'s size and platform (text there is covered by the app or cut off). width is the tile width (default 360, the width of a phone; 120 to 720). ' +
      'Use it after preview_scene and before render_project, and on every final render: fix what you see, preview again. Give renderId, or jobId of a succeeded job.',
    scope: 'read',
    input: {
      renderId: z.string().max(64).optional(),
      jobId: z.string().max(191).optional(),
      at: z
        .array(
          z.union([
            z.number().min(0).describe('A time in seconds.'),
            z.object({ seconds: z.number().min(0) }),
            z.object({ frame: z.number().int().min(0) }),
            z.object({ sceneId: z.string().max(200), position: z.enum(['start', 'mid', 'end']).optional() }),
          ])
        )
        .min(1)
        .max(24)
        .optional()
        .describe('Frames to show instead of the automatic selection.'),
      everySeconds: z.number().min(0.25).optional().describe('One frame every N seconds from 0 (at most 24 frames).'),
      width: z.number().int().min(120).max(720).optional().describe('Tile width in pixels (default 360).'),
      layout: z.enum(['sheet', 'separate']).optional().describe('sheet (default): one image; separate: one image per frame.'),
      overlay: z.enum(['none', 'safe']).optional().describe('safe: tint what lies outside the safe area (default none). The video is never changed.'),
    },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => {
      const renderId = await renderIdOf(service, a.renderId, a.jobId);
      const { images, ...rest } = await service.getFrames(renderId, { at: a.at, everySeconds: a.everySeconds, width: a.width, layout: a.layout, overlay: a.overlay });
      const result = { ...rest, images: images.map(({ mimeType, bytes }) => ({ mimeType, bytes })) };
      framePaths.set(result, images.map((i) => i.path));
      return result;
    },
    extra: async (result) => {
      const out: CallToolResult['content'] = [];
      for (const path of framePaths.get(result) ?? []) out.push({ type: 'image', data: (await readFile(path)).toString('base64'), mimeType: 'image/jpeg' });
      return out;
    },
  },
  {
    name: 'list_renders',
    title: 'List renders of a project',
    description: 'Lists finished renders and previews of a project, newest first, with output URLs, size, fps, frames and duration.',
    scope: 'read',
    input: { projectId },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => ({ renders: await service.listRenders(a.projectId) }),
  },
  {
    name: 'delete_render',
    title: 'Delete a render',
    description:
      'Deletes one finished render or preview with all its files (video, poster, captions, scene clips, manifest) from storage. Its job stays in the history; get_render_output then answers not_found. Cannot be undone; confirm with the user first. To delete every render of a project, delete the project.',
    scope: 'write',
    input: { renderId: z.string().max(64).describe('The render id (run_... or prv_...).') },
    annotations: { destructiveHint: true },
    run: async (a, { service }) => service.deleteRender(a.renderId),
  },
  {
    name: 'list_jobs',
    title: 'List jobs',
    description:
      'Lists render and preview jobs, optionally only those of one project (projectId) and/or the units and the join of one fanned-out render (parentId: the render job\'s id; each unit renders one scene). To follow one job, call get_job with its id instead: a render\'s progress already covers its units.' +
      PAGING,
    scope: 'read',
    input: {
      projectId: projectId.optional(),
      parentId: z.string().max(191).optional().describe('Only the children of this job: the render_unit jobs and the render_join job of a fanned-out render (render.fanOut), given the render job\'s id.'),
      status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).optional().describe('Only jobs in this state, e.g. succeeded for finished renders.'),
      type: z.enum(['render', 'preview', 'render_unit', 'render_join']).optional().describe('Only jobs of this type.'),
      ...pageArgs,
    },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => service.listJobs({ projectId: a.projectId, parentId: a.parentId, status: a.status, type: a.type }, { limit: a.limit, cursor: a.cursor }),
  },
  {
    name: 'retry_job',
    title: 'Retry a failed or cancelled job',
    description: 'Starts a new job with the same parameters as a failed or cancelled one (same project version). Earlier outputs are never overwritten.',
    scope: 'render',
    input: { jobId: z.string(), idempotencyKey },
    run: async (a, { service }) => service.idempotent(a.idempotencyKey, 'retry_job', { jobId: a.jobId }, async () => ({ job: await service.retryJob(a.jobId) })),
  },
  {
    name: 'list_project_versions',
    title: 'List saved versions of a project',
    description: 'Every update saves a new version. Returns the version numbers; read one with get_project { version }.',
    scope: 'read',
    input: { projectId },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => ({ versions: await service.listProjectVersions(a.projectId) }),
  },
  {
    name: 'delete_project',
    title: 'Delete a project',
    description: 'Deletes a project with all its versions and renders, and cancels its queued and running renders and previews. Cannot be undone; confirm with the user first.',
    scope: 'write',
    input: { projectId },
    annotations: { destructiveHint: true },
    run: async (a, { service }) => {
      await service.deleteProject(a.projectId);
      return { deleted: a.projectId };
    },
  },
  {
    name: 'get_theme',
    title: 'Get a theme',
    description: 'Returns one theme (built-in or custom) with all its tokens: colours, font, weights, motion speed, caption style.',
    scope: 'read',
    input: { themeId: z.string() },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => service.getTheme(a.themeId),
  },
  {
    name: 'update_theme',
    title: 'Replace a custom theme',
    description: 'Replaces a custom theme (built-in themes cannot be changed). Same fields as create_theme.',
    scope: 'write',
    input: { themeId: z.string(), name: z.string(), description: z.string().optional(), tokens: z.record(z.string(), z.unknown()) },
    annotations: { idempotentHint: true },
    run: async (a, { service }) => service.putTheme(a.themeId, { name: a.name, description: a.description, tokens: a.tokens }),
  },
  {
    name: 'delete_theme',
    title: 'Delete a custom theme',
    description: 'Deletes a custom theme. Projects that use it fail validation until they pick another theme.',
    scope: 'write',
    input: { themeId: z.string() },
    annotations: { destructiveHint: true },
    run: async (a, { service }) => {
      await service.deleteTheme(a.themeId);
      return { deleted: a.themeId };
    },
  },
  {
    name: 'upload_asset',
    title: 'Upload an asset (base64)',
    description:
      'Uploads a small file you already have (image incl. SVG, audio, video, font) as base64, for example a logo or generated audio. The type is checked from the bytes. With projectId it is added to the project as assetId. MCP messages are limited to a few MB; for larger files use REST POST /v1/assets (multipart) or add_asset_from_url.' +
      ' Use it in scenes by its manifest id: template props media: { asset, fit: cover|contain|blur-fill, start (video in-point, s), dim } and logo: { asset, corner, size }, or asset:<id> in html scenes (<img src="asset:logo">, <video src="asset:clip">, url(asset:hero)). Video is frame-accurate at any frame rate; SVG is stored sanitised (no scripts, handlers or remote references). A font is used by naming its family (metadata.font.family) in the theme fontFamily; Inter, Source Serif 4 and JetBrains Mono are bundled. With projectId the asset belongs to that project; without, every project of the workspace may use it.',
    scope: 'write',
    input: {
      dataBase64: z.string().min(1).describe('File content, base64.'),
      filename: z.string().optional(),
      projectId: projectId.optional(),
      assetId: z.string().optional().describe('Id to use in the manifest, e.g. "logo".'),
      license: licenseObj,
    },
    run: async (a, { service }) =>
      service.uploadAsset(Buffer.from(a.dataBase64, 'base64'), { filename: a.filename, projectId: a.projectId, assetId: a.assetId, license: a.license }),
  },
  {
    name: 'get_asset',
    title: 'Get an asset',
    description: 'Metadata of an asset in the store: content type, media type, size, sha256, source, licence, provider metadata (e.g. TTS word timestamps).',
    scope: 'read',
    input: { assetId: z.string().describe('Store id, e.g. "ast-0123456789abcdef".') },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => service.getAsset(a.assetId),
  },
  {
    name: 'list_providers',
    title: 'List media providers',
    description:
      'Media providers (TTS, ...) installed on this server, whether each is configured for your workspace, where its settings come from (settingsFrom: "workspace" = your workspace\'s own account, "instance" = the operator\'s, "none"), whether a workspace may bring its own (perWorkspace), and their cost notes.',
    scope: 'read',
    input: {},
    annotations: { readOnlyHint: true },
    run: async (_a, { service }) => ({ providers: await service.listProviders() }),
  },
  {
    name: 'configure_provider',
    title: 'Configure a media provider (owner)',
    description:
      'Sets or clears a provider setting such as ELEVENLABS_API_KEY (see list_providers for each provider\'s setting names). Values are stored encrypted in the server database (needs REELFORGE_SECRET_KEY on the server) and never returned; list_providers then shows set: true and source "api". Use null to clear a value (the environment variable, if any, applies again). Needs the owner scope (instance-level, #304). Only do this with a key the user gave you for this purpose.',
    scope: 'owner',
    input: {
      providerId: z.string(),
      values: z.record(z.string(), z.string().nullable()).describe('Setting name -> value, or null to clear.'),
      workspaceId: z.string().optional().describe("Set this workspace's own settings instead of the instance's (#480): its provider calls then use its own account."),
    },
    run: async (a, { service, auth }) => service.configureProvider(a.providerId, a.values, { actorType: 'api_key', actorId: auth.keyId }, a.workspaceId),
  },
  {
    name: 'configure_workspace_provider',
    title: "Configure your workspace's own provider account",
    description:
      'Sets or clears your workspace\'s own setting for a provider, such as its ELEVENLABS_API_KEY (#480). Your workspace\'s provider calls then use that account (its bill, its voices, its data terms); no other workspace ever sees or uses it, and clearing it falls back to the instance\'s settings only when the operator shares them (providers.shareWithWorkspaces). Stored encrypted (needs REELFORGE_SECRET_KEY on the server), never returned; list_providers then shows settingsFrom "workspace". Only providers with perWorkspace: true accept it. Needs the admin scope of the workspace. Only do this with a key the user gave you for this purpose.',
    scope: 'admin',
    input: {
      providerId: z.string(),
      values: z.record(z.string(), z.string().nullable()).describe('Setting name -> value, or null to clear.'),
    },
    run: async (a, { service, auth }) => service.configureWorkspaceProvider(a.providerId, a.values, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'get_config',
    title: 'Get the server configuration (owner)',
    description:
      'Returns every server setting with its effective value and where it comes from: source "default", "file" (REELFORGE_CONFIG), "env" (origin names the variable) or "runtime" (set with update_config, stored in the database; wins over the others). scope "runtime" settings can be changed with update_config; scope "startup" ones only in the config file or environment, then a restart. Secrets are only "set" / "not set". Optional prefix filters keys, e.g. "limits". Needs the owner scope (instance-level, #304).',
    scope: 'owner',
    input: { prefix: z.string().optional().describe('Only keys under this group, e.g. "limits" or "providers.elevenlabs".') },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => service.getConfig({ prefix: a.prefix }),
  },
  {
    name: 'update_config',
    title: 'Change runtime settings (owner)',
    description:
      'Changes runtime settings at once and stores them in the database (they survive restarts and override the config file and environment). settings maps dotted keys from get_config to values, e.g. { "limits.rateLimitPerMinute": 120 }; null clears a runtime value (the file/env/default applies again). All or nothing: start-up-only keys (port, database URL, data directory, ...) are refused with where to set them. Secrets (provider keys, licence key) are stored encrypted and need REELFORGE_SECRET_KEY on the server. Every change is audit-logged. Needs the owner scope (instance-level, #304). Only change what the user asked for.',
    scope: 'owner',
    input: {
      settings: z.record(z.string(), z.unknown()).describe('Dotted setting key -> new value (JSON type of the setting), or null to clear the runtime value.'),
    },
    run: async (a, { service, auth }) => service.updateConfig(a.settings, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'run_provider',
    title: 'Run a media provider',
    description:
      'Runs any configured provider with its own parameters (see list_providers) and stores the result as an asset. May cost the operator money: without acknowledgeCost you get the cost note; ask the user first. For voice-overs generate_voice is simpler.',
    scope: 'render',
    input: {
      providerId: z.string(),
      params: z.record(z.string(), z.unknown()),
      projectId: projectId.optional(),
      assetId: z.string().optional(),
      attachAs: z.enum(['voice', 'none']).optional(),
      acknowledgeCost: z.boolean().optional(),
      idempotencyKey,
    },
    annotations: { openWorldHint: true },
    run: async (a, { service }) => {
      const opts = { projectId: a.projectId, acknowledgeCost: a.acknowledgeCost === true, attachAs: a.attachAs === 'none' ? ('none' as const) : undefined, assetId: a.assetId };
      return service.idempotent(a.idempotencyKey, 'run_provider', { providerId: a.providerId, params: a.params, ...opts }, () => service.runProvider(a.providerId, a.params, opts));
    },
  },
  {
    name: 'get_analytics_summary',
    title: 'Get render analytics',
    description:
      'Aggregates for a time range (default: the last 30 days by UTC day; at most 90 days, or 7 days with bucket "hour"): render and preview jobs per bucket by status (succeeded, failed, cancelled, unfinished), success and failure rates (failed / (succeeded + failed); cancelled jobs are left out), render time and queue wait (p50 and p95 in ms), scene render time per engine (p50, p95, from the manifests of the newest 200 successful renders), minutes rendered, storage used (measured at most every 5 minutes), the top error codes of failed jobs, and webhook deliveries per status and endpoint. scan.truncated says when the range had more jobs than one call reads (20 000); the figures then cover scan.coveredFrom to range.to. Needs the read scope.',
    scope: 'read',
    input: {
      from: z.string().max(40).optional().describe('Start: ISO 8601 time or a UTC date (YYYY-MM-DD). Aligned down to the bucket. Default: 29 days before today (UTC), or 24 hours before `to` with bucket "hour".'),
      to: z.string().max(40).optional().describe('End, exclusive: ISO 8601 time, or a UTC date (that whole day is included). Default: now.'),
      bucket: z.enum(['day', 'hour']).optional().describe('Bucket size of the series (default day).'),
    },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => service.analyticsSummary(a),
  },
  {
    name: 'get_licence',
    title: 'Get the licence status',
    description:
      'Returns the licence status of this server: status "valid" (full use), "grace" (the licence server is unreachable; renders keep working until graceUntil), "invalid" (renders and previews are refused; reason, message and fix say why and what to do), "unlicensed" (no key) or "checking". Also: renderAllowed, last check and last success, item, activations used/limit, the key masked (first group only). Reading, listing and downloading always work. If renders are refused, tell the user the message and fix; activating needs the admin scope.',
    scope: 'read',
    input: {},
    annotations: { readOnlyHint: true },
    run: async (_a, { service }) => service.getLicence(),
  },
  {
    name: 'activate_licence',
    title: 'Set and activate the licence key (owner)',
    description:
      'Stores the licence key (encrypted; needs REELFORGE_SECRET_KEY on the server) and activates it for this server with the licence server, then returns the status (see get_licence). Without key, the configured key is activated or checked again (e.g. after a network outage or deactivate_licence). Only the key and a random instance id are sent. Only do this with a key the user gave you. Needs the owner scope (instance-level, #304).',
    scope: 'owner',
    input: { key: z.string().optional().describe('The licence key from the RenderWeld purchase, e.g. "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2". Omit to re-check the configured key.') },
    annotations: { openWorldHint: true, idempotentHint: true },
    run: async (a, { service, auth }) => service.activateLicence(a.key, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'deactivate_licence',
    title: 'Give the licence activation back (owner)',
    description:
      'Frees this server\'s activation of the licence key at the licence server, so the key can be activated on another server. Afterwards renders and previews are refused here until activate_licence is called again. Only do this when the user asks (e.g. moving to a new server). Needs the owner scope (instance-level, #304).',
    scope: 'owner',
    input: {},
    annotations: { destructiveHint: true, openWorldHint: true },
    run: async (_a, { service, auth }) => service.deactivateLicence({ actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'get_storage',
    title: 'Get storage driver, usage and health (owner)',
    description:
      'Returns where asset and render files are stored: driver ("local", "s3", "azure", "gcs"), location (bucket/container, endpoint, prefix, credential source; never secrets), how download links are made (bucket-signed or through this server), health (can the store be reached), usage (assets, renders, unfinished uploads, local cache in objects and bytes), the retention policy (storage.retention.*, change it with update_config) and the last scheduled sweep. Needs the owner scope (instance-level, #304).',
    scope: 'owner',
    input: {},
    annotations: { readOnlyHint: true },
    run: async (_a, { service }) => service.getStorage(),
  },
  {
    name: 'run_storage_cleanup',
    title: 'Apply the storage retention policy now (owner)',
    description:
      'Deletes renders the retention policy no longer keeps (older than storage.retention.renderDays; the newest keepLastRendersPerProject of each project and renders of running jobs are always kept), unfinished uploads and stale staging directories older than tempHours, and local cached copies unused for cacheDays. Call with dryRun: true first and show the user what would be deleted; deleting renders cannot be undone. renderDays / keepLastRendersPerProject try another policy for this run only (to set the policy, use update_config). Returns every render removed with its size and reason. Audit-logged. Needs the owner scope (instance-level, #304).',
    scope: 'owner',
    input: {
      dryRun: z.boolean().optional().describe('true: only report what would be deleted. Default false.'),
      renderDays: z.number().int().min(0).max(36500).optional().describe('Override storage.retention.renderDays for this run (0 = no age limit).'),
      keepLastRendersPerProject: z.number().int().min(0).max(36500).optional().describe('Override storage.retention.keepLastRendersPerProject for this run.'),
    },
    annotations: { destructiveHint: true },
    run: async (a, { service, auth }) =>
      service.runStorageCleanup({ dryRun: a.dryRun, renderDays: a.renderDays, keepLastRendersPerProject: a.keepLastRendersPerProject }, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'list_keys',
    title: 'List API keys (admin)',
    description:
      'Lists API keys: id, name, scopes, prefix, status (active, expired, revoked), created, last used, expiry, limits, quotas, IP allowlist and, after a rotation, until when the old secret works. Never returns secrets. Needs the admin scope.',
    scope: 'admin',
    input: {},
    annotations: { readOnlyHint: true },
    run: async (_a, { service }) => ({ keys: await service.listKeys() }),
  },
  {
    name: 'get_key',
    title: 'Get an API key (admin)',
    description: 'One API key (as list_keys shows it) with its render usage today and this month (UTC). Never returns the secret. Needs the admin scope.',
    scope: 'admin',
    input: { keyId: z.string() },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => service.getKey(a.keyId),
  },
  {
    name: 'create_key',
    title: 'Create an API key (admin)',
    description:
      'Creates an API key in this key\'s workspace with the given scopes (read, write, render, admin; owner only from an owner key) and optional expiry, per-key rate limit, render quotas (per UTC day / month) and IP allowlist (CIDR). The key is returned once: give it to the user, never store it elsewhere. Needs the admin scope.',
    scope: 'admin',
    input: { name: z.string(), scopes: z.array(z.enum(['read', 'write', 'render', 'admin'])).min(1), ...keyLimits },
    run: async (a, { service, auth }) => ({
      ...(await service.createKey(a.name, a.scopes, keyOpts(a), { actorType: 'api_key', actorId: auth.keyId })),
      note: 'store this key now; it is not shown again',
    }),
  },
  {
    name: 'update_key',
    title: 'Change an API key (admin)',
    description: 'Changes a key\'s name, expiry, rate limit, render quotas or IP allowlist (null clears one). Scopes cannot change: create a new key. Needs the admin scope.',
    scope: 'admin',
    input: { keyId: z.string(), name: z.string().optional(), ...keyLimits },
    annotations: { idempotentHint: true },
    run: async (a, { service, auth }) =>
      service.updateKey(a.keyId, { ...keyOpts(a), ...(a.name !== undefined ? { name: a.name } : {}) }, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'rotate_key',
    title: 'Rotate an API key (admin)',
    description:
      'Gives a key a new secret (returned once) and keeps the old secret working for graceHours (default: the server setting keys.rotationGraceHours, 24 h), so clients can switch without downtime. Same id, name, scopes and limits. You may rotate the key you are using. Needs the admin scope.',
    scope: 'admin',
    input: { keyId: z.string(), graceHours: z.number().min(0).max(720).optional().describe('Hours the old secret keeps working (0: stops at once).') },
    run: async (a, { service, auth }) => ({
      ...(await service.rotateKey(a.keyId, { graceHours: a.graceHours }, { actorType: 'api_key', actorId: auth.keyId })),
      note: 'store the new key now; it is not shown again. The old one works until record.previousSecretExpiresAt',
    }),
  },
  {
    name: 'revoke_key',
    title: 'Revoke an API key (admin)',
    description:
      'Revokes a key: it (and any old secret still in its rotation grace window) stops working at once. The key stays listed with status "revoked" so the audit trail still names it. You cannot revoke the key you are using. Confirm with the user first. Needs the admin scope.',
    scope: 'admin',
    input: { keyId: z.string() },
    annotations: { destructiveHint: true, idempotentHint: true },
    run: async (a, { service, auth }) => service.revokeKey(a.keyId, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'delete_key',
    title: 'Delete an API key (admin)',
    description: 'Deletes an API key; it stops working immediately and disappears from list_keys (prefer revoke_key, which keeps it listed for the audit trail). You cannot delete the key you are using. Needs the admin scope.',
    scope: 'admin',
    input: { keyId: z.string() },
    annotations: { destructiveHint: true },
    run: async (a, { service, auth }) => {
      await service.deleteKey(a.keyId, { actorType: 'api_key', actorId: auth.keyId });
      return { deleted: a.keyId };
    },
  },
  {
    name: 'list_audit_events',
    title: 'Read the audit log (admin)',
    description:
      'The audit trail, newest first: who (API key id and name), action (e.g. "key.rotate", "project.create", "config.update"), target, result (success, failure, denied), client IP, user agent, request id and time (UTC), of this key\'s workspace (owner keys: any workspace with workspaceId). Never contains secret values. Filter by time (from/to), actorId, action ("key.*" for a prefix), targetType/targetId and result; page with cursor (nextCursor). format "jsonl" or "csv" returns an export (up to 10 000 entries; the REST route GET /v1/audit?format= streams up to 100 000). Needs the admin scope.',
    scope: 'admin',
    input: {
      ...auditFilter,
      limit: z.number().int().min(1).max(10_000).optional().describe('Page size (default 100, max 1000) or export size (max 10 000).'),
      cursor: z.string().optional().describe('nextCursor of the previous page.'),
      format: z.enum(['json', 'jsonl', 'csv']).optional().describe('json (default): a page of entries; jsonl / csv: an export as text.'),
      workspaceId: z.string().optional().describe('Owner keys only: another workspace\'s trail, or "*" for every workspace merged newest first (json pages; each entry then names its workspaceId).'),
    },
    annotations: { readOnlyHint: true },
    run: async ({ format, ...q }, { service }) => (format === 'jsonl' || format === 'csv' ? service.exportAuditEvents(q, format) : service.listAuditEvents(q)),
  },
  {
    name: 'get_workspace',
    title: 'Get this key\'s workspace',
    description:
      'The workspace this API key belongs to (#304): id, name, status, the limits in force (renders per day/month, requests per minute, storage bytes; absent: unlimited) and its usage today, this month and in storage. Every project, asset, theme, job, render, key, webhook and audit entry you can see is in this workspace only.',
    scope: 'read',
    input: {},
    annotations: { readOnlyHint: true },
    run: async (_a, { service }) => service.getWorkspace(),
  },
  {
    name: 'list_workspaces',
    title: 'List workspaces (owner)',
    description: 'Every workspace of this install with its status (active, suspended, deleted with purgeAfter), its own limits and the limits in force. Needs the owner scope (instance-level, #304).',
    scope: 'owner',
    input: {},
    annotations: { readOnlyHint: true },
    run: async (_a, { service }) => service.listWorkspaces(),
  },
  {
    name: 'create_workspace',
    title: 'Create a workspace (owner)',
    description:
      'Creates a workspace for a team or customer: its projects, assets, themes, jobs, renders, keys, webhooks and audit log are invisible to every other workspace. id: 1-40 lowercase letters, digits and hyphens. Optional limits (renders per day/month, requests per minute, storage bytes; default unlimited). adminKey: true (or { name, scopes }) also creates the workspace\'s first admin key and returns it ONCE: give it to the user. Needs the owner scope.',
    scope: 'owner',
    input: {
      id: z.string(),
      name: z.string().optional(),
      limits: z.record(z.string(), z.number().int().nullable()).optional().describe('rendersPerDay, rendersPerMonth, rateLimitPerMinute, storageBytes; 0 or null: unlimited.'),
      adminKey: z.union([z.boolean(), z.object({ name: z.string().optional(), scopes: z.array(z.enum(['read', 'write', 'render', 'admin'])).optional() })]).optional(),
    },
    annotations: { idempotentHint: false },
    run: async (a, { service, auth }) => service.createWorkspace(a, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'update_workspace',
    title: 'Rename, limit, suspend or resume a workspace (owner)',
    description:
      'Changes a workspace\'s name or limits (null clears them: the workspaces.* defaults apply), or suspends it (suspended: true: its keys are refused with workspace_suspended and its queued jobs wait; its data stays) and resumes it (false). The default workspace cannot be suspended. Confirm suspending with the user first. Needs the owner scope.',
    scope: 'owner',
    input: {
      workspaceId: z.string(),
      name: z.string().optional(),
      limits: z.record(z.string(), z.number().int().nullable()).nullable().optional(),
      suspended: z.boolean().optional(),
    },
    annotations: { idempotentHint: true },
    run: async ({ workspaceId, ...a }, { service, auth }) => service.updateWorkspace(workspaceId, a, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'delete_workspace',
    title: 'Delete a workspace (owner)',
    description:
      'Deletes a workspace: its keys stop working and its jobs are no longer run at once; its projects, renders, assets, keys, webhooks and audit log are purged for good after workspaces.deleteGraceDays (default 30; purgeAfter says when). restore_workspace undoes it until then. The default workspace cannot be deleted. Confirm with the user first. Needs the owner scope.',
    scope: 'owner',
    input: { workspaceId: z.string() },
    annotations: { destructiveHint: true },
    run: async (a, { service, auth }) => service.deleteWorkspace(a.workspaceId, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'restore_workspace',
    title: 'Restore a deleted workspace (owner)',
    description: 'Brings back a deleted workspace before its purge (see list_workspaces: purgeAfter): its keys work again and its jobs run. Needs the owner scope.',
    scope: 'owner',
    input: { workspaceId: z.string() },
    annotations: { idempotentHint: true },
    run: async (a, { service, auth }) => service.restoreWorkspace(a.workspaceId, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'list_webhooks',
    title: 'List webhooks and notification channels (admin)',
    description:
      'Lists outbound event endpoints: signed webhooks (Standard Webhooks), Slack, Discord and Microsoft Teams incoming webhooks, and email channels (SMTP, Resend, Postmark, Amazon SES, SendGrid), with the events each one receives, whether it is enabled, and whether its provider is configured. URLs are masked; signing secrets are never returned. Also lists every event type. Needs the admin scope.',
    scope: 'admin',
    input: {},
    annotations: { readOnlyHint: true },
    run: async (_a, { service }) => service.listWebhooks(),
  },
  {
    name: 'get_webhook',
    title: 'Get a webhook (admin)',
    description: 'One endpoint as list_webhooks shows it, with its delivery counts (pending, delivering, succeeded, dead). Needs the admin scope.',
    scope: 'admin',
    input: { webhookId: z.string() },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => service.getWebhook(a.webhookId),
  },
  {
    name: 'create_webhook',
    title: 'Create a webhook or notification channel (admin)',
    description:
      'Sends server events to an endpoint so automations (n8n, Zapier, Make, your backend) or people react without polling. type "webhook" (default): an HTTPS POST of {id, type, timestamp, data} signed per Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature "v1,<base64 HMAC-SHA256>"); the signing secret (whsec_...) is returned ONCE: give it to the user to verify signatures. type "slack" / "discord" / "teams": the channel\'s incoming webhook URL. type "email": email { provider: smtp|resend|postmark|ses|sendgrid, to: [addresses] } (the provider is set up with update_config, notifications.email.*). events: event types or patterns: job.queued, job.started, job.progress, job.succeeded, job.failed, job.cancelled, render.ready, render.failed, render.cancelled, render.timeout, render.qa_failed, render.blocked (one terminal render.* event per render job), licence.state_changed, key.created, key.revoked, config.changed, audit.entry, "job.*", "render.*", or "*" (all but job.progress and audit.entry). Deliveries are retried with exponential backoff for up to 24 h (10 s timeout per attempt), then marked dead. Private and http:// URLs are refused unless the operator allowed them at start-up. Needs the admin scope.',
    scope: 'admin',
    input: {
      name: z.string().describe('A label, e.g. "n8n render pipeline".'),
      type: z.enum(['webhook', 'slack', 'discord', 'teams', 'email']).optional().describe('Default "webhook".'),
      url: z.string().optional().describe('https:// URL (webhook, slack, discord, teams).'),
      email: z.object({ provider: z.enum(['smtp', 'resend', 'postmark', 'ses', 'sendgrid']).optional(), to: z.array(z.string()).min(1).max(20) }).optional().describe('Email channels only.'),
      events: z.array(z.string()).min(1).describe('Event types or patterns, e.g. ["render.ready", "job.failed"].'),
      description: z.string().optional(),
      enabled: z.boolean().optional().describe('Default true.'),
    },
    run: async (a, { service, auth }) => service.createWebhook(a, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'update_webhook',
    title: 'Change a webhook (admin)',
    description:
      'Changes an endpoint\'s name, description, url, email recipients, events or enabled flag (enabling clears a "disabled by the server" reason, e.g. after a 410 Gone). rotateSecret: true gives a webhook a new signing secret (returned once); for graceHours (default webhooks.secretRotationGraceHours, 24) every message carries signatures with the new and the old secret, so the receiver can switch without missing messages. Needs the admin scope.',
    scope: 'admin',
    input: {
      webhookId: z.string(),
      name: z.string().optional(),
      description: z.string().nullable().optional(),
      url: z.string().optional(),
      email: z.object({ provider: z.enum(['smtp', 'resend', 'postmark', 'ses', 'sendgrid']).optional(), to: z.array(z.string()).min(1).max(20) }).optional(),
      events: z.array(z.string()).min(1).optional(),
      enabled: z.boolean().optional(),
      rotateSecret: z.boolean().optional(),
      graceHours: z.number().min(0).max(720).optional().describe('With rotateSecret: hours the old secret keeps signing (0: stops at once).'),
    },
    run: async ({ webhookId, ...a }, { service, auth }) => service.updateWebhook(webhookId, a, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'delete_webhook',
    title: 'Delete a webhook (admin)',
    description: 'Deletes an endpoint; its pending deliveries are abandoned (kept in the delivery log as dead). Confirm with the user first. Needs the admin scope.',
    scope: 'admin',
    input: { webhookId: z.string() },
    annotations: { destructiveHint: true },
    run: async (a, { service, auth }) => service.deleteWebhook(a.webhookId, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'test_webhook',
    title: 'Send a test event (admin)',
    description:
      'Sends a "webhook.test" event to one endpoint through the normal outbox (signed, retried). With waitSeconds (up to 30) it waits for the first attempt and returns its outcome (HTTP status or error), so you can tell the user whether the receiver works. Needs the admin scope.',
    scope: 'admin',
    input: { webhookId: z.string(), waitSeconds: z.number().min(0).max(30).optional().describe('Wait for the first attempt (default 0: return at once).') },
    annotations: { openWorldHint: true },
    run: async (a, { service, auth }) => service.testWebhook(a.webhookId, { waitSeconds: a.waitSeconds }, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'list_webhook_deliveries',
    title: 'Read the delivery log (admin)',
    description:
      'Deliveries of one endpoint, newest first: event type, webhook-id (messageId), status (pending, delivering, succeeded, dead), attempts, next attempt, last HTTP status and error, and the attempt log (time, duration, status, outcome). Filter by status (e.g. "dead" for the dead letter queue) or eventType; page with cursor (nextCursor). includePayload: true adds the event payload. Needs the admin scope.',
    scope: 'admin',
    input: {
      webhookId: z.string(),
      status: z.enum(['pending', 'delivering', 'succeeded', 'dead']).optional(),
      eventType: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional().describe('Default 50.'),
      cursor: z.string().optional().describe('nextCursor of the previous page.'),
      includePayload: z.boolean().optional(),
      includeAttempts: z.boolean().optional().describe('Default true.'),
    },
    annotations: { readOnlyHint: true },
    run: async ({ webhookId, ...q }, { service }) => service.listWebhookDeliveries(webhookId, q),
  },
  {
    name: 'replay_webhook_delivery',
    title: 'Send a delivery again (admin)',
    description:
      'Sends a finished delivery (dead or succeeded) again: a new outbox entry with the same payload and the same webhook-id, so receivers that already processed it can ignore it. Use it after fixing a receiver that was down. Needs the admin scope.',
    scope: 'admin',
    input: { webhookId: z.string(), deliveryId: z.string() },
    annotations: { openWorldHint: true },
    run: async (a, { service, auth }) => service.replayWebhookDelivery(a.webhookId, a.deliveryId, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'resend_webhook',
    title: 'Send an event to a webhook again (admin)',
    description:
      'Sends one event to an endpoint again, named by exactly one of: deliveryId (from get_webhook_log), eventId, or dedupeKey ("render:<jobId>": the terminal outcome of a render job). A delivery still waiting for its next retry is sent now ("rescheduled"); a finished one (succeeded or dead) is queued again with the same payload and webhook-id ("queued", with a fresh 24 h retry window); an event the endpoint never got (found at another endpoint) is queued for it. Receivers deduplicate on webhook-id. Needs the admin scope.',
    scope: 'admin',
    input: {
      webhookId: z.string(),
      deliveryId: z.string().optional(),
      eventId: z.string().optional(),
      dedupeKey: z.string().optional().describe('e.g. "render:job_..." for the render.* outcome of that job.'),
    },
    annotations: { openWorldHint: true },
    run: async ({ webhookId, ...a }, { service, auth }) => service.resendWebhook(webhookId, a, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'rotate_webhook_secret',
    title: 'Rotate a webhook signing secret (admin)',
    description:
      'Gives a webhook a new signing secret (returned once; or bring your own with secret: "whsec_..."). For overlapHours (default webhooks.secretRotationGraceHours, 24) every message is signed with the new and the previous secret (two v1 signatures in webhook-signature), so the receiver accepts both while it switches. endOverlap: true stops signing with the previous secret at once. Needs the admin scope.',
    scope: 'admin',
    input: {
      webhookId: z.string(),
      overlapHours: z.number().min(0).max(720).optional().describe('Hours both secrets sign (0: only the new one at once).'),
      secret: z.string().optional().describe('Your own new secret: whsec_ + base64 of 24 to 64 bytes. Omit to get a generated one.'),
      endOverlap: z.boolean().optional().describe('End the current overlap now (the receiver has switched).'),
    },
    run: async ({ webhookId, ...a }, { service, auth }) => service.rotateWebhookSecret(webhookId, a, { actorType: 'api_key', actorId: auth.keyId }),
  },
  {
    name: 'get_webhook_log',
    title: 'Read a webhook delivery log',
    description:
      'The delivery log of one endpoint, newest first, without payloads or the target URL: per delivery its event type, webhook-id, dedupeKey, status (pending, delivering, succeeded, dead = failed for good), attempts, latency (latencyMs of the last attempt, durationMs of each), last HTTP status and error, and giveUpAt while it is retried; a summary (success rate, p50/p95 latency) and the retry policy. Filter by status or eventType; page with cursor. Needs the read scope.',
    scope: 'read',
    input: {
      webhookId: z.string(),
      status: z.enum(['pending', 'delivering', 'succeeded', 'dead']).optional(),
      eventType: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional().describe('Default 50.'),
      cursor: z.string().optional().describe('nextCursor of the previous page.'),
    },
    annotations: { readOnlyHint: true },
    run: async ({ webhookId, ...q }, { service }) => service.getWebhookLog(webhookId, q),
  },
];

/**
 * MCP resource URIs (#412): `renderweld://` is the scheme; the old
 * `reelforge://` answers every URI too until a removal date announced in the
 * release notes (docs/RENAMED.md). Tool and prompt names do not change.
 */
export const RESOURCE_SCHEME = 'renderweld';
export const RESOURCE_SCHEMES = ['renderweld', 'reelforge'] as const;
export const resourceUri = (path: string) => `${RESOURCE_SCHEME}://${path}`;

/** The resources, by path under either scheme. */
export const RESOURCES = [
  { name: 'workflow-guide', path: 'guide/workflow', title: 'How to make a reel with these tools', description: 'Step-by-step workflow, a minimal manifest and rules of thumb. Read this first if you have no other docs.', mimeType: 'text/markdown' },
  { name: 'project-schema', path: 'schema/project', title: 'Project manifest JSON Schema', description: 'JSON Schema of the current manifest version.', mimeType: 'application/json' },
  { name: 'templates', path: 'templates', title: 'Installed templates', description: 'Templates with engines, durations, theme tokens and props schemas.', mimeType: 'application/json' },
  { name: 'project', path: 'projects/{id}', title: 'Project manifest', description: 'The current manifest of a project.', mimeType: 'application/json' },
  { name: 'skills', path: 'skills', title: 'Skills', description: 'Index of the skills: rules for every step of making a video (brief, timing, layout and type, motion, camera, physical plausibility, sound, voice, captions and accessibility, sync, brand, review), plus any the operator added.', mimeType: 'text/markdown' },
  { name: 'skill', path: 'skills/{name}', title: 'Skill', description: 'One skill as Markdown: when to use it, numbered rules, how to apply them with these tools, signs of generic output, a checklist and sources.', mimeType: 'text/markdown' },
] as const;
export type ResourcePath = (typeof RESOURCES)[number]['path'];

/** Served as the resource renderweld://guide/workflow (and reelforge://guide/workflow) and inside the make_reel prompt. */
/**
 * The essentials of a video brief (#313): what the brief_intake prompt has an agent ask when the request leaves
 * them open, and where each answer goes. The studio asks; the user or agent decides.
 */
export const BRIEF_ESSENTIALS: ReadonlyArray<{ id: string; question: string; field: string }> = [
  { id: 'goal', question: 'What should a viewer do or remember after watching (the goal and call to action)?', field: 'brief.goal, and the closing scene' },
  { id: 'audience', question: 'Who is it for?', field: 'brief.audience' },
  { id: 'platform', question: 'Where will it be published, at what size and aspect ratio (any size works)? One video or several formats?', field: 'brief.platform, output.width/height, variants' },
  { id: 'length', question: 'How long should it be?', field: 'brief.targetSeconds and the scene durations' },
  { id: 'language', question: 'Which language?', field: 'brief.language' },
  { id: 'style', question: 'What tone and look (calm, energetic, playful, premium...)?', field: 'brief.style and the theme' },
  { id: 'brand', question: 'Which brand colours, fonts and logo, if any? Upload the files or name an existing theme.', field: 'theme (create_theme), assets (upload_asset)' },
  { id: 'captions', question: 'Captions: none, burned into the video, a separate subtitle file, or both?', field: 'captions' },
  { id: 'voice', question: 'A voice-over? If so, whose voice or which provider voice?', field: 'audio.voice (generate_voice, or an uploaded recording)' },
  { id: 'music', question: 'Background music or sound effects? Upload the track, or none.', field: 'audio.music, audio.sfx' },
  { id: 'content', question: 'Are there facts, numbers, product names or images that must appear exactly as given?', field: 'scene props and assets' },
];

export const WORKFLOW_GUIDE = `# RenderWeld: making a video with MCP tools only

You decide the scenes; the server validates, renders and checks. Everything is
done with tools; there is no UI.

## Steps
0. Complete the brief with the user before anything else: the brief_intake
   prompt (or get_skill video-brief) lists what to ask. Never assume the
   size, length, platform, tone, captions, voice or music; ask in one message
   with suggested defaults, and read the brief back for a yes.
1. get_capabilities: engines that can render here (available: true), templates,
   themes, providers (configured? cost?), limits (supportedFps, maxProjectSeconds, maxScenes),
   licence (renderAllowed; if false, get_licence has the message and fix for the user).
2. list_templates: props JSON Schema, duration range (seconds) and theme tokens
   of each template. list_themes: built-in "default", "midnight" and custom ones.
3. create_project with a manifest (minimal example below). Errors come back as
   { error: { code: "invalid_manifest", details: { issues: [{ path, message }] } } };
   fix every issue and call again.
4. Edit: add_scene / update_scene (JSON merge patch) / remove_scene /
   reorder_scenes. Timing per scene: durationSeconds (rounded to frames) or
   durationFrames. Scenes play back to back with hard cuts. Every edit returns
   "timing" (start frame and duration of every scene).
5. Look: set_theme ("midnight" or { base, tokens: { colors: { accent: "#ff8800" } } }),
   create_theme for a brand.
6. Sound (optional): add_asset_from_url or upload_asset (base64) with licence
   metadata, then set_audio { music: { asset, volume } }. generate_voice needs a
   configured TTS provider and acknowledgeCost: true after the user agreed.
7. Captions (optional; get_capabilities captions): timings come from generate_voice,
   from transcribe_captions (local speech-to-text of an uploaded voice-over, when
   captions.stt.available), from import_captions (SRT/WebVTT) or from cues you write.
   Turn them on with update_captions { mode: "burned" | "sidecar" | "both" }. More
   languages: update_captions { language: "es", cues: [...] }; one is burned
   (burnLanguage), each gets sidecar files. Audio description: cues with
   kind "description" (a WebVTT sidecar, never burned).
   Approval: before the final render call get_captions, show the user the cue
   texts and times and any qa issues, and ASK whether to approve or change them.
   Never assume approval. Apply changes with update_captions (etag from
   get_captions); when the user approves, update_captions { approve: true }.
8. validate_project until ok: true (warnings are fine but read them).
9. Look before the final render: preview_scene (low resolution), then
   get_frames { jobId } for a labelled contact sheet of every scene and both
   sides of every cut (overlay: "safe" shows where text is covered or cut off).
   Fix what you see (overflowing or tiny text, empty scenes, bad cuts) and
   preview again.
   Before a long or many-size render, plan_render shows each output with its
   estimated render time, file size and the queue wait; tell the user.
10. render_project -> get_job with waitSeconds 45 (repeat while running) until succeeded/failed ->
   get_render_output { includeContactSheet: true }: the sheet stored with
   every render shows each scene and cut of the final file (get_frames for
   other frames or overlay: "safe").
   Give the user downloadUrl (works without a key for ~1 h).
   Read checks: freeze, black or flash = "warn" means a scene froze, went
   black or flashes more than three times a second (a seizure risk); motion =
   "warn" means it barely moves; loop = "warn" means a video with output.loop
   jumps where it repeats; seek = "warn" means a frame depends on the ones
   before it. videoQa.issues names it, with the times. Fix it and render again.
   If it failed: get_job_logs, fix, render again (or retry_job).
   An error licence_required / licence_invalid is not a manifest problem: tell
   the user its message and fix (an admin activates with activate_licence).

## Minimal manifest
{
  "schemaVersion": "0.2",
  "projectId": "my-reel",
  "title": "My reel",
  "theme": "midnight",
  "output": { "width": 1080, "height": 1920, "fps": 30, "format": "mp4" },
  "scenes": [
    { "id": "hook", "engine": "remotion", "template": "kinetic-title", "durationSeconds": 3,
      "props": { "headline": "Make reels with agents", "subline": "Self-hosted" } },
    { "id": "steps", "engine": "motion-canvas", "template": "animated-explainer", "durationSeconds": 5,
      "props": { "title": "How it works", "points": ["Plan", "Render", "Post"] } },
    { "id": "card", "engine": "html", "html": "<h1 class='t'>Your own HTML</h1>",
      "css": ".t{color:var(--rf-accent);font-size:120px;margin:40%  8%;animation:in .6s both}@keyframes in{from{opacity:0}}",
      "durationSeconds": 2 }
  ]
}

## Skills
Rules for every step, with numbers (timing in frames, safe areas, motion
curves, camera moves, physics of moving things and people, loudness, voice,
caption limits, sync tolerances, review checks). get_skill without a name lists
them, with any the operator added; read the one for the step you are on with
get_skill { name } (or the resource renderweld://skills/<name>). Built in:
video-brief, script-timing, layout-and-type, motion-design, camera-language,
physical-plausibility, sound-and-mix, voice-over, captions-and-accessibility,
av-sync, brand-consistency, review-and-qa.

## Rules of thumb
- Open with a hook; about 3 words per second of on-screen text.
- Use only engines with available: true; never invent templates or props.
- html/hyperframes scenes have no network: inline everything (data: URLs);
  CSS animations and the Web Animations API are seeked frame by frame. Theme
  tokens are CSS variables: --rf-bg, --rf-text, --rf-muted, --rf-accent,
  --rf-accent2, --rf-font, --rf-unit (1% of the shorter side), --rf-safe-top/right/bottom/left
  (keep text inside these insets) and --rf-content-w/h.
- Any size works: pick output for where the video goes (1080x1920 for Reels,
  TikTok and Shorts; 1920x1080 for YouTube and the web; 1080x1080 or 1080x1350
  for feed posts; 3840x2160 for 4K). Built-in templates reflow for the aspect
  ratio; on tall frames they keep clear of the app's buttons and captions.
- Layouts (templates html-layout, hyperframes-layout, remotion-layout and
  motion-canvas-layout, all with the same props, so a scene can move between
  engines by changing only engine and template): split screen (2-4
  panes, side by side or stacked, ratios), picture-in-picture (corner, width
  and margin in units), grid (n x m, or chosen per frame) or full frame, each
  pane with an image or video asset placed with fit contain, cover or blur-fill
  (blurred fill for a mismatched aspect ratio), text, and an optional lower
  third. Upload the media as assets first; the layout reflows for every size
  and variant.
- Ask the user before anything that costs money (providers) or deletes data.
`;

const DELIVERY_CHECKLIST = [
  'Size and frame rate match where the video goes (1080x1920 for Reels/TikTok/Shorts, 1920x1080 for YouTube and the web, 1080x1080 or 1080x1350 for feed posts; default 1080x1920 at 30 fps).',
  'The first frame is not empty (platforms use it as a thumbnail).',
  'Every scene has a clear single message; on-screen text is short enough to read in its duration (about 3 words per second).',
  'Scene durations are within each template\'s range; the total matches brief.targetSeconds.',
  'Theme colours have enough contrast (text vs background).',
  'Music, voice and sound effects are assets with licence metadata; no warnings about missing licences remain.',
  'No placeholder text remains (lorem ipsum, TODO, example.com).',
  'validate_project returns no errors; warnings are understood.',
  'After rendering: get_render_output shows checks metadata/decode/duration = pass.',
  'get_frames on the preview or render: every scene and both sides of every cut look right at phone size; no text outside the safe area (overlay "safe"), cut off or too small.',
];

function buildServer(service: ReelforgeService, auth: AuthContext, config: ServerConfig): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: service.serverVersion },
    {
      instructions:
        `${PRODUCT_NAME} renders short videos at any size and aspect ratio (vertical 1080x1920 by default; 16:9, 1:1, 4:5, 4K and others on request) from a JSON manifest. You decide the scenes; the server validates, renders and checks. ` +
        'First complete the brief with the user (prompt brief_intake, or get_skill video-brief): never assume the size, length, platform, tone, captions, voice or music. ' +
        'Workflow: get_capabilities -> list_templates/list_themes -> create_project -> add_scene/update_scene/set_theme/set_audio -> validate_project -> plan_render (estimate) -> render_project -> get_job (poll) -> get_render_output (downloadUrl works without a key). ' +
        'With captions, call get_captions and ask the user to approve them (update_captions approve: true) before render_project; never assume approval. ' +
        `Full guide with a minimal manifest: resource ${resourceUri('guide/workflow')} or prompt make_reel. ` +
        `Rules for each step (brief, timing, layout and safe areas, motion, camera, physical plausibility, sound, voice, captions, sync, brand, review): get_skill or resource ${resourceUri('skills')}. ` +
        'Renders need a valid licence: get_capabilities.licence / get_licence say whether renders are allowed and, if not, what the user must do. ' +
        'Tools are experimental until v1.0.',
    }
  );
  const ctx = { service, auth, config };

  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.input, annotations: { title: t.title, ...t.annotations } },
      (async (args: Record<string, unknown>): Promise<CallToolResult> => {
        // One request context per tool call, so the service's own audit entry is seen per call.
        const parent = currentRequest();
        const call = { ...(parent ?? { requestId: 'mcp', via: 'mcp' as const }), auth, audited: false, idempotentReplay: false };
        return runWithRequest(call, async () => {
          let result: unknown;
          let error: ApiError | undefined;
          let failure: { code: string; message: string } | undefined;
          try {
            if (!hasScope(auth, t.scope)) throw new ApiError('forbidden', 403, `this API key lacks the "${t.scope}" scope needed by ${t.name}`);
            result = await t.run(args ?? {}, ctx);
            const extra = t.extra ? await t.extra(result, args ?? {}, ctx).catch(() => []) : [];
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }, ...extra],
              structuredContent: (result && typeof result === 'object' && !Array.isArray(result) ? result : { result }) as Record<string, unknown>,
            };
          } catch (e) {
            if (e instanceof ApiError) error = e;
            const err = e instanceof ApiError ? e.toJSON() : { code: 'internal', message: e instanceof Error ? e.message : String(e) };
            failure = { code: err.code, message: err.message };
            if (!(e instanceof ApiError)) console.error(`[renderweld] tool ${t.name} failed`, e);
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err }, null, 2) }] };
          } finally {
            // One audit entry per admin or write call (D-055), unless the service wrote a detailed one.
            if (t.scope !== 'read' && !call.audited) {
              const { targetType, targetId, data } = auditTarget(t.name, args ?? {}, result);
              await service
                .audit({
                  actorType: 'api_key',
                  actorId: auth.keyId,
                  action: auditAction(t.name),
                  ...(targetType ? { targetType } : {}),
                  ...(targetId ? { targetId } : {}),
                  result: !failure ? 'success' : error?.status === 401 || error?.status === 403 ? 'denied' : 'failure',
                  data: { ...data, ...(failure ? { error: failure.code } : {}), ...(call.idempotentReplay ? { idempotentReplay: true } : {}) },
                })
                .catch((e) => console.error('[renderweld] audit write failed', (e as Error).message));
            }
          }
        });
      }) as never
    );
  }

  const requireRead = () => {
    if (!hasScope(auth, 'read')) throw new ApiError('forbidden', 403, 'this API key lacks the "read" scope');
  };

  // Every resource answers under renderweld:// (the name) and the old reelforge:// (#412, RESOURCES).
  const read = {
    'schema/project': async () => {
      requireRead();
      return JSON.stringify(service.projectSchema(), null, 2);
    },
    templates: async () => {
      requireRead();
      return JSON.stringify(service.listTemplates(), null, 2);
    },
    'guide/workflow': async () => WORKFLOW_GUIDE,
    skills: async () => skillsIndex(skillsFor(config.skillsDir), (name) => resourceUri(`skills/${name}`)),
  } satisfies Record<Exclude<ResourcePath, 'projects/{id}' | 'skills/{name}'>, () => Promise<string>>;
  for (const r of RESOURCES) {
    for (const scheme of RESOURCE_SCHEMES) {
      const legacy = scheme !== RESOURCE_SCHEME;
      const name = legacy ? `${r.name}-${scheme}` : r.name;
      const meta = {
        title: legacy ? `${r.title} (old URI)` : r.title,
        description: legacy ? `Same as ${resourceUri(r.path)}; the old ${scheme}:// URI keeps working until a removal date announced in the release notes (docs/RENAMED.md).` : r.description,
        mimeType: r.mimeType,
      };
      if (r.path === 'projects/{id}') {
        server.registerResource(
          name,
          new ResourceTemplate(`${scheme}://${r.path}`, {
            // Listed once, under the new scheme; the old one still reads every project.
            list: legacy
              ? undefined
              : async () => {
                  requireRead();
                  return {
                    // The newest 200 (one page, D-102): this list callback gets no cursor; list_projects pages through all.
                    resources: (await service.listProjects({ limit: 200 })).projects.map((p) => ({ uri: resourceUri(`projects/${p.id}`), name: p.title, mimeType: 'application/json' })),
                  };
                },
          }),
          meta,
          async (uri, vars) => {
            requireRead();
            const p = await service.getProject(String(vars.id));
            return { contents: [{ uri: uri.href, mimeType: r.mimeType, text: JSON.stringify(p, null, 2) }] };
          }
        );
      } else if (r.path === 'skills/{name}') {
        server.registerResource(
          name,
          new ResourceTemplate(`${scheme}://${r.path}`, {
            // Listed once, under the new scheme.
            list: legacy ? undefined : async () => ({ resources: skillsFor(config.skillsDir).map((s) => ({ uri: resourceUri(`skills/${s.name}`), name: s.title, description: s.description, mimeType: r.mimeType })) }),
          }),
          meta,
          async (uri, vars) => {
            const skills = skillsFor(config.skillsDir);
            const s = findSkill(skills, String(vars.name));
            if (!s) throw new ApiError('not_found', 404, `no skill "${String(vars.name)}"; skills: ${skillNames(skills)}`);
            return { contents: [{ uri: uri.href, mimeType: r.mimeType, text: skillMarkdown(s) }] };
          }
        );
      } else {
        const text = read[r.path];
        server.registerResource(name, `${scheme}://${r.path}`, meta, async (uri) => ({ contents: [{ uri: uri.href, mimeType: r.mimeType, text: await text() }] }));
      }
    }
  }

  server.registerPrompt(
    'brief_intake',
    {
      title: 'Ask before assuming: complete the brief',
      description: 'Lists the essentials of a video brief, says where each goes in the manifest, and has the agent ask only the ones the request leaves open.',
      argsSchema: { request: z.string().describe('What the user asked for so far, in their words.') },
    },
    async ({ request }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Before planning this video, make sure the brief is complete. The user asked:\n\n${request}\n\n` +
              'Go through the essentials below. For each one the request already answers, use that answer. For each one it leaves open, ask the user; ' +
              'ask all open questions in one short message, each with a sensible default they can accept ("vertical 1080x1920 unless you say otherwise"). ' +
              'Do not invent answers. If the user says "you decide", use the defaults and say which ones you used.\n\n' +
              `${BRIEF_ESSENTIALS.map((e, i) => `${i + 1}. ${e.question} Goes to: ${e.field}.`).join('\n')}\n\n` +
              'Then write the answers into the manifest (create_project or update_project) and continue with plan_reel or make_reel.',
          },
        },
      ],
    })
  );

  server.registerPrompt(
    'make_reel',
    {
      title: 'Make a reel end to end',
      description: 'The full workflow (discover, create, edit, validate, render, deliver) for a topic, using only these tools.',
      argsSchema: { topic: z.string().describe('What the reel is about and who it is for.') },
    },
    async ({ topic }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Make a short video about: ${topic}\n\nUse the size the user asked for (vertical 1080x1920 if they did not say). Follow this guide exactly, using only the RenderWeld tools. If the topic leaves essentials open (audience, platform and size, length, tone, brand, call to action, captions, voice, music), ask me those first, as the brief_intake prompt lists them; do not assume. Show me the scene list with timings before rendering. If the reel has captions, show me them (get_captions) and ask me to approve or change them before the final render; do not assume I approve. Give me the downloadUrl at the end.\n\n${WORKFLOW_GUIDE}`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    'plan_reel',
    {
      title: 'Plan a reel from a brief',
      description: 'Turns a brief into a RenderWeld manifest using the templates installed on this server.',
      argsSchema: {
        brief: z.string().describe('What the video is about, for whom, and the call to action.'),
        targetSeconds: z.string().optional().describe('Target length in seconds (default 15).'),
        platform: z.string().optional().describe('e.g. instagram-reels, tiktok, youtube-shorts.'),
      },
    },
    async ({ brief, targetSeconds, platform }) => {
      // It lists templates and the workspace's themes, as list_templates and list_themes do: the same scope (#426).
      requireRead();
      const templates = service.listTemplates().map((t) => `- ${t.engine}/${t.id} (${templateDurationLabel(t)}): ${t.description}`).join('\n');
      const themes = (await service.listThemes()).map((t) => `- ${t.id}: ${t.description ?? t.name}`).join('\n');
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Plan a short video for RenderWeld.\n\nBrief: ${brief}\nTarget length: ${targetSeconds ?? '15'} seconds\nPlatform: ${platform ?? 'instagram-reels'}\n\n` +
                `Installed templates:\n${templates}\n\nThemes:\n${themes}\n\n` +
                'Steps:\n1. Call list_templates to read each template\'s props schema.\n' +
                '2. Write a manifest with schemaVersion "0.2", output sized for the platform at 30 fps (1080x1920 for instagram-reels, tiktok and youtube-shorts; 1920x1080 for youtube or the web; 1080x1080 or 1080x1350 for feed posts; any size the user asks for), a brief with that platform, a theme, and 3-6 scenes that add up to the target length. Use durationSeconds within each template\'s range. Open with a hook; keep on-screen text short (about 3 words per second).\n' +
                '3. Call create_project, then validate_project, and fix every error.\n' +
                '4. Show the user the scene list with timings before calling render_project.',
            },
          },
        ],
      };
    }
  );
  server.registerPrompt(
    'review_reel',
    {
      title: 'Review a reel against the delivery checklist',
      description: 'Checks a project manifest (and its validation report) against the delivery checklist.',
      argsSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      requireRead();
      const p = await service.getProject(projectId);
      const report = await service.validateProject(projectId);
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Review this RenderWeld project against the checklist. For each item answer pass / fail / unknown with a one-line reason, then list concrete fixes as tool calls (update_scene, set_theme, ...). ` +
                `Look at the pictures, not only the manifest: if it has a preview or render (list_renders), call get_frames on the newest one (overlay: "safe") and judge every tile.\n\n` +
                `Checklist:\n${DELIVERY_CHECKLIST.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n` +
                `Validation report:\n${JSON.stringify(report, null, 2)}\n\nManifest (version ${p.meta.version}):\n${JSON.stringify(p.manifest, null, 2)}`,
            },
          },
        ],
      };
    }
  );
  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request, JSON responses. */
/**
 * Answer one MCP HTTP request. `parsedBody` is the JSON-RPC message (or batch) when the caller already read and
 * parsed the body (POST /mcp does, to charge the rate limit per message); the transport then does not read it again.
 */
export async function handleMcp(req: Request, auth: AuthContext, service: ReelforgeService, config: ServerConfig, parsedBody?: unknown): Promise<Response> {
  const server = buildServer(service, auth, config);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req, {
      authInfo: { token: 'redacted', clientId: auth.keyId, scopes: auth.scopes },
      ...(parsedBody !== undefined ? { parsedBody } : {}),
    });
  } finally {
    void server.close().catch(() => undefined);
  }
}

/** /.well-known/mcp.json */
export function serverCard(service: ReelforgeService, config: ServerConfig) {
  const base = config.publicUrl ?? `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
  return {
    name: SERVER_NAME,
    title: SERVER_TITLE,
    // The old server name (#413): still listed until phase 7, so a client that matched on it finds this server.
    aliases: [...OLD_SERVER_NAMES],
    version: service.serverVersion,
    description: 'Self-hosted video rendering for AI agents. Agents create and edit projects; the server renders and validates the video.',
    endpoint: `${base}/mcp`,
    transport: { type: 'streamable-http', stateless: true, jsonResponse: true },
    authentication: {
      type: 'bearer',
      header: 'Authorization',
      format: 'Bearer rf_<key>',
      howToGetAKey: 'the operator runs `pnpm keys:create` or POST /v1/keys',
      // MCP OAuth (D-112): an access token of this issuer works too; discovery via the protected-resource metadata.
      ...(config.resolved.config.security.oauth.issuer
        ? { oauth: { issuer: config.resolved.config.security.oauth.issuer, resourceMetadata: resourceMetadataUrl(config.resolved.config.security.oauth.audience ?? `${base}/mcp`) } }
        : {}),
    },
    status: 'experimental',
    schemaVersion: SCHEMA_VERSION,
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title, scope: t.scope, status: 'experimental' })),
    resources: RESOURCES.map((r) => resourceUri(r.path)),
    // The old URIs (#412): still answered, not listed in new docs.
    resourceAliases: Object.fromEntries(RESOURCES.map((r) => [`reelforge://${r.path}`, resourceUri(r.path)])),
    prompts: ['brief_intake', 'make_reel', 'plan_reel', 'review_reel'],
    rest: { base: `${base}/v1`, capabilities: `${base}/v1/capabilities` },
  };
}
