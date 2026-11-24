import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { H264_ARGS, PipelineError, run } from './ffmpeg';

export interface BurnOptions {
  ffmpeg: string;
  /** The assembled video (with its audio). */
  input: string;
  /** An ASS file; burned with libass (FFmpeg's `ass` filter). */
  assFile: string;
  out: string;
  /** Encoder of another output format (#302, formatPlan().master.video). Omitted: H.264 as in assembly. */
  video?: string[];
  /** The video has an alpha channel: libass draws into it too (`alpha=1`), so captions show over transparent areas. */
  alpha?: boolean;
  signal?: AbortSignal;
}

/**
 * Whether this FFmpeg has the libass `ass` filter (burned captions need it).
 * Debian/Ubuntu `ffmpeg` packages and the release image have it (D-107).
 */
export function hasLibass(ffmpeg: string): boolean {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' });
  return r.status === 0 && /^\s*\S+\s+ass\s+V->V/m.test(r.stdout ?? '');
}

/**
 * Burn captions into a video: one libass pass over the assembled file (every
 * frame kept, H.264 settings as in assembly, audio copied). FFmpeg runs in the
 * ASS file's directory and gets its bare name, so no path needs filter
 * escaping. Returns the FFmpeg arguments for the render manifest.
 */
export async function burnSubtitles(o: BurnOptions): Promise<{ args: string[] }> {
  if (!hasLibass(o.ffmpeg)) {
    throw new PipelineError('captions:burn', `${o.ffmpeg} has no libass "ass" filter; install an FFmpeg built with --enable-libass (e.g. the Debian/Ubuntu ffmpeg package) or use captions mode "sidecar"`);
  }
  const name = basename(o.assFile);
  if (!/^[\w.-]+$/.test(name)) throw new PipelineError('captions:burn', `unsafe subtitle file name "${name}"`);
  const args = ['-hide_banner', '-v', 'error', '-y', '-i', resolve(o.input), '-map', '0:v:0', '-map', '0:a?', '-vf', `ass=${name}${o.alpha ? ':alpha=1' : ''}`, ...(o.video ?? H264_ARGS), '-c:a', 'copy', resolve(o.out)];
  await run(o.ffmpeg, args, 'captions:burn', { signal: o.signal, cwd: dirname(resolve(o.assFile)) });
  return { args };
}
