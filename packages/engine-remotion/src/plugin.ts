import { existsSync } from 'node:fs';
import { browserVersion, type Availability, type EnginePlugin, type RuntimeConfig } from '@renderweld/core';
import { TEMPLATES } from '@renderweld/project-schema';
import { findRemotion, REMOTION_VERSION, type RemotionInstall } from './load';
import { renderRemotionScene } from './render';

/**
 * Where to render from, or why not. Remotion's licence lets people use it free for personal testing, but a
 * company using it in production needs its own Remotion licence. So the release edition renders with Remotion
 * only when the customer has turned it on, accepted Remotion's licence, given their Remotion licence key and
 * installed Remotion themselves at engines.remotion.home. Development builds use this checkout's copy.
 */
export function remotionInstall(settings: RuntimeConfig | undefined): { install: RemotionInstall } | { reason: string } {
  const cfg = settings?.current;
  const home = cfg?.config.engines?.remotion.home ?? process.env.RENDERWELD_REMOTION_HOME;
  if (cfg?.build.edition !== 'release') {
    const install = findRemotion(home, true);
    return install ? { install } : { reason: 'Remotion is not installed' };
  }
  const r = cfg.config.engines.remotion;
  if (!r.enabled) return { reason: 'Remotion is off: it needs your own Remotion licence (set engines.remotion.enabled after reading docs/public/install/remotion.md)' };
  if (r.licenceAccepted !== 'remotion') return { reason: "Remotion's licence is not accepted: set engines.remotion.licenceAccepted to \"remotion\" once you hold a Remotion licence" };
  if (!r.licenseKey) return { reason: 'no Remotion licence key: set engines.remotion.licenseKey (RENDERWELD_REMOTION_LICENSE_KEY)' };
  const install = findRemotion(r.home, false);
  if (!install) return { reason: `Remotion is not installed at ${r.home} (engines.remotion.home)` };
  if (install.version !== REMOTION_VERSION) return { reason: `Remotion ${install.version} is installed at ${r.home}; this build needs Remotion ${REMOTION_VERSION}` };
  return { install };
}

export interface RemotionEngineOptions {
  /** Chrome Headless Shell binary; defaults to RENDERWELD_CHROMIUM_PATH. */
  browserExecutable?: string;
  /** Parallel browser tabs per render. */
  concurrency?: number;
}

/** The Remotion engine as a plugin (templates: kinetic-title, remotion-layout). */
export function remotionEngine(opts: RemotionEngineOptions = {}): EnginePlugin {
  const browser = () => opts.browserExecutable ?? process.env.RENDERWELD_CHROMIUM_PATH;
  let settings: RuntimeConfig | undefined;
  const licenceKey = () => (settings?.current.build.edition === 'release' ? settings.current.config.engines.remotion.licenseKey : undefined);
  return {
    id: 'remotion',
    displayName: 'Remotion',
    acceptsSource: false,
    version: () => {
      const found = remotionInstall(settings);
      return 'install' in found ? found.install.version : 'not installed';
    },
    useSettings(s) {
      settings = s;
    },
    templates: () =>
      Object.entries(TEMPLATES)
        .filter(([, t]) => t.engine === 'remotion')
        .map(([id, t]) => ({ ...t, id })),
    // Remotion always launches Chrome with --no-sandbox (and --single-process) on Linux.
    browserSandbox: () => false,
    // renderMedia takes a frameRange, and Remotion compositions are frame-pure by design (frames render in parallel tabs,
    // in any order, from useCurrentFrame()): a chunk's frames are the whole render's (ENG-REM-FR, FAN-32).
    capabilities: () => ({ frameRanges: true }),
    availability(): Availability {
      const found = remotionInstall(settings);
      if ('reason' in found) return { ok: false, reason: found.reason };
      const b = browser();
      if (b && existsSync(b)) return { ok: true };
      return {
        ok: false,
        reason:
          'no browser: set RENDERWELD_CHROMIUM_PATH to a Chrome Headless Shell binary (the server does not let Remotion download one at render time)',
      };
    },
    async render(scene, ctx) {
      const found = remotionInstall(settings);
      if ('reason' in found) throw new Error(`Remotion cannot render: ${found.reason}`);
      const key = licenceKey();
      const res = await renderRemotionScene({
        scene,
        output: ctx.output,
        theme: ctx.theme,
        ...(ctx.platform ? { platform: ctx.platform } : {}),
        out: ctx.out,
        cacheDir: ctx.cacheDir,
        browserExecutable: browser(),
        concurrency: opts.concurrency,
        signal: ctx.signal,
        onProgress: ctx.progress,
        ...(ctx.frameRange ? { frameRange: ctx.frameRange } : {}),
        assets: ctx.assets,
        tools: ctx.tools,
        workDir: ctx.workDir,
        log: ctx.log,
        install: found.install,
        ...(key ? { licenseKey: key } : {}),
      });
      return { file: res.out, frames: res.frames, engineVersion: res.engineVersion, browserVersion: browserVersion(browser()), millis: res.millis };
    },
  };
}
