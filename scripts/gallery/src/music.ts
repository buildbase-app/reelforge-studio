/**
 * Procedural music beds for the gallery reels. A tiny deterministic
 * synthesiser (no samples, no third-party audio): kick, hats, bass, a pad and
 * an arpeggio, in six moods. Same mood + length => byte-identical WAV, so the
 * files are reproducible and carry no licence questions (made by this script,
 * CC0-style "generated" provenance recorded on upload).
 */
import type { MusicId } from './catalog/build';

export const SAMPLE_RATE = 32000;

interface Mood {
  bpm: number;
  /** Chord roots in semitones from A (A=0), one per bar. */
  roots: number[];
  minor: boolean;
  kick: 'four' | 'half' | 'none';
  hats: boolean;
  arp: boolean;
  pad: number;
  bass: number;
  base: number;
}

const MOODS: Record<MusicId, Mood> = {
  pulse: { bpm: 118, roots: [0, -4, 3, -2], minor: true, kick: 'four', hats: true, arp: true, pad: 0.16, bass: 0.22, base: 220 },
  lofi: { bpm: 82, roots: [5, 3, 0, -2], minor: false, kick: 'half', hats: true, arp: false, pad: 0.2, bass: 0.18, base: 196 },
  drive: { bpm: 104, roots: [0, 5, 3, -2], minor: true, kick: 'four', hats: true, arp: true, pad: 0.14, bass: 0.26, base: 196 },
  ambient: { bpm: 70, roots: [0, -4, 5, 3], minor: false, kick: 'none', hats: false, arp: true, pad: 0.26, bass: 0.1, base: 220 },
  bright: { bpm: 124, roots: [0, 7, 9, 5], minor: false, kick: 'four', hats: true, arp: true, pad: 0.13, bass: 0.2, base: 261.63 },
  stomp: { bpm: 96, roots: [0, 0, 3, -2], minor: true, kick: 'four', hats: true, arp: false, pad: 0.1, bass: 0.3, base: 174.61 },
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const freq = (base: number, semis: number) => base * Math.pow(2, semis / 12);

/** Mono 16-bit PCM samples for `seconds` of the mood. */
export function synth(mood: MusicId, seconds: number): Int16Array {
  const m = MOODS[mood];
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(n);
  const beat = 60 / m.bpm;
  const bar = beat * 4;
  const noise = rng(1234);
  const third = m.minor ? 3 : 4;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const barIdx = Math.floor(t / bar);
    const root = m.roots[barIdx % m.roots.length]!;
    const tb = t % beat;
    const beatIdx = Math.floor(t / beat);
    let v = 0;
    // Pad: root, third, fifth, octave, slightly detuned, slow swell per bar.
    const tbar = t % bar;
    const swell = Math.min(1, tbar / 0.6) * (0.7 + 0.3 * Math.cos((tbar / bar) * Math.PI * 2));
    for (const [k, semi] of [0, third, 7, 12].entries()) {
      const f = freq(m.base, root + semi);
      v += (m.pad / 4) * swell * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.003 * t + k));
    }
    // Bass: root an octave down, on the beat, with a soft envelope.
    const bf = freq(m.base / 2, root);
    const benv = Math.exp(-tb * 3.2);
    v += m.bass * benv * (Math.sin(2 * Math.PI * bf * t) + 0.3 * Math.sin(4 * Math.PI * bf * t));
    // Kick: pitch-dropping sine.
    const kickHere = m.kick === 'four' || (m.kick === 'half' && beatIdx % 2 === 0);
    if (kickHere && tb < 0.35) {
      const kf = 45 + 110 * Math.exp(-tb * 28);
      v += 0.55 * Math.exp(-tb * 9) * Math.sin(2 * Math.PI * kf * tb);
    }
    // Hats: short noise bursts on the off-beats.
    if (m.hats) {
      const th = (t + beat / 2) % beat;
      if (th < 0.05) v += 0.06 * Math.exp(-th * 90) * (noise() * 2 - 1);
    } else noise();
    // Arp: eighth notes over the chord.
    if (m.arp) {
      const e = beat / 2;
      const ti = Math.floor(t / e);
      const te = t % e;
      const notes = [0, third, 7, 12, 7, third];
      const af = freq(m.base * 2, root + notes[ti % notes.length]!);
      v += 0.07 * Math.exp(-te * 7) * Math.sin(2 * Math.PI * af * t) * (1 + 0.3 * Math.sin(2 * Math.PI * af * 2 * t));
    }
    out[i] = v;
  }
  // Fade in/out and normalise to -3 dBFS.
  const fadeIn = Math.min(n, Math.round(0.4 * SAMPLE_RATE));
  const fadeOut = Math.min(n, Math.round(1.2 * SAMPLE_RATE));
  for (let i = 0; i < fadeIn; i++) out[i]! *= i / fadeIn;
  for (let i = 0; i < fadeOut; i++) out[n - 1 - i]! *= i / fadeOut;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!));
  const gain = peak > 0 ? 0.707 / peak : 1;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(out[i]! * gain * 32767)));
  return pcm;
}

/** A WAV file (RIFF, PCM 16-bit mono). */
export function wav(pcm: Int16Array, sampleRate = SAMPLE_RATE): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export function musicWav(mood: MusicId, seconds: number): Buffer {
  return wav(synth(mood, seconds));
}

export const MUSIC_LICENSE = {
  name: 'CC0-1.0',
  source: 'generated by scripts/gallery/src/music.ts (procedural synthesis, no samples)',
  author: 'RenderWeld gallery pipeline',
  redistributable: true,
};
