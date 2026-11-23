import { z } from 'zod';

/**
 * Audio mixing and loudness settings shared by the manifest (`audio.*`), the
 * per-render `audio` option of render_project and the server defaults
 * (`render.audio.*`). docs/public/manifest/audio.md, D-1XX (#301, #298).
 */

/** Loudness presets: what a finished render is normalised to (two-pass loudnorm, verified after the AAC encode). */
export const LOUDNESS_PRESETS = ['social', 'broadcast-ebu', 'broadcast-atsc', 'podcast', 'off'] as const;
export type LoudnessPreset = (typeof LOUDNESS_PRESETS)[number];
export const loudnessPreset = z.enum(LOUDNESS_PRESETS);

export interface LoudnessTarget {
  /** Integrated loudness, LUFS (ITU-R BS.1770). */
  integrated: number;
  /** Maximum true peak after the final encode, dBTP. */
  truePeak: number;
  /**
   * Loudness range guidance, LU. Reported, never enforced: renders are not
   * range-compressed to meet it (EBU R 128 does not recommend LRA for
   * programmes under one minute, which most reels are).
   */
  lra: number;
  /** Allowed deviation of the integrated loudness, LU (the QA rule). */
  tolerance: number;
}

/**
 * Targets per preset (sources and dates in research/SOURCES.md, "Loudness").
 * `social` uses -2 dBTP rather than the -1 dBTP many platforms quote: platforms
 * transcode uploads again (AAC/Opus), which raises true peaks, and Spotify asks
 * for -2 dBTP for masters louder than -14 LUFS.
 */
export const LOUDNESS_TARGETS: Record<Exclude<LoudnessPreset, 'off'>, LoudnessTarget> = {
  social: { integrated: -14, truePeak: -2, lra: 11, tolerance: 1 },
  'broadcast-ebu': { integrated: -23, truePeak: -1, lra: 20, tolerance: 1 },
  'broadcast-atsc': { integrated: -24, truePeak: -2, lra: 20, tolerance: 1 },
  podcast: { integrated: -16, truePeak: -1, lra: 11, tolerance: 1 },
};

const gainDb = z.number().min(-60).max(12);

/** Per-bus gain in dB, applied after each track's own `volume`. */
export const audioBusGains = z
  .object({ voice: gainDb.optional(), music: gainDb.optional(), sfx: gainDb.optional() })
  .strict();

/** Which buses are mixed. Off keeps the track in the manifest but leaves it out of the render. */
export const audioToggles = z
  .object({ voice: z.boolean().optional(), music: z.boolean().optional(), sfx: z.boolean().optional() })
  .strict();

/** Ducking of the music under the voice: volume automation from the voice's speech segments. */
export const duckingSettings = z
  .object({
    /** How far the music goes down while someone speaks, dB. */
    depthDb: z.number().min(0).max(40).optional(),
    /** Ramp down, ms; starts this long before the speech (the voice is known in advance). */
    attackMs: z.number().int().min(5).max(2000).optional(),
    /** Ramp back up after the speech, ms. */
    releaseMs: z.number().int().min(20).max(5000).optional(),
    /** Voice level below which it counts as a pause, dBFS. */
    thresholdDb: z.number().min(-80).max(-10).optional(),
  })
  .strict();

export const DUCKING_DEFAULTS = { depthDb: 18, attackMs: 120, releaseMs: 400, thresholdDb: -40 } as const;
export type DuckingSettings = { depthDb: number; attackMs: number; releaseMs: number; thresholdDb: number };

/** `music.ducking`: true (defaults), false, or tuned settings. */
export const musicDucking = z.union([z.boolean(), duckingSettings]);

/** The ducking a music track asks for, with defaults filled in; null when off. */
export function resolveDucking(d: z.infer<typeof musicDucking> | undefined): DuckingSettings | null {
  if (!d) return null;
  return { ...DUCKING_DEFAULTS, ...(d === true ? {} : Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined))) };
}

/**
 * render_project's `audio` option: overrides the manifest for one render.
 * `mute` silences everything; `voice` / `music` / `sfx` switch a bus on or off.
 */
export const renderAudioOptions = z
  .object({
    mute: z.boolean().optional(),
    voice: z.boolean().optional(),
    music: z.boolean().optional(),
    sfx: z.boolean().optional(),
    loudness: loudnessPreset.optional(),
  })
  .strict();
export type RenderAudioOptions = z.infer<typeof renderAudioOptions>;
