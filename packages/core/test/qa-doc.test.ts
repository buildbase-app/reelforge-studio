import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BLACK_DETECT, FLASH_RULES, FREEZE_NOISE_DB } from '@renderweld/media-pipeline';
import { CAPTION_RULES, DUCKING_DEFAULTS, LOUDNESS_TARGETS, SAFE_AREA_SPEC, parseProject, resolveCaptions } from '@renderweld/project-schema';
import { SETTINGS_BY_KEY, captionSafeArea } from '../src/index';

/**
 * docs/QA.md (#313) states every check's threshold and its source. These tests hold the page to the code: a number
 * changed on one side only, a row without a date, or a row with neither a source link nor "Studio default" fails.
 */
const doc = readFileSync(new URL('../../../docs/QA.md', import.meta.url), 'utf8');
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));

/** Table rows (not header or divider rows) keyed by their first cell, backticks removed. */
const rows = new Map<string, string>();
for (const line of doc.split('\n')) {
  if (!line.startsWith('| ') || line.startsWith('| ---')) continue;
  const first = line.split('|')[1]!.trim().replace(/`/g, '');
  if (['Rule', 'Preset', 'Default'].includes(first)) continue;
  rows.set(first, line);
}
const row = (key: string) => {
  const r = rows.get(key);
  if (!r) throw new Error(`docs/QA.md has no row for "${key}"`);
  return r;
};
const pct = (fraction: number) => `${Math.round(fraction * 1000) / 10} %`;
const setting = (key: string) => SETTINGS_BY_KEY.get(key)!.default as number;

describe('docs/QA.md matches the code', () => {
  it('QAD-01 every row has a checked date and a source link or "Studio default"', () => {
    expect(rows.size).toBeGreaterThan(20);
    for (const [key, line] of rows) {
      const cells = line.split('|').map((c) => c.trim());
      expect(cells.at(-2), `${key}: last column is the date checked`).toMatch(/^20\d\d-\d\d-\d\d$/);
      expect(/https:\/\/|Studio default|Same (guide|source|sources)|General Requirements|structural check/.test(line), `${key}: names its source`).toBe(true);
    }
  });

  it('QAD-02 captions: every rule the check reports, with its limit', () => {
    expect(row('lineLength')).toContain(`default ${CAPTION_RULES.maxLineChars}`);
    expect(row('lineCount')).toContain(`at most ${CAPTION_RULES.maxLines} lines`);
    expect(row('readingSpeed')).toContain(`at most ${CAPTION_RULES.maxCharsPerSecond} characters per second`);
    expect(row('minDuration')).toContain(`at least ${CAPTION_RULES.minSeconds} s`);
    expect(row('maxDuration')).toContain(`at most ${CAPTION_RULES.maxSeconds} s`);
    expect(row('gap')).toContain(`at least ${CAPTION_RULES.minGapFrames} frames`);
    for (const rule of ['order', 'pastEnd']) row(rule);
    // The portrait default line length, as resolveCaptions applies it.
    const parsed = parseProject(sample);
    if (!parsed.ok) throw new Error('sample manifest is invalid');
    const portrait = resolveCaptions({ ...parsed.project, output: { ...parsed.project.output, width: 1080, height: 1920 } });
    expect(row('lineLength')).toContain(`or ${portrait.qa.rules.maxLineChars} on a portrait frame`);
    // The burned-in caption safe area.
    const tall = captionSafeArea(1000, 2000);
    const wide = captionSafeArea(2000, 1000);
    expect(row('caption safe area')).toContain(`portrait: ${pct(tall.top / 2000)} top, ${pct(tall.bottom / 2000)} bottom, ${pct(tall.left / 1000)} sides`);
    expect(row('caption safe area')).toContain(`other shapes: ${pct(wide.top / 1000)} on every side`);
  });

  it('QAD-03 loudness: each preset\'s target, tolerance, ceiling and range', () => {
    for (const [preset, t] of Object.entries(LOUDNESS_TARGETS)) {
      const cells = row(preset).split('|').map((c) => c.trim());
      expect(cells.slice(2, 6), preset).toEqual([`${t.integrated} LUFS`, `${t.tolerance} LU`, `${t.truePeak} dBTP`, `${t.lra} LU`]);
    }
    expect(doc).toContain(`render.audio.loudnessQa`);
    expect(SETTINGS_BY_KEY.get('render.audio.loudnessQa')).toBeDefined();
  });

  it('QAD-04 picture: the settings\' defaults, FFmpeg\'s levels and the flash rules', () => {
    expect(row('video.freeze')).toContain(`unchanged for ${setting('render.qa.freezeSeconds')} s or more; noise tolerance ${FREEZE_NOISE_DB} dB`);
    expect(row('video.black')).toContain(`black for ${setting('render.qa.blackSeconds')} s or more; a pixel at or under ${pct(BLACK_DETECT.pixelLuma)} luma is black, a picture when ${pct(BLACK_DETECT.pictureShare)} of it is`);
    const f = row('video.flash');
    expect(f).toContain(`more than ${FLASH_RULES.maxTransitionsPerSecond} transitions (three flashes) in any one second`);
    expect(f).toContain(`a change of at least ${FLASH_RULES.minLuminanceChange} in relative luminance with the darker side below ${FLASH_RULES.darkerBelow.toFixed(2)}`);
    expect(f).toContain(`saturated red (R/(R+G+B) at least ${FLASH_RULES.redRatio}) changes by more than ${FLASH_RULES.redChange} in (R-G-B) x ${FLASH_RULES.redScale}`);
    expect(f).toContain(`only flashing over ${pct(FLASH_RULES.minArea)} of the picture counts`);
    for (const key of ['render.qa.video', 'render.qa.freezeSeconds', 'render.qa.blackSeconds']) {
      expect(SETTINGS_BY_KEY.get(key), key).toBeDefined();
      expect(doc).toContain(key);
    }
  });

  it('QAD-05 layout defaults: safe areas and ducking', () => {
    expect(row('action safe area')).toContain(`${pct(SAFE_AREA_SPEC.action)} on every side`);
    expect(row('title safe area')).toContain(`${pct(SAFE_AREA_SPEC.title)} on every side`);
    const ui = SAFE_AREA_SPEC.ui;
    expect(row('app overlay zone (tall video)')).toContain(`${pct(ui.top)} top, ${pct(ui.bottom)} bottom, ${pct(ui.sides)} sides, for frames at least ${ui.minHeightOverWidth} times as tall as wide`);
    const d = DUCKING_DEFAULTS;
    expect(row('music ducking')).toContain(`${d.depthDb} dB under speech, ${d.attackMs} ms attack, ${d.releaseMs} ms release, speech above ${d.thresholdDb} dBFS`);
  });
});
