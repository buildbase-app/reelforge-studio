import { readFile } from 'node:fs/promises';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApiError, ReelforgeService, hasScope, type AuthContext, type Scope } from '@reelforge/core';
import { SCHEMA_VERSION } from '@reelforge/project-schema';
import { z } from 'zod';
import type { ServerConfig } from './config';

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

const timing = (m: Parameters<typeof ReelforgeService.sceneTiming>[0]) => ReelforgeService.sceneTiming(m);

export const TOOLS: ToolDef[] = [
  {
    name: 'get_capabilities',
    title: 'Get server capabilities',
    description:
      'Start here. Returns what this ReelForge server can do right now: installed engines (and whether each can render on this machine), templates, themes, media providers (configured or not, with cost notes), render backends, limits (fps, max duration, upload size) and tool versions. Never guess an engine, template or provider: use what this returns.',
    scope: 'read',
    input: {},
    annotations: { readOnlyHint: true },
    run: async (_a, { service }) => service.capabilities(),
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
    },
    run: async (a, { service }) => service.createTheme(a),
  },
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'Lists projects on this server with title, version, scene count and duration.',
    scope: 'read',
    input: {},
    annotations: { readOnlyHint: true },
    run: async (_a, { service }) => ({ projects: await service.listProjects() }),
  },
  {
    name: 'create_project',
    title: 'Create a project',
    description:
      'Creates a project from a manifest. Minimal manifest: { schemaVersion: "0.2", projectId, title, output: { width: 1080, height: 1920, fps: 30, format: "mp4" }, scenes: [{ id, engine, template, durationSeconds, props }] }. Optional: brief, theme, audio, assets, captions. The manifest is validated against installed engines and templates; on failure you get every problem with its path. v0.1 manifests are migrated automatically.',
    scope: 'write',
    input: { manifest: manifestObj },
    run: async (a, { service }) => {
      const r = await service.createProject(a.manifest);
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
      'Changes a project. Give either patch (a JSON merge patch, RFC 7396: objects merge, null deletes a key, arrays replace) or manifest (a full replacement). For single scenes prefer add_scene / update_scene. Every update is validated and saved as a new version.',
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
      'Full validation report: errors (block rendering) and warnings (e.g. missing licence, rounding of durationSeconds, captions not rendered yet), plus a summary (scenes, total frames, duration, size, engines). Checks schema, template props and durations, theme, assets on disk, render backend and engine availability on this machine.',
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
    },
    run: async (a, { service }) => {
      const r = await service.addScene(a.projectId, a.scene, { index: a.index, expectedVersion: a.expectedVersion });
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
    },
    annotations: { openWorldHint: true },
    run: async (a, { service }) =>
      service.runProvider(
        a.provider ?? 'elevenlabs',
        { text: a.text, voiceId: a.voiceId, ...(a.modelId ? { modelId: a.modelId } : {}) },
        { projectId: a.projectId, acknowledgeCost: a.acknowledgeCost }
      ),
  },
  {
    name: 'add_asset_from_url',
    title: 'Import an asset from a URL',
    description:
      'Downloads an image, audio, video or font from a public https URL into the server asset store (size-limited, private networks refused, type checked from the bytes) and, with projectId, adds it to the project as assetId. Only use files you have the rights to; pass license metadata.',
    scope: 'write',
    input: { url: z.string().url(), projectId: projectId.optional(), assetId: z.string().optional().describe('Id to use in the manifest, e.g. "music".'), license: licenseObj },
    annotations: { openWorldHint: true },
    run: async (a, { service }) => service.addAssetFromUrl(a.url, { projectId: a.projectId, assetId: a.assetId, license: a.license }),
  },
  {
    name: 'list_assets',
    title: 'List assets',
    description: 'Lists assets: those of a project (manifest entries) with projectId, otherwise everything in the server asset store.',
    scope: 'read',
    input: { projectId: projectId.optional() },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => ({ assets: await service.listAssets({ projectId: a.projectId }) }),
  },
  {
    name: 'preview_scene',
    title: 'Render a quick preview',
    description:
      'Starts a low-resolution preview render (default 1/3 size) of one scene, or of the whole project when sceneId is omitted. Returns a job; poll get_job, then get_render_output (includes a poster image).',
    scope: 'render',
    input: { projectId, sceneId: z.string().optional(), scale: z.number().gt(0).max(1).optional() },
    run: async (a, { service }) => ({ job: await service.preview(a.projectId, { sceneId: a.sceneId, scale: a.scale }) }),
  },
  {
    name: 'render_project',
    title: 'Render the project',
    description:
      'Validates the project and starts the final render (every scene with its engine, assembled with audio, checked with ffprobe and a full decode). Returns a job immediately; renders take seconds to minutes. Poll get_job every few seconds until status is succeeded or failed, then call get_render_output.',
    scope: 'render',
    input: { projectId, backend: z.string().optional().describe('Render backend id; default from the manifest ("local").') },
    run: async (a, { service }) => ({ job: await service.startRender(a.projectId, { backend: a.backend }) }),
  },
  {
    name: 'get_job',
    title: 'Get job status',
    description: 'Status of a render/preview job: queued, running (with progress stage and fraction), succeeded (result has renderId and output URLs), failed (error with code and stage) or cancelled.',
    scope: 'read',
    input: { jobId: z.string() },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => service.getJob(a.jobId),
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
      'Returns the output of a finished render: downloadUrl (a signed link to the MP4 that works WITHOUT a key until downloadUrlExpiresAt, about 1 hour; give this to the user or to curl), outputUrl (same file, needs Authorization: Bearer), poster and render-manifest URLs, size, fps, frame count, duration, checks and tool versions. Give renderId, or jobId of a succeeded job. includePoster (default true) attaches a small PNG of the first frame so you can look at it.',
    scope: 'read',
    input: { renderId: z.string().optional(), jobId: z.string().optional(), includePoster: z.boolean().optional() },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => {
      let renderId = a.renderId as string | undefined;
      if (!renderId && a.jobId) {
        const job = service.getJob(a.jobId);
        if (job.status !== 'succeeded') throw new ApiError('job_not_finished', 409, `job ${a.jobId} is ${job.status}; poll get_job until it succeeds`, { error: job.error });
        renderId = job.result?.renderId as string;
      }
      if (!renderId) throw new ApiError('bad_request', 400, 'give renderId or jobId');
      const summary = await service.getRender(renderId);
      const manifest = (await service.getRenderManifest(renderId)) as { output: Record<string, unknown>; versions: unknown; checks: unknown };
      return { ...summary, output: manifest.output, checks: manifest.checks, versions: manifest.versions };
    },
    extra: async (result, args, { service }) => {
      if (args.includePoster === false) return [];
      const { path } = await service.renderFile(result.renderId, 'poster.png');
      return [{ type: 'image', data: (await readFile(path)).toString('base64'), mimeType: 'image/png' }];
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
    name: 'list_jobs',
    title: 'List jobs',
    description: 'Lists render and preview jobs (newest first), optionally only those of one project.',
    scope: 'read',
    input: { projectId: projectId.optional() },
    annotations: { readOnlyHint: true },
    run: async (a, { service }) => ({ jobs: service.listJobs({ projectId: a.projectId }) }),
  },
  {
    name: 'retry_job',
    title: 'Retry a failed or cancelled job',
    description: 'Starts a new job with the same parameters as a failed or cancelled one (same project version). Earlier outputs are never overwritten.',
    scope: 'render',
    input: { jobId: z.string() },
    run: async (a, { service }) => ({ job: service.retryJob(a.jobId) }),
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
    description: 'Deletes a project with all its versions and renders. Cannot be undone; confirm with the user first.',
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
      'Uploads a small file you already have (image, audio, video, font) as base64, for example generated audio. The type is checked from the bytes. With projectId it is added to the project as assetId. MCP messages are limited to a few MB; for larger files use REST POST /v1/assets (multipart) or add_asset_from_url.',
    scope: 'write',
    input: {
      dataBase64: z.string().min(1).describe('File content, base64.'),
      filename: z.string().optional(),
      projectId: projectId.optional(),
      assetId: z.string().optional(),
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
    description: 'Media providers (TTS, ...) installed on this server, whether the operator configured them, and their cost notes.',
    scope: 'read',
    input: {},
    annotations: { readOnlyHint: true },
    run: async (_a, { service }) => ({ providers: service.listProviders() }),
  },
  {
    name: 'configure_provider',
    title: 'Configure a media provider (admin)',
    description:
      'Sets or clears a provider setting such as ELEVENLABS_API_KEY (see list_providers for each provider\'s setting names). Values are stored on the server (file mode 0600) and never returned; list_providers then shows set: true and source "api". Use null to clear a value (the environment variable, if any, applies again). Needs the admin scope. Only do this with a key the user gave you for this purpose.',
    scope: 'admin',
    input: {
      providerId: z.string(),
      values: z.record(z.string(), z.string().nullable()).describe('Setting name -> value, or null to clear.'),
    },
    run: async (a, { service }) => service.configureProvider(a.providerId, a.values),
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
    },
    annotations: { openWorldHint: true },
    run: async (a, { service }) =>
      service.runProvider(a.providerId, a.params, { projectId: a.projectId, assetId: a.assetId, attachAs: a.attachAs, acknowledgeCost: a.acknowledgeCost }),
  },
  {
    name: 'list_keys',
    title: 'List API keys (admin)',
    description: 'Lists API keys (id, name, scopes, prefix, created/last used). Never returns secrets. Needs the admin scope.',
    scope: 'admin',
    input: {},
    annotations: { readOnlyHint: true },
    run: async (_a, { service }) => ({ keys: await service.listKeys() }),
  },
  {
    name: 'create_key',
    title: 'Create an API key (admin)',
    description: 'Creates an API key with the given scopes (read, write, render, admin). The key is returned once. Needs the admin scope.',
    scope: 'admin',
    input: { name: z.string(), scopes: z.array(z.enum(['read', 'write', 'render', 'admin'])).min(1) },
    run: async (a, { service }) => ({ ...(await service.createKey(a.name, a.scopes)), note: 'store this key now; it is not shown again' }),
  },
  {
    name: 'delete_key',
    title: 'Delete an API key (admin)',
    description: 'Deletes an API key; it stops working immediately. You cannot delete the key you are using. Needs the admin scope.',
    scope: 'admin',
    input: { keyId: z.string() },
    annotations: { destructiveHint: true },
    run: async (a, { service, auth }) => {
      if (a.keyId === auth.keyId) throw new ApiError('conflict', 409, 'refusing to delete the key used for this request');
      await service.deleteKey(a.keyId);
      return { deleted: a.keyId };
    },
  },
];

