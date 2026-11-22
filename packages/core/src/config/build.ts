import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { IMAGE_EDITION } from './image-edition';
import { SETTINGS_BY_KEY } from './schema';

/**
 * What kind of build this is (D-039).
 *
 *   - `dev`: running from source (`pnpm dev`, tests) or an image built with
 *     `--build-arg REELFORGE_EDITION=dev`. Every setting comes from defaults,
 *     the config file, env and runtime settings. `licence.mode: off` is allowed,
 *     for noncommercial development only (LICENSING.md).
 *   - `release`: the published image. The Dockerfile writes `build-info.json`
 *     next to this package and fixes the licence settings in it
 *     (`licence.mode: required`, the BuildBase `serverUrl` and `orgId`). A config
 *     file, env variable or `update_config` that tries to change them is refused,
 *     and `get_config` shows their source as `build`.
 *
 * The file sits at a fixed path inside the image (root-owned, read-only for the
 * server user); no environment variable can point elsewhere.
 */
export type Edition = 'dev' | 'release';

export interface BuildInfo {
  edition: Edition;
  /** Settings fixed by this build, by dotted key. */
  locked: Record<string, unknown>;
  version?: string;
  revision?: string;
  createdAt?: string;
}

export const DEV_BUILD: BuildInfo = Object.freeze({ edition: 'dev', locked: Object.freeze({}) }) as BuildInfo;

/** packages/core/build-info.json (written by the Dockerfile for release images). */
export const BUILD_INFO_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../build-info.json');

/** Only start-up settings of the licence group may be fixed by a build. */
export const LOCKABLE_SETTINGS: readonly string[] = ['licence.mode', 'licence.serverUrl', 'licence.orgId'];

const BuildInfoSchema = z
  .object({
    edition: z.enum(['dev', 'release']),
    locked: z.record(z.string(), z.unknown()).default({}),
    version: z.string().max(100).optional(),
    revision: z.string().max(100).optional(),
    createdAt: z.string().max(100).optional(),
  })
  .strict();

/** Parse and check a build-info object. Throws with every problem (a broken image must not start). */
export function parseBuildInfo(data: unknown, origin = 'build-info.json'): BuildInfo {
  const r = BuildInfoSchema.safeParse(data);
  if (!r.success) throw new Error(`${origin}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  const problems: string[] = [];
  const locked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(r.data.locked)) {
    const def = SETTINGS_BY_KEY.get(key);
    if (!def || !LOCKABLE_SETTINGS.includes(key)) {
      problems.push(`"${key}" cannot be fixed by a build (allowed: ${LOCKABLE_SETTINGS.join(', ')})`);
      continue;
    }
    const v = def.schema.safeParse(value);
    if (!v.success) problems.push(`"${key}": ${v.error.issues.map((i) => i.message).join('; ')}`);
    else locked[key] = v.data;
  }
  if (r.data.edition === 'release') {
    for (const key of LOCKABLE_SETTINGS) if (!(key in locked)) problems.push(`a release build must fix "${key}"`);
    if (locked['licence.mode'] !== undefined && locked['licence.mode'] !== 'required') problems.push('a release build must fix "licence.mode" to "required"');
  }
  if (problems.length) throw new Error(`${origin}: ${problems.join('; ')}`);
  return Object.freeze({ ...r.data, locked: Object.freeze(locked) });
}

let cached: BuildInfo | undefined;

/**
 * The build described by `file`: build-info.json when present, otherwise a
 * dev build. Code packaged as a release image (`imageEdition`, see
 * image-edition.ts) fails closed: a missing file or one that is not a
 * release build-info is an error, never the dev edition (D-089).
 */
export function loadBuild(file: string = BUILD_INFO_FILE, imageEdition: 'dev' | 'release' = IMAGE_EDITION): BuildInfo {
  const releaseImage = imageEdition === 'release';
  if (!existsSync(file)) {
    if (releaseImage) throw new Error(`${file} is missing: this is a release image and refuses to start without its build information (rebuild or pull the image)`);
    return DEV_BUILD;
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: not readable JSON (${(e as Error).message})`);
  }
  const info = parseBuildInfo(data, file);
  if (releaseImage && info.edition !== 'release') throw new Error(`${file}: this is a release image, but the file describes a "${info.edition}" build; refusing to start`);
  return info;
}

/** This process's build (loadBuild()). Cached. */
export function currentBuild(): BuildInfo {
  return (cached ??= loadBuild());
}

/** "release build" / "dev build", for `origin` in get_config. */
export function buildOrigin(build: BuildInfo): string {
  return `${build.edition} build${build.version ? ` ${build.version}` : ''}`;
}
