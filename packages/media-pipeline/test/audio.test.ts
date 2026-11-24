import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assemble,
  assertAudioSupport,
  checkAvSync,
  concatClips,
  mergeWindows,
  measureEbur128,
  measureLoudness,
  mixAudio,
  normaliseClip,
  normaliseLoudness,
  probe,
  resolveTools,
  run,
  speechSegments,
  type LoudnessTarget,
  type Tools,
} from '../src/index';

// Synthetic signals only (sines, filtered noise): the tests measure loudness, ducking depth, clicks and A/V sync of
// real FFmpeg output (#301). Files are a few seconds long and live in one temp directory removed at the end.
let dir: string;
let tools: Tools;
const SR = 48000;

beforeAll(() => {
  tools = resolveTools();
  dir = mkdtempSync(join(tmpdir(), 'reelforge-audio-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stereo WAV (both channels the source's first, at full level) from a lavfi source and filter chain. */
async function wav(name: string, source: string, filter = 'anull') {
  const file = join(dir, name);
  await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', source, '-af', `${filter},pan=stereo|c0=c0|c1=c0,aformat=sample_rates=48000`, '-c:a', 'pcm_f32le', file], 'fixture');
  return file;
}

async function clip(name: string, frames: number, fps = 30) {
  const file = join(dir, name);
  await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=160x284:rate=${fps}`, '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file], 'fixture');
  return file;
}

/** Decoded samples of the first channel between two times (any input FFmpeg reads, AAC in MP4 included). */
function samples(file: string, from = 0, to?: number): Float32Array {
  const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-af', `pan=mono|c0=c0,atrim=start=${from}${to !== undefined ? `:end=${to}` : ''}`, '-f', 'f32le', '-ar', String(SR), '-'], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/** Largest sample-to-sample step: a click is a jump far above what the content itself makes. */
function maxJump(x: Float32Array): number {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
  return m;
}

/** Amplitude of one frequency (Goertzel) in dB re full scale. */
function toneDb(x: Float32Array, freq: number): number {
  const k = (2 * Math.PI * freq) / SR;
  const c = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (const v of x) {
    const s0 = v + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - c * s1 * s2;
  return 20 * Math.log10((2 * Math.sqrt(power)) / x.length);
}

const SOCIAL: LoudnessTarget = { integrated: -14, truePeak: -2, lra: 11 };

/** A loud "music" bed (two tones and pink noise) and a "voice" of band-limited noise bursts, like today's renders. */
async function loudMix() {
  const music = await wav('music.wav', 'aevalsrc=0.5*sin(2*PI*220*t)+0.3*sin(2*PI*330*t):s=48000:d=6');
  const voice = await wav('voice.wav', 'anoisesrc=d=6:c=pink:a=0.9', "highpass=f=1500,highpass=f=1500,lowpass=f=6000,volume='if(between(t,1,2)+between(t,3.5,4.5),1.6,0)':eval=frame");
  return { music, voice };
}

describe('loudness normalisation (two-pass loudnorm, verified after the AAC encode)', () => {
  it('AUD-1 brings a loud mix to each preset: integrated within 1 LU after the final AAC encode, true peak under the ceiling', async () => {
    const { music, voice } = await loudMix();
    const mix = join(dir, 'mix.wav');
    await mixAudio({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, out: mix, totalSeconds: 6, music: { file: music, volume: 1 }, voice: { file: voice, volume: 1, startSeconds: 0 } });
    const before = await measureLoudness(tools.ffmpeg, mix);
    // The problem (#301): an un-normalised mix is far above every target.
    expect(before.integrated!).toBeGreaterThan(-12);
    const video = await clip('v180.mp4', 180);
    const presets: Array<[string, LoudnessTarget]> = [
      ['social', SOCIAL],
      ['broadcast-ebu', { integrated: -23, truePeak: -1, lra: 20 }],
      ['podcast', { integrated: -16, truePeak: -1, lra: 11 }],
    ];
    for (const [name, target] of presets) {
      const norm = await normaliseLoudness({ ffmpeg: tools.ffmpeg, input: mix, out: join(dir, `norm-${name}.wav`), target, measured: before });
      const out = join(dir, `final-${name}.mp4`);
      await assemble({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, clips: [{ sceneId: 's', file: video, frames: 180 }], out, width: 160, height: 284, fps: 30, audioFile: norm.out });
      const after = await measureEbur128(tools.ffmpeg, out);
      expect(Math.abs(after.integrated! - target.integrated), `${name}: ${after.integrated} LUFS`).toBeLessThanOrEqual(1);
      expect(after.truePeak!, `${name}: ${after.truePeak} dBTP`).toBeLessThanOrEqual(target.truePeak);
      expect(after.lra).not.toBeNull();
      expect((await probe(tools.ffprobe, out)).audioCodec).toBe('aac');
    }
  }, 120_000);

  // #449: a quiet bed with short loud sound effects. Their true peak leaves no room for the gain the target needs,
  // and loudnorm's dynamic mode came out about 2 LU under the target; a denser bed came out over the ceiling.
  const SFX_MIXES: Array<{ name: string; source: string }> = [
    // A soft pad (three sines, about -31 dBFS) and an 8 ms 2 kHz click near full scale every 1.7 s, 40 s.
    { name: 'pad-clicks', source: "aevalsrc='0.03*sin(2*PI*220*t)+0.02*sin(2*PI*277*t)+0.02*sin(2*PI*330*t)+if(lt(mod(t,1.7),0.008),0.95*sin(2*PI*2000*t),0)':s=48000:d=40" },
    // A driving bed (a 110 Hz pulse and a chord) and a short 3 kHz hit near full scale every 0.6 s, 20 s.
    { name: 'bed-hits', source: "aevalsrc='(0.12+0.08*gt(mod(t,0.5),0.25))*sin(2*PI*110*t)+0.06*sin(2*PI*440*t)+0.05*sin(2*PI*554*t)+if(lt(mod(t,0.6),0.004),0.9*sin(2*PI*3000*t),0)':s=48000:d=20" },
  ];

  it('AUD-16 a quiet bed with loud short clicks reaches every preset within 1 LU, true peak under the ceiling, after the AAC encode (true-peak limiter)', async () => {
    const presets: Array<[string, LoudnessTarget]> = [
      ['social', SOCIAL],
      ['broadcast-ebu', { integrated: -23, truePeak: -1, lra: 20 }],
      ['podcast', { integrated: -16, truePeak: -1, lra: 11 }],
    ];
    for (const fixture of SFX_MIXES) {
      const mix = await wav(`${fixture.name}.wav`, fixture.source);
      const before = await measureLoudness(tools.ffmpeg, mix);
      const seconds = fixture.name === 'pad-clicks' ? 40 : 20;
      const video = await clip(`${fixture.name}.mp4`, seconds * 30);
      for (const [name, target] of presets) {
        const where = `${fixture.name} -> ${name}`;
        const norm = await normaliseLoudness({ ffmpeg: tools.ffmpeg, input: mix, out: join(dir, `lim-${fixture.name}-${name}.wav`), target, measured: before });
        const out = join(dir, `lim-${fixture.name}-${name}.mp4`);
        await assemble({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, clips: [{ sceneId: 's', file: video, frames: seconds * 30 }], out, width: 160, height: 284, fps: 30, audioFile: norm.out });
        const after = await measureEbur128(tools.ffmpeg, out);
        expect(Math.abs(after.integrated! - target.integrated), `${where}: ${after.integrated} LUFS`).toBeLessThanOrEqual(1);
        expect(after.truePeak!, `${where}: ${after.truePeak} dBTP`).toBeLessThanOrEqual(target.truePeak);
        expect((await checkAvSync(tools.ffprobe, out, 30)).problems, where).toEqual([]);
        if (before.truePeak! + (target.integrated - before.integrated!) > target.truePeak - 0.5) {
          // One gain would break the ceiling: limited, the gain corrected after limiting.
          expect(norm.type, where).toBe('limited');
          expect(norm.limiter!.ceilingDb, where).toBeCloseTo(target.truePeak - 0.8, 5);
          expect(norm.gainDb, where).toBeGreaterThan(target.integrated - before.integrated!);
        }
      }
    }
  }, 300_000);

  it('AUD-17 the limiter keeps the audio in place and its length: no delay, no tail cut', async () => {
    // A noise pad (a unique waveform, so its lag is unambiguous) with clicks at 1.0 s and 2.99 s, 3 s long.
    const mix = await wav('clicks-at.wav', "anoisesrc=d=3:c=pink:a=0.03:seed=7", "volume='1+30*(between(t,1,1.004)+between(t,2.99,2.994))':eval=frame");
    const before = await measureLoudness(tools.ffmpeg, mix);
    const norm = await normaliseLoudness({ ffmpeg: tools.ffmpeg, input: mix, out: join(dir, 'clicks-at-lim.wav'), target: SOCIAL, measured: before });
    expect(norm.type).toBe('limited');
    const x = samples(norm.out);
    const src = samples(mix);
    expect(x.length).toBe(src.length);
    // The lag that best lines the output up with the input, away from the clicks: 0 (the limiter's delay is compensated).
    const from = Math.round(1.5 * SR);
    const n = Math.round(0.5 * SR);
    let best = { lag: NaN, c: -Infinity };
    for (let lag = -400; lag <= 400; lag++) {
      let c = 0;
      for (let i = from; i < from + n; i++) c += src[i]! * x[i + lag]!;
      if (c > best.c) best = { lag, c };
    }
    expect(best.lag).toBe(0);
    // The click 10 ms before the end is still there, limited like the one at 1 s (never above the -2.8 dBTP ceiling, 0.72).
    const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const first = peak(x.subarray(Math.round(0.99 * SR), Math.round(1.02 * SR))) / peak(src.subarray(Math.round(0.99 * SR), Math.round(1.02 * SR)));
    const last = peak(x.subarray(Math.round(2.99 * SR))) / peak(src.subarray(Math.round(2.99 * SR)));
    expect(last).toBeGreaterThan(first * 0.8);
    expect(peak(x)).toBeLessThan(0.75);
  }, 60_000);

  it('AUD-2 measures silence as null instead of failing', async () => {
    const silent = await wav('silent.wav', 'anullsrc=r=48000:cl=stereo', 'atrim=end=2');
    const m = await measureLoudness(tools.ffmpeg, silent);
    expect(m.integrated).toBeNull();
    expect(m.truePeak).toBeNull();
    expect((await measureEbur128(tools.ffmpeg, silent)).integrated).toBeNull();
  });
});

describe('mixing: ducking, fades, buses', () => {
  it('AUD-3 ducks the music by the configured depth inside the speech windows and leaves it alone outside them', async () => {
    // Music: a 220 Hz tone. Voice: noise above 1.5 kHz (it adds nothing at 220 Hz), speech at 1-2 s and 3.5-4.5 s.
    const { music, voice } = await loudMix();
    const speech = await speechSegments(tools.ffmpeg, voice, { thresholdDb: -40 });
    expect(speech.length).toBe(2);
    expect(speech[0]![0]).toBeCloseTo(1, 1);
    expect(speech[1]![1]).toBeCloseTo(4.5, 1);
    const mix = (out: string, depthDb: number, withVoice = true) =>
      mixAudio({
        ffmpeg: tools.ffmpeg,
        ffprobe: tools.ffprobe,
        out: join(dir, out),
        totalSeconds: 6,
        music: { file: music, volume: 1, fadeInSeconds: 0 },
        voice: withVoice ? { file: voice, volume: 1 } : null,
        ducking: depthDb ? { depthDb, attackMs: 120, releaseMs: 400, windows: speech } : null,
      });
    const flat = (await mix('flat.wav', 0)).out;
    const ducked = (await mix('ducked.wav', 18)).out;
    const level = (f: string, a: number, b: number) => toneDb(samples(f, a, b), 220);
    // Inside speech (from its first moment: the ramp ends where speech starts) the music is 18 dB down.
    for (const [a, b] of [[1.0, 1.1], [1.3, 1.9], [3.6, 4.4]] as const) {
      expect(level(flat, a, b) - level(ducked, a, b), `window ${a}-${b}`).toBeGreaterThan(16.5);
      expect(level(flat, a, b) - level(ducked, a, b), `window ${a}-${b}`).toBeLessThan(19.5);
    }
    // Between the windows (after the release, before the next attack) and after the last one: untouched.
    for (const [a, b] of [[2.6, 3.2], [5.1, 5.6]] as const) expect(Math.abs(level(flat, a, b) - level(ducked, a, b))).toBeLessThan(0.5);
    // The ramps are smooth: the ducked music alone (same windows, voice left out) never steps more than the tones do.
    const musicOnly = (await mix('ducked-music.wav', 18, false)).out;
    const steady = maxJump(samples(flat, 2.6, 3.2));
    expect(maxJump(samples(musicOnly, 0.5, 5.5))).toBeLessThan(steady * 1.5);
  }, 60_000);

  it('AUD-4 applies bus gains in dB and fades the music in and out', async () => {
    const tone = await wav('tone.wav', 'aevalsrc=0.5*sin(2*PI*440*t):s=48000:d=4');
    const out = (await mixAudio({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, out: join(dir, 'bus.wav'), totalSeconds: 3, music: { file: tone, volume: 1, fadeInSeconds: 0.5, fadeOutSeconds: 0.5 }, gainDb: { music: -6 } })).out;
    expect(toneDb(samples(out, 1, 2), 440)).toBeCloseTo(20 * Math.log10(0.5) - 6, 0);
    expect(toneDb(samples(out, 0, 0.05), 440)).toBeLessThan(-30);
    expect(toneDb(samples(out, 2.95, 3), 440)).toBeLessThan(-30);
  });

  it('AUD-5 never clicks: not where a sound effect or the voice starts or stops on a non-zero sample, not at scene joins (assemble and the fan-out join)', async () => {
    // Every fixture starts or ends at full amplitude (cosines): without edge fades each edge is a ~0.8 jump.
    const music = await wav('bed.wav', 'aevalsrc=0.3*cos(2*PI*110*t):s=48000:d=4');
    const sfx = await wav('hit.wav', 'aevalsrc=0.8*cos(2*PI*200*t):s=48000:d=0.3');
    const voice = await wav('vo.wav', 'aevalsrc=0.8*cos(2*PI*300*t):s=48000:d=0.5');
    const mix = join(dir, 'edges.wav');
    await mixAudio({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, out: mix, totalSeconds: 3, music: { file: music, volume: 1, fadeInSeconds: 0 }, voice: { file: voice, volume: 1, startSeconds: 1.8 }, sfx: [{ file: sfx, volume: 1, atSeconds: 1 }] });
    // Two scenes of 30 frames: the join is at 1.0 s, where the sound effect starts.
    const a = await clip('j1.mp4', 30);
    const b = await clip('j2.mp4', 60);
    const single = join(dir, 'joined-assemble.mp4');
    await assemble({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, clips: [{ sceneId: 'a', file: a, frames: 30 }, { sceneId: 'b', file: b, frames: 60 }], out: single, width: 160, height: 284, fps: 30, audioFile: mix });
    const na = join(dir, 'n1.mp4');
    const nb = join(dir, 'n2.mp4');
    await normaliseClip({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, input: a, out: na, width: 160, height: 284, fps: 30, frames: 30 });
    await normaliseClip({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, input: b, out: nb, width: 160, height: 284, fps: 30, frames: 60 });
    const fanout = join(dir, 'joined-concat.mp4');
    await concatClips({ ffmpeg: tools.ffmpeg, clips: [{ file: na, frames: 30 }, { file: nb, frames: 60 }], out: fanout, fps: 30, listFile: join(dir, 'list.txt'), audioFile: mix });
    // The steadiest content step: the loudest tone (0.8 at 300 Hz) plus the bed.
    const steady = 0.8 * ((2 * Math.PI * 300) / SR) + 0.3 * ((2 * Math.PI * 110) / SR);
    for (const file of [mix, single, fanout]) {
      for (const at of [1.0, 1.3, 1.8, 2.3]) {
        expect(maxJump(samples(file, at - 0.02, at + 0.02)), `${file} at ${at}s`).toBeLessThan(steady * 2);
      }
      // The master fades: the file starts and ends at silence, so a looping player does not click either.
      const x = samples(file);
      expect(Math.abs(x[0]!)).toBeLessThan(0.01);
      expect(Math.abs(x[x.length - 1]!)).toBeLessThan(0.01);
    }
  }, 60_000);

  it('merges speech windows closer than attack + release', () => {
    expect(mergeWindows([[3, 4], [0, 1], [1.2, 2]], 0.5)).toEqual([[0, 2], [3, 4]]);
  });
});

describe('A/V sync and muted output', () => {
  it('AUD-6 a render starts its audio at 0 and ends it within one frame of the video; offsets and short audio are reported', async () => {
    const v = await clip('sync.mp4', 60);
    const tone = await wav('sync.wav', 'sine=f=440:d=2');
    // (sine is at 1/8 of full scale; the level does not matter here.)
    const good = join(dir, 'sync-good.mp4');
    await assemble({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, clips: [{ sceneId: 's', file: v, frames: 60 }], out: good, width: 160, height: 284, fps: 30, audioFile: tone });
    const ok = await checkAvSync(tools.ffprobe, good, 30);
    expect(ok.problems).toEqual([]);
    expect(ok.audioStart).toBe(0);
    expect(Math.abs(ok.audioDuration! - ok.videoDuration)).toBeLessThanOrEqual(1 / 30);
    // Audio delayed by 100 ms in the container, and audio half a second short.
    const late = join(dir, 'sync-late.mp4');
    await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', good, '-itsoffset', '0.1', '-i', good, '-map', '0:v', '-map', '1:a', '-c', 'copy', late], 'fixture');
    expect((await checkAvSync(tools.ffprobe, late, 30)).problems.join(' ')).toMatch(/audio starts \d+\.\d ms after the video/);
    const short = join(dir, 'sync-short.mp4');
    await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', good, '-map', '0:v', '-map', '0:a', '-c:v', 'copy', '-c:a', 'aac', '-af', 'atrim=end=1.5', short], 'fixture');
    expect((await checkAvSync(tools.ffprobe, short, 30)).problems.join(' ')).toMatch(/audio is .* shorter than the video/);
  }, 60_000);

  it('AUD-7 a muted render can have no audio stream at all', async () => {
    const v = await clip('mute.mp4', 30);
    const out = join(dir, 'mute-out.mp4');
    await assemble({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, clips: [{ sceneId: 's', file: v, frames: 30 }], out, width: 160, height: 284, fps: 30, noAudio: true });
    expect((await probe(tools.ffprobe, out)).hasAudio).toBe(false);
  });
});

describe('FFmpeg versions (the release image has Debian bookworm FFmpeg 5.1)', () => {
  it('AUD-8 assemble() muxes the audio in its own pass, without the video frame limit that cuts audio short on FFmpeg 5.1', async () => {
    const v = await clip('v51.mp4', 60);
    const tone = await wav('t51.wav', 'aevalsrc=0.5*sin(2*PI*440*t):s=48000:d=2');
    const out = join(dir, 'v51-out.mp4');
    const r = await assemble({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, clips: [{ sceneId: 's', file: v, frames: 60 }], out, width: 160, height: 284, fps: 30, audioFile: tone });
    const split = r.args.indexOf('&&');
    expect(split).toBeGreaterThan(0);
    const [video, mux] = [r.args.slice(0, split), r.args.slice(split + 1)];
    expect(video).toContain('-an');
    expect(video).toContain('-frames:v');
    expect(mux).not.toContain('-frames:v');
    expect(mux.join(' ')).toContain('-c:v copy');
    const sync = await checkAvSync(tools.ffprobe, out, 30);
    expect(sync.problems).toEqual([]);
    expect(sync.audioDuration).toBeCloseTo(2, 3);
  }, 60_000);

  it('AUD-9 the audio capability probe passes on this FFmpeg and names what a build lacks, with the fix', async () => {
    await expect(assertAudioSupport(tools.ffmpeg)).resolves.toBeUndefined();
    // A stand-in FFmpeg without loudnorm and ebur128.
    const fake = join(dir, 'ffmpeg-without-loudness');
    writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do case "$a" in *loudnorm*|*ebur128*) echo "No such filter: \'$a\'" >&2; exit 1;; esac; done\nexit 0\n');
    chmodSync(fake, 0o755);
    const err = await assertAudioSupport(fake).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/cannot run the audio pipeline: loudnorm \(measure\).*loudnorm \(linear.*ebur128 true peak.*Install FFmpeg 5\.1 or newer/);
    expect(err?.message).not.toMatch(/silencedetect|amix/);
  });
});
