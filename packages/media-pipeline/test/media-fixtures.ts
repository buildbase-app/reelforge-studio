import { run } from '../src/ffmpeg';

/**
 * Tiny synthetic media for asset tests (#299), shared by the engine and
 * server tests: a clip that shows its own frame number, a picture with known
 * colour patches, a tone, and helpers that read pixels back out of a render.
 */

/** Bits of the frame number a numbered clip shows, as vertical bars (least significant on the left). */
export const CLIP_BITS = 10;

/**
 * A clip whose frame n shows n in binary: CLIP_BITS vertical bars across the
 * full width, white for a 1 and black for a 0. `fps` may be a fraction
 * ("30000/1001"). Read it back with `readBars`.
 */
export async function makeNumberedClip(ffmpeg: string, file: string, o: { fps: string | number; frames: number; width?: number; height?: number }): Promise<string> {
  const w = o.width ?? 320;
  const h = o.height ?? 180;
  const bar = w / CLIP_BITS;
  await run(
    ffmpeg,
    [
      '-hide_banner',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=black:s=${w}x${h}:r=${o.fps}`,
      '-vf',
      `geq=lum='if(gt(mod(floor(N/pow(2\\,floor(X/${bar})))\\,2)\\,0.5)\\,235\\,16)':cb=128:cr=128`,
      '-frames:v',
      String(o.frames),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '48',
      file,
    ],
    'fixture-clip'
  );
  return file;
}

/** The four colours of `makeQuadImage`, clockwise from the top left. */
export const QUAD = { tl: [230, 30, 30], tr: [30, 200, 60], br: [40, 70, 230], bl: [240, 210, 20] } as const;

/** A picture split into four flat colour quadrants (QUAD), as PNG (or any format by extension). */
export async function makeQuadImage(ffmpeg: string, file: string, w = 200, h = 100): Promise<string> {
  const c = (rgb: readonly number[]) => `0x${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const hw = w / 2;
  const hh = h / 2;
  await run(
    ffmpeg,
    [
      '-hide_banner',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=${c(QUAD.tl)}:s=${w}x${h}`,
      '-vf',
      `drawbox=x=${hw}:y=0:w=${hw}:h=${hh}:color=${c(QUAD.tr)}:t=fill,drawbox=x=${hw}:y=${hh}:w=${hw}:h=${hh}:color=${c(QUAD.br)}:t=fill,drawbox=x=0:y=${hh}:w=${hw}:h=${hh}:color=${c(QUAD.bl)}:t=fill`,
      '-frames:v',
      '1',
      file,
    ],
    'fixture-image'
  );
  return file;
}

/** A sine tone (an audio bed). */
export async function makeTone(ffmpeg: string, file: string, seconds: number, hz = 440): Promise<string> {
  await run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}`, '-c:a', 'aac', '-b:a', '64k', file], 'fixture-tone');
  return file;
}

export interface Picture {
  width: number;
  height: number;
  rgb: Buffer;
  at(x: number, y: number): [number, number, number];
}

/** Frame `index` of a video (or a still picture) as RGB pixels. */
export async function readPicture(ffmpeg: string, file: string, index: number, size: { width: number; height: number }): Promise<Picture> {
  const { stdout } = await runBinary(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-vf', `select=eq(n\\,${index})`, '-vsync', '0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  if (stdout.length !== size.width * size.height * 3) throw new Error(`frame ${index} of ${file}: ${stdout.length} bytes, expected ${size.width * size.height * 3}`);
  return {
    ...size,
    rgb: stdout,
    at(x, y) {
      const i = (Math.round(y) * size.width + Math.round(x)) * 3;
      return [stdout[i]!, stdout[i + 1]!, stdout[i + 2]!];
    },
  };
}

/** Every frame of a video (or an image sequence pattern such as dir/%06d.jpg) as RGB pixels, in one FFmpeg run. */
export async function readPictures(ffmpeg: string, input: string, size: { width: number; height: number }): Promise<Picture[]> {
  const { stdout } = await runBinary(ffmpeg, ['-hide_banner', '-v', 'error', ...(input.includes('%') ? ['-framerate', '1'] : []), '-i', input, '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const n = size.width * size.height * 3;
  const out: Picture[] = [];
  for (let o = 0; o + n <= stdout.length; o += n) {
    const rgb = stdout.subarray(o, o + n);
    out.push({ ...size, rgb, at: (x, y) => { const i = (Math.round(y) * size.width + Math.round(x)) * 3; return [rgb[i]!, rgb[i + 1]!, rgb[i + 2]!]; } });
  }
  return out;
}

/** Mean colour of a w x h box centred on (cx, cy). */
export function meanColor(p: Picture, cx: number, cy: number, r = 3): [number, number, number] {
  const sum: [number, number, number] = [0, 0, 0];
  let n = 0;
  for (let y = Math.round(cy - r); y <= Math.round(cy + r); y++) {
    for (let x = Math.round(cx - r); x <= Math.round(cx + r); x++) {
      const c = p.at(x, y);
      sum[0] += c[0];
      sum[1] += c[1];
      sum[2] += c[2];
      n++;
    }
  }
  return sum.map((v) => Math.round(v / n)) as [number, number, number];
}

/** Largest per-channel difference between two colours. */
export function colorDistance(a: readonly number[], b: readonly number[]): number {
  return Math.max(...a.map((v, i) => Math.abs(v - (b[i] ?? 0))));
}

/** The number a numbered clip shows inside `rect` of a picture (bars read at mid-height). */
export function readBars(p: Picture, rect: { x: number; y: number; width: number; height: number }): number {
  let n = 0;
  const bar = rect.width / CLIP_BITS;
  for (let b = 0; b < CLIP_BITS; b++) {
    const [r, g, bl] = meanColor(p, rect.x + bar * (b + 0.5), rect.y + rect.height / 2, Math.max(1, Math.min(bar / 4, rect.height / 4)));
    if ((r + g + bl) / 3 > 128) n |= 1 << b;
  }
  return n;
}

function runBinary(bin: string, args: string[]): Promise<{ stdout: Buffer }> {
  return import('node:child_process').then(
    ({ spawn }) =>
      new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const out: Buffer[] = [];
        let err = '';
        child.stdout.on('data', (d: Buffer) => out.push(d));
        child.stderr.on('data', (d) => (err += d));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve({ stdout: Buffer.concat(out) }) : reject(new Error(`${bin} exited ${code}: ${err.slice(-500)}`))));
      })
  );
}

/** Share of the pixels in `rect` (default: the whole picture) within `tolerance` of `color` per channel: how much text of that colour is drawn. */
export function inkRatio(p: Picture, color: readonly number[], rect = { x: 0, y: 0, width: p.width, height: p.height }, tolerance = 60): number {
  let hit = 0;
  let n = 0;
  for (let y = Math.round(rect.y); y < Math.round(rect.y + rect.height); y++) {
    for (let x = Math.round(rect.x); x < Math.round(rect.x + rect.width); x++) {
      const c = p.at(x, y);
      n++;
      if (Math.abs(c[0] - color[0]!) <= tolerance && Math.abs(c[1] - color[1]!) <= tolerance && Math.abs(c[2] - color[2]!) <= tolerance) hit++;
    }
  }
  return n ? hit / n : 0;
}

/** The tiny test fonts (packages/core/test/fixtures/fonts, made by make-fonts.py): every glyph of "RF Block" is a solid box. */
export const TEST_FONTS = new URL('../../core/test/fixtures/fonts/', import.meta.url).pathname;
