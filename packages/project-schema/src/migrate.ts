import { SCHEMA_VERSION, type ProjectInput } from './project';
import { projectV01, V01_SCHEMA_VERSION, type ProjectV01 } from './v01';

/** Every manifest version this code can read. The last one is current. */
export const SUPPORTED_SCHEMA_VERSIONS = [V01_SCHEMA_VERSION, SCHEMA_VERSION] as const;

export interface MigrationIssue {
  path: string;
  message: string;
}

export type MigrationResult =
  | { ok: true; manifest: ProjectInput; migratedFrom: string | null }
  | { ok: false; issues: MigrationIssue[] };

/**
 * v0.1 → v0.2. Pure and lossless for valid v0.1 input:
 * - `audio.musicTrack/voiceTrack/musicVolume` become `audio.music` / `audio.voice`;
 * - asset `path` becomes `uri: "project://<path>"`;
 * - `theme` is "default", `render.backend` is "local".
 * Scene ids, frame counts and props are unchanged, so timing is identical.
 */
export function migrateV01ToV02(v01: ProjectV01): ProjectInput {
  const music = v01.audio.musicTrack
    ? { asset: v01.audio.musicTrack, volume: v01.audio.musicVolume, ducking: false, fadeOutSeconds: 1 }
    : null;
  const voice = v01.audio.voiceTrack ? { asset: v01.audio.voiceTrack, volume: 1, startFrame: 0 } : null;
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: v01.projectId,
    title: v01.title,
    theme: 'default',
    output: v01.output,
    render: { backend: 'local' },
    audio: { voice, music, sfx: [] },
    captions: { enabled: false },
    assets: v01.assets.map((a) => ({
      id: a.id,
      uri: `project://${a.path}`,
      mediaType: a.mediaType,
      ...(a.sha256 ? { sha256: a.sha256 } : {}),
      ...(a.license ? { license: a.license } : {}),
    })),
    scenes: v01.scenes.map((s) => ({
      id: s.id,
      engine: s.engine,
      template: s.template,
      ...(s.startFrame !== undefined ? { startFrame: s.startFrame } : {}),
      durationFrames: s.durationFrames,
      props: s.props,
      assets: s.assets,
    })),
  };
}

/**
 * Bring any supported manifest to the current version. Older versions are
 * validated with their own schema first, so errors point at the fields the
 * author actually wrote.
 */
export function migrate(input: unknown): MigrationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ path: '(root)', message: 'a project manifest must be a JSON object' }] };
  }
  const version = (input as { schemaVersion?: unknown }).schemaVersion;
  if (version === SCHEMA_VERSION) return { ok: true, manifest: input as ProjectInput, migratedFrom: null };
  if (version === V01_SCHEMA_VERSION) {
    const parsed = projectV01.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => ({
          path: i.path.map(String).join('.') || '(root)',
          message: i.message,
        })),
      };
    }
    return { ok: true, manifest: migrateV01ToV02(parsed.data), migratedFrom: V01_SCHEMA_VERSION };
  }
  return {
    ok: false,
    issues: [
      {
        path: 'schemaVersion',
        message:
          version === undefined
            ? `missing; use "${SCHEMA_VERSION}" (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`
            : `unsupported schemaVersion ${JSON.stringify(version)}; supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
      },
    ],
  };
}