/** Served as the resource reelforge://guide/workflow and inside the make_reel prompt. */
export const WORKFLOW_GUIDE = `# ReelForge Studio: making a reel with MCP tools only

You decide the scenes; the server validates, renders and checks. Everything is
done with tools; there is no UI.

## Steps
1. get_capabilities: engines that can render here (available: true), templates,
   themes, providers (configured? cost?), limits (fps 24/25/30/60, max 180 s).
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
7. validate_project until ok: true (warnings are fine but read them).
8. Optional quick look: preview_scene (low resolution), then get_render_output.
9. render_project -> poll get_job every 3-5 s until succeeded/failed ->
   get_render_output. Give the user downloadUrl (works without a key for ~1 h).
   If it failed: get_job_logs, fix, render again (or retry_job).

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

## Rules of thumb
- Open with a hook; about 3 words per second of on-screen text.
- Use only engines with available: true; never invent templates or props.
- html/hyperframes scenes have no network: inline everything (data: URLs);
  CSS animations and the Web Animations API are seeked frame by frame. Theme
  tokens are CSS variables: --rf-bg, --rf-text, --rf-muted, --rf-accent,
  --rf-accent2, --rf-font, --rf-unit (1% of the width).
- Ask the user before anything that costs money (providers) or deletes data.
`;

