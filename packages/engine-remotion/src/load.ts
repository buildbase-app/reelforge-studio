import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The Remotion version the compositions are written and tested against. */
export const REMOTION_VERSION = '4.0.545';

export type RemotionRenderer = typeof import('@remotion/renderer');
export type RemotionBundler = typeof import('@remotion/bundler');

export interface RemotionInstall {
  /** `home`: installed by the customer at engines.remotion.home; `workspace`: the development checkout. */
  from: 'home' | 'workspace';
  version: string;
  /** Resolves Remotion's packages from here. */
  require: NodeJS.Require;
}

const readVersion = (req: NodeJS.Require, pkg: string): string | null => {
  try {
    return (JSON.parse(readFileSync(req.resolve(`${pkg}/package.json`), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
};

/**
 * Finds Remotion: first at `home` (the customer's own install, a folder with node_modules/remotion and
 * node_modules/@remotion/renderer), then, when `allowWorkspace`, in this checkout (development builds).
 * Null when neither has both packages.
 */
export function findRemotion(home: string | undefined, allowWorkspace: boolean): RemotionInstall | null {
  if (home && existsSync(join(home, 'node_modules', 'remotion', 'package.json'))) {
    const req = createRequire(join(home, 'package.json'));
    const version = readVersion(req, 'remotion');
    if (version && readVersion(req, '@remotion/renderer')) return { from: 'home', version, require: req };
  }
  if (allowWorkspace) {
    const req = createRequire(import.meta.url);
    const version = readVersion(req, 'remotion');
    if (version && readVersion(req, '@remotion/renderer')) return { from: 'workspace', version, require: req };
  }
  return null;
}

const imported = new Map<string, Promise<unknown>>();
function importFrom<T>(install: RemotionInstall, pkg: string): Promise<T> {
  const file = install.require.resolve(pkg);
  let p = imported.get(file);
  if (!p) {
    p = import(pathToFileURL(file).href);
    imported.set(file, p);
  }
  return p as Promise<T>;
}

/** @remotion/renderer from the given install. */
export function loadRenderer(install: RemotionInstall): Promise<RemotionRenderer> {
  return importFrom<RemotionRenderer>(install, '@remotion/renderer');
}

/** @remotion/bundler (Webpack) from the given install; only needed to build the compositions bundle. */
export function loadBundler(install: RemotionInstall): Promise<RemotionBundler> {
  return importFrom<RemotionBundler>(install, '@remotion/bundler');
}
