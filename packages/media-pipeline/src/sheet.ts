import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PipelineError, run } from './ffmpeg';

/** A frame to show: its index in the video and the label drawn on its tile. */
export interface SheetTile {
  frame: number;
  label: string;
}

/** Insets in source pixels (the safe area to keep clear, e.g. safeAreaInsets(...).content). */
export interface SheetInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FramesImageOptions {
  ffmpeg: string;
  /** The rendered video (any format FFmpeg decodes). */
  input: string;
  /** The video's exact frame rate as ffprobe reports it (`30`, `30000/1001`). */
  frameRate: string;
  /** Source size, for the overlay and the tile height. */
  width: number;
  height: number;
  tiles: SheetTile[];
  /** Each tile is scaled to this width (never above the source). */
  tileWidth: number;
  /** Tint outside these insets and outline them (the safe area); the video is not changed. */
  overlay?: SheetInsets;
  /** `sheet`: one JPEG with every tile; `separate`: one JPEG per tile. */
  layout: 'sheet' | 'separate';
  /** The file (sheet) or folder (separate) to write. */
  out: string;
  signal?: AbortSignal;
}

export interface FramesImageResult {
  files: string[];
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  /** False when this FFmpeg has no drawtext filter: the tiles carry no labels (the JSON answer still lists them). */
  labels: boolean;
  args: string[];
}

let drawtext: Map<string, boolean> | undefined;

/** Whether this FFmpeg has `drawtext` (libfreetype): Debian/Ubuntu packages and the release image do. */
export function hasDrawtext(ffmpeg: string): boolean {
  drawtext ??= new Map();
  let ok = drawtext.get(ffmpeg);
  if (ok === undefined) {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' });
    ok = r.status === 0 && /^\s*\S+\s+drawtext\s+V->V/m.test(r.stdout ?? '');
    drawtext.set(ffmpeg, ok);
  }
  return ok;
}

/** Frames per second from `30` or `30000/1001`. */
export function parseFrameRate(rate: string): number {
  const [n, d] = rate.split('/').map(Number);
  const fps = d ? n! / d : n!;
  if (!Number.isFinite(fps) || fps <= 0) throw new PipelineError('frames', `bad frame rate "${rate}"`);
  return fps;
}

/** Columns for a sheet of n tiles of tw x th that comes out roughly square. */
export function sheetColumns(n: number, tw: number, th: number): number {
  return Math.max(1, Math.min(n, Math.round(Math.sqrt((n * th) / tw)) || 1));
}

const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));

/**
 * Stills of exact frames of a rendered video, as one labelled contact sheet or one file per frame, for agents
 * to look at their work (#379). Each frame is its own input, seeked to half a frame before it: FFmpeg's accurate
 * seek drops every frame before that point, so the first frame left is exactly the one asked for, at any length
 * of video, without decoding from the start. Labels come from text files beside the output (no filter escaping).
 */
export async function framesImage(o: FramesImageOptions): Promise<FramesImageResult> {
  if (!o.tiles.length) throw new PipelineError('frames', 'no frames to show');
  const fps = parseFrameRate(o.frameRate);
  const scale = Math.min(1, o.tileWidth / o.width);
  const tileWidth = even(o.width * scale);
  const tileHeight = even(o.height * scale);
  const labels = hasDrawtext(o.ffmpeg);
  const columns = o.layout === 'sheet' ? sheetColumns(o.tiles.length, tileWidth, tileHeight) : 1;
  const rows = o.layout === 'sheet' ? Math.ceil(o.tiles.length / columns) : 1;
  if (o.layout === 'separate') await mkdir(resolve(o.out), { recursive: true });
  const work = await mkdtemp(join(o.layout === 'sheet' ? dirname(resolve(o.out)) : resolve(o.out), '.frames-'));
  try {
    const args = ['-hide_banner', '-v', 'error', '-y'];
    for (const t of o.tiles) {
      if (!Number.isInteger(t.frame) || t.frame < 0) throw new PipelineError('frames', `bad frame index ${t.frame}`);
      const at = t.frame === 0 ? 0 : (t.frame - 0.5) / fps;
      args.push('-ss', at.toFixed(6), '-i', resolve(o.input));
    }
    const font = Math.max(10, Math.round(tileHeight / 22));
    const graph: string[] = [];
    for (const [i, t] of o.tiles.entries()) {
      const steps = [`trim=end_frame=1`, `setpts=PTS-STARTPTS`];
      if (o.overlay) {
        const { top, right, bottom, left } = o.overlay;
        // Tint the zones outside the safe area, then outline it, on the source frame (exact pixels), before scaling.
        steps.push(
          `drawbox=x=0:y=0:w=iw:h=${top}:color=red@0.28:t=fill`,
          `drawbox=x=0:y=ih-${bottom}:w=iw:h=${bottom}:color=red@0.28:t=fill`,
          `drawbox=x=0:y=${top}:w=${left}:h=ih-${top + bottom}:color=red@0.28:t=fill`,
          `drawbox=x=iw-${right}:y=${top}:w=${right}:h=ih-${top + bottom}:color=red@0.28:t=fill`,
          `drawbox=x=${left}:y=${top}:w=iw-${left + right}:h=ih-${top + bottom}:color=red@0.9:t=${Math.max(2, Math.round(Math.min(o.width, o.height) / 270))}`
        );
      }
      steps.push(`scale=${tileWidth}:${tileHeight}:flags=bicubic`, 'format=yuv420p');
      if (labels) {
        const name = `label${i}.txt`;
        await writeFile(join(work, name), t.label.replace(/[\r\n]+/g, ' '));
        steps.push(`drawtext=textfile=${name}:fontsize=${font}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=${Math.round(font / 3)}:x=${Math.round(font / 2)}:y=h-th-${font}`);
      }
      graph.push(`[${i}:v]${steps.join(',')}[t${i}]`);
    }
    const files: string[] = [];
    if (o.layout === 'sheet') {
      const pad = Math.max(2, Math.round(tileWidth / 90));
      graph.push(`${o.tiles.map((_, i) => `[t${i}]`).join('')}concat=n=${o.tiles.length}:v=1:a=0,tile=${columns}x${rows}:padding=${pad}:margin=${pad}:color=0x202020[sheet]`);
      args.push('-filter_complex', graph.join(';'), '-map', '[sheet]', '-frames:v', '1', '-q:v', '4', resolve(o.out));
      files.push(resolve(o.out));
    } else {
      args.push('-filter_complex', graph.join(';'));
      for (const [i] of o.tiles.entries()) {
        const file = join(resolve(o.out), `${String(i + 1).padStart(2, '0')}.jpg`);
        args.push('-map', `[t${i}]`, '-frames:v', '1', '-q:v', '4', file);
        files.push(file);
      }
    }
    await run(o.ffmpeg, args, 'frames', { signal: o.signal, cwd: work, timeoutMs: 120_000 });
    for (const f of files) {
      const s = await stat(f).catch(() => null);
      if (!s?.size) throw new PipelineError('frames', `no image written for ${f}; the frame may be past the end of the video`);
    }
    return { files, tileWidth, tileHeight, columns, rows, labels, args };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

