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
 *     `--build-arg RENDERWELD_EDITION=dev`. Every setting comes from defaults,
 *     the config file, env and runtime settings. `licence.mode: off` is allowed,
 *     for noncommercial development only (LICENSING.md).
 *   - `release`: the published image. The Dockerfile writes `build-info.json`
 *     next to this package and fixes the licence settings in it
 *     (`licence.mode: required`, the BuildBase `serverUrl` and `orgId`, and from
 *     1.0.0 the `itemIds` sold for its major version). A config
 *     file, env variable or `update_config` that tries to change them is refused,
 *     and `get_config` shows their source as `build`.
 *
 * A release build whose licence server or organisation differs from the
 * official image's (`Dockerfile` build arguments LICENCE_SERVER_URL and
 * LICENCE_ORG_ID) is marked `custom` (#539): it keeps every release
 * protection, but `get_config`, `get_capabilities` and `renderweld config check`
 * say that it is not an official RenderWeld image, because anyone can build an
 * image that checks keys against their own server.
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
  /** A release build against another licence server or organisation than the official image's (#539). */
  custom?: boolean;
}

export const DEV_BUILD: BuildInfo = Object.freeze({ edition: 'dev', locked: Object.freeze({}) }) as BuildInfo;

/** packages/core/build-info.json (written by the Dockerfile for release images). */
export const BUILD_INFO_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../build-info.json');

/** Only start-up settings of the licence group may be fixed by a build. */
export const LOCKABLE_SETTINGS: readonly string[] = ['licence.mode', 'licence.serverUrl', 'licence.orgId', 'licence.itemIds'];

/** Settings every release build must fix (`licence.itemIds` only from 1.0.0, see parseBuildInfo). */
const REQUIRED_LOCKS: readonly string[] = ['licence.mode', 'licence.serverUrl', 'licence.orgId'];

/** "1.4.2", "v2.0.0-rc.1" → 1, 2; undefined when the version is not semver-like. */
export function majorVersion(version: string | undefined): number | undefined {
  const m = version?.trim().match(/^v?(\d+)\.\d+/);
  return m ? Number(m[1]) : undefined;
}

const BuildInfoSchema = z
  .object({
    edition: z.enum(['dev', 'release']),
    locked: z.record(z.string(), z.unknown()).default({}),
    version: z.string().max(100).optional(),
    revision: z.string().max(100).optional(),
    createdAt: z.string().max(100).optional(),
    custom: z.boolean().optional(),
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
    for (const key of REQUIRED_LOCKS) if (!(key in locked)) problems.push(`a release build must fix "${key}"`);
    if (locked['licence.mode'] !== undefined && locked['licence.mode'] !== 'required') problems.push('a release build must fix "licence.mode" to "required"');
    // A key covers one major version (D-142): from 1.0.0 a release image accepts only the items sold for its major version.
    const major = majorVersion(r.data.version);
    const items = locked['licence.itemIds'];
    if (major !== undefined && major >= 1 && !(Array.isArray(items) && items.length > 0)) {
      problems.push(`a release build of version ${r.data.version} must fix "licence.itemIds" to the BuildBase items sold for RenderWeld ${major} (build arg LICENCE_ITEM_IDS)`);
    }
  }
  if (r.data.custom !== undefined && r.data.edition !== 'release') problems.push('only a release build can be marked "custom"');
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
  return `${build.custom ? 'custom ' : ''}${build.edition} build${build.version ? ` ${build.version}` : ''}`;
}

/** The warning a custom release build carries in get_config and `renderweld config check` (#539). */
export const CUSTOM_BUILD_WARNING =
  'this image was built with a licence server or organisation other than the official RenderWeld image\'s, so it is not an official RenderWeld image; licence keys are checked against that server';
