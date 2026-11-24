import { fpsArg, parseFrameRate } from '@reelforge/project-schema';

/**
 * A frame rate as the media pipeline takes it (#302): a number (30, or
 * 29.97002997 from fpsValue) or an exact "num/den" string ("30000/1001").
 * FFmpeg always gets the exact fraction, never a rounded decimal, so NTSC
 * output has r_frame_rate 30000/1001 and the frame counts match.
 */
export type Rate = number | string;

/** The rate as a number, for arithmetic (seconds = frames / value). */
export function rateValue(r: Rate): number {
  if (typeof r === 'number') return r;
  const m = /^(\d+)\/(\d+)$/.exec(r.trim());
  return m ? Number(m[1]) / Number(m[2]) : Number(r);
}

/** The rate as an FFmpeg argument: "30", "30000/1001". */
export function rateArg(r: Rate): string {
  if (typeof r === 'string') return r.trim();
  if (Number.isInteger(r)) return String(r);
  const known = parseFrameRate(r);
  return known !== null ? fpsArg(known) : String(r);
}

/** The rate reduced to lowest terms, as ffprobe prints r_frame_rate ("30/1", "30000/1001"). */
export function rateFraction(r: Rate): string {
  const arg = rateArg(r);
  const m = /^(\d+)\/(\d+)$/.exec(arg);
  let num = m ? Number(m[1]) : Number(arg);
  let den = m ? Number(m[2]) : 1;
  if (!Number.isInteger(num)) return arg;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(num, den);
  num /= g;
  den /= g;
  return `${num}/${den}`;
}