const DELIVERY_CHECKLIST = [
  'Size and frame rate match the target platform (default 1080x1920 at 30 fps).',
  'The first frame is not empty (platforms use it as a thumbnail).',
  'Every scene has a clear single message; on-screen text is short enough to read in its duration (about 3 words per second).',
  'Scene durations are within each template\'s range; the total matches brief.targetSeconds.',
  'Theme colours have enough contrast (text vs background).',
  'Music, voice and sound effects are assets with licence metadata; no warnings about missing licences remain.',
  'No placeholder text remains (lorem ipsum, TODO, example.com).',
  'validate_project returns no errors; warnings are understood.',
  'After rendering: get_render_output shows checks metadata/decode/duration = pass.',
];

function buildServer(service: ReelforgeService, auth: AuthContext, config: ServerConfig): McpServer {
  const server = new McpServer(
    { name: 'reelforge-studio', version: service.serverVersion },
    {
      instructions:
        'ReelForge Studio renders short vertical videos from a JSON manifest. You decide the scenes; the server validates, renders and checks. ' +
        'Workflow: get_capabilities -> list_templates/list_themes -> create_project -> add_scene/update_scene/set_theme/set_audio -> validate_project -> render_project -> get_job (poll) -> get_render_output (downloadUrl works without a key). ' +
        'Full guide with a minimal manifest: resource reelforge://guide/workflow or prompt make_reel. ' +
        'Tools are experimental until v1.0.',
    }
  );
  const ctx = { service, auth, config };

  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.input, annotations: { title: t.title, ...t.annotations } },
      (async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          if (!hasScope(auth, t.scope)) throw new ApiError('forbidden', 403, `this API key lacks the "${t.scope}" scope needed by ${t.name}`);
          const result = await t.run(args ?? {}, ctx);
          const extra = t.extra ? await t.extra(result, args ?? {}, ctx).catch(() => []) : [];
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }, ...extra],
            structuredContent: (result && typeof result === 'object' && !Array.isArray(result) ? result : { result }) as Record<string, unknown>,
          };
        } catch (e) {
          const err =
            e instanceof ApiError
              ? e.toJSON()
              : { code: 'internal', message: e instanceof Error ? e.message : String(e) };
          if (!(e instanceof ApiError)) console.error(`[reelforge] tool ${t.name} failed`, e);
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err }, null, 2) }] };
        }
      }) as never
    );
  }

  const requireRead = () => {
    if (!hasScope(auth, 'read')) throw new ApiError('forbidden', 403, 'this API key lacks the "read" scope');
  };

  server.registerResource(
    'project-schema',
    'reelforge://schema/project',
    { title: 'Project manifest JSON Schema', description: 'JSON Schema of the current manifest version.', mimeType: 'application/json' },
    async (uri) => {
      requireRead();
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(service.projectSchema(), null, 2) }] };
    }
  );
  server.registerResource(
    'templates',
    'reelforge://templates',
    { title: 'Installed templates', description: 'Templates with engines, durations, theme tokens and props schemas.', mimeType: 'application/json' },
    async (uri) => {
      requireRead();
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(service.listTemplates(), null, 2) }] };
    }
  );
  server.registerResource(
    'project',
    new ResourceTemplate('reelforge://projects/{id}', {
      list: async () => {
        requireRead();
        return {
          resources: (await service.listProjects()).map((p) => ({ uri: `reelforge://projects/${p.id}`, name: p.title, mimeType: 'application/json' })),
        };
      },
    }),
    { title: 'Project manifest', description: 'The current manifest of a project.', mimeType: 'application/json' },
    async (uri, vars) => {
      requireRead();
      const id = String(vars.id);
      const p = await service.getProject(id);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(p, null, 2) }] };
    }
  );

  server.registerResource(
    'workflow-guide',
    'reelforge://guide/workflow',
    { title: 'How to make a reel with these tools', description: 'Step-by-step workflow, a minimal manifest and rules of thumb. Read this first if you have no other docs.', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: WORKFLOW_GUIDE }] })
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
            text: `Make a short vertical reel about: ${topic}\n\nFollow this guide exactly, using only the ReelForge tools. Show me the scene list with timings before rendering, and give me the downloadUrl at the end.\n\n${WORKFLOW_GUIDE}`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    'plan_reel',
    {
      title: 'Plan a reel from a brief',
      description: 'Turns a brief into a ReelForge manifest using the templates installed on this server.',
      argsSchema: {
        brief: z.string().describe('What the video is about, for whom, and the call to action.'),
        targetSeconds: z.string().optional().describe('Target length in seconds (default 15).'),
        platform: z.string().optional().describe('e.g. instagram-reels, tiktok, youtube-shorts.'),
      },
    },
    async ({ brief, targetSeconds, platform }) => {
      const templates = service.listTemplates().map((t) => `- ${t.engine}/${t.id} (${t.minSeconds}-${t.maxSeconds}s): ${t.description}`).join('\n');
      const themes = (await service.listThemes()).map((t) => `- ${t.id}: ${t.description ?? t.name}`).join('\n');
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Plan a short vertical video for ReelForge Studio.\n\nBrief: ${brief}\nTarget length: ${targetSeconds ?? '15'} seconds\nPlatform: ${platform ?? 'instagram-reels'}\n\n` +
                `Installed templates:\n${templates}\n\nThemes:\n${themes}\n\n` +
                'Steps:\n1. Call list_templates to read each template\'s props schema.\n' +
                '2. Write a manifest with schemaVersion "0.2", output 1080x1920 at 30 fps, a brief, a theme, and 3-6 scenes that add up to the target length. Use durationSeconds within each template\'s range. Open with a hook; keep on-screen text short (about 3 words per second).\n' +
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
                `Review this ReelForge project against the checklist. For each item answer pass / fail / unknown with a one-line reason, then list concrete fixes as tool calls (update_scene, set_theme, ...).\n\n` +
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
export async function handleMcp(req: Request, auth: AuthContext, service: ReelforgeService, config: ServerConfig): Promise<Response> {
  const server = buildServer(service, auth, config);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req, {
      authInfo: { token: 'redacted', clientId: auth.keyId, scopes: auth.scopes },
    });
  } finally {
    void server.close().catch(() => undefined);
  }
}

/** /.well-known/mcp.json */
export function serverCard(service: ReelforgeService, config: ServerConfig) {
  const base = config.publicUrl ?? `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
  return {
    name: 'reelforge-studio',
    title: 'ReelForge Studio',
    version: service.serverVersion,
    description: 'Self-hosted short-form video studio. Agents create and edit projects; the server renders and validates MP4s.',
    endpoint: `${base}/mcp`,
    transport: { type: 'streamable-http', stateless: true, jsonResponse: true },
    authentication: { type: 'bearer', header: 'Authorization', format: 'Bearer rf_<key>', howToGetAKey: 'the operator runs `pnpm keys:create` or POST /v1/keys' },
    status: 'experimental',
    schemaVersion: SCHEMA_VERSION,
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title, scope: t.scope, status: 'experimental' })),
    resources: ['reelforge://guide/workflow', 'reelforge://schema/project', 'reelforge://templates', 'reelforge://projects/{id}'],
    prompts: ['make_reel', 'plan_reel', 'review_reel'],
    rest: { base: `${base}/v1`, capabilities: `${base}/v1/capabilities` },
  };
}
