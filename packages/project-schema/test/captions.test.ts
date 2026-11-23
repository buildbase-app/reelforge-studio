import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  breakLines,
  buildCuesFromText,
  buildCuesFromWords,
  checkCaptions,
  CaptionParseError,
  formatSrt,
  formatTimestamp,
  formatVtt,
  migrate,
  parseCaptions,
  parseProject,
  parseSrt,
  parseVtt,
  resolveCaptions,
  type CaptionCue,
} from '../src/index';

const sampleV01 = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8')) as Record<string, unknown>;
function v02(): any {
  const r = migrate(sampleV01);
  if (!r.ok) throw new Error('sample must migrate');
  return structuredClone(r.manifest) as any;
}
function parsed(m: unknown) {
  const r = parseProject(m);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r;
}

describe('line breaker', () => {
  it('keeps text that fits on one line', () => {
    expect(breakLines('  Short   and sweet. ', 42)).toEqual(['Short and sweet.']);
  });

  it('breaks after punctuation rather than in the middle', () => {
    expect(breakLines('Every reel ships on time, and the client sees it first.', 42)).toEqual(['Every reel ships on time,', 'and the client sees it first.']);
  });

  it('avoids one or two words on the top line', () => {
    expect(breakLines('So we rendered every single scene again tonight', 30)).toEqual(['So we rendered every', 'single scene again tonight']);
  });

  it('never ends a line with an article', () => {
    // The most even split would be "Pick up the" / "phone and call me back now"... "the" must stay with its noun.
    for (const [text, max] of [
      ['We will call the office tomorrow morning', 24],
      ['She opened a window to the garden', 20],
      ['They saw the bright red balloons float away', 26],
    ] as const) {
      const lines = breakLines(text, max);
      expect(lines.length).toBe(2);
      expect(lines[0]).not.toMatch(/\b(a|an|the)$/i);
      lines.forEach((l) => expect(l.length).toBeLessThanOrEqual(max));
    }
  });

  it('prefers to start the second line with a conjunction or preposition', () => {
    expect(breakLines('Pick up the phone and call the best team in town', 32)).toEqual(['Pick up the phone', 'and call the best team in town']);
  });

  it('keeps author line breaks and wraps text that cannot fit in two lines', () => {
    expect(breakLines('First line\nsecond  line', 42)).toEqual(['First line', 'second line']);
    const long = breakLines('one two three four five six seven eight nine ten eleven twelve', 16);
    expect(long.length).toBeGreaterThan(2);
    long.forEach((l) => expect(l.length).toBeLessThanOrEqual(16));
  });
});

describe('quality rules', () => {
  const cue = (start: number, end: number, text: string): CaptionCue => ({ start, end, text });

  it('passes cues inside every limit', () => {
    const qa = checkCaptions([cue(0, 2, 'Hello there.'), cue(2.1, 4, 'General Kenobi.')], { fps: 30 });
    expect(qa.ok).toBe(true);
    expect(qa.issues).toEqual([]);
    expect(qa.maxCps).toBeCloseTo(15 / 1.9, 1);
  });

  it('reports reading speed above 20 characters per second', () => {
    const qa = checkCaptions([cue(0, 1, 'This sentence is far too long to read in a second.')], { fps: 30 });
    expect(qa.issues.map((i) => i.rule)).toContain('readingSpeed');
    expect(qa.maxCps).toBe(50);
    // exactly 20 cps is allowed
    expect(checkCaptions([cue(0, 1, 'x'.repeat(20))], { fps: 30 }).issues.filter((i) => i.rule === 'readingSpeed')).toEqual([]);
  });

  it('reports durations outside 0.833-7 s, short gaps, overlaps, order and cues past the end', () => {
    const qa = checkCaptions(
      [cue(0, 0.5, 'Hi.'), cue(0.55, 8, 'A slow one.'), cue(7.9, 9, 'Overlap.'), cue(9.04, 10, 'One frame.'), cue(9, 12, 'Back.')],
      { fps: 25, endSeconds: 11 }
    );
    const rules = qa.issues.map((i) => `${i.cue}:${i.rule}`);
    expect(rules).toEqual(expect.arrayContaining(['0:minDuration', '0:gap', '1:maxDuration', '1:gap', '2:gap', '3:order', '4:pastEnd']));
    expect(qa.ok).toBe(false);
    // exactly two frames is enough
    expect(checkCaptions([cue(0, 1, 'One.'), cue(1 + 2 / 25, 2, 'Two.')], { fps: 25 }).ok).toBe(true);
  });

  it('reports lines over the limit and more than two lines', () => {
    const qa = checkCaptions([cue(0, 6, 'Supercalifragilisticexpialidocious-and-more-of-it'), cue(7, 14, 'one two three four five six seven eight nine ten eleven twelve thirteen')], {
      fps: 30,
      maxLineChars: 20,
    });
    expect(qa.issues.map((i) => `${i.cue}:${i.rule}`)).toEqual(expect.arrayContaining(['0:lineLength', '1:lineCount']));
  });
});

describe('cues from word timestamps', () => {
  const words = 'Hello there. ReelForge renders your reels on your own server, with captions that follow the voice.'.split(' ').map((text, i) => ({ text, start: i * 0.4, end: i * 0.4 + 0.3 }));

  it('splits at sentence ends and the character limit, shifted by the voice start', () => {
    const cues = buildCuesFromWords(words, { maxCharsPerCue: 40, fps: 30, offsetSeconds: 2 });
    expect(cues.map((c) => c.text)).toEqual(['Hello there.', 'ReelForge renders your reels on your own', 'server, with captions that follow', 'the voice.']);
    expect(cues[0]!.start).toBe(2);
    expect(cues[0]!.words![1]).toEqual({ text: 'there.', start: 2.4, end: 2.7 });
    // "Hello there." is followed at once by more speech: it cannot stay 0.833 s without delaying the next cue, and QA says so.
    expect(checkCaptions(cues, { fps: 30, maxLineChars: 32 }).issues.map((i) => `${i.cue}:${i.rule}`)).toEqual(['0:minDuration']);
    for (const c of cues) expect(c.text.length).toBeLessThanOrEqual(40);
  });

  it('extends short cues to 0.833 s but keeps a two-frame gap and stops at the end of the video', () => {
    // Too long to join with "Go." in one cue.
    const cues = buildCuesFromWords(
      [
        { text: 'Go.', start: 0, end: 0.2 },
        { text: 'Now-this-is-a-much-longer-sentence-than-that.', start: 0.5, end: 0.7 },
        { text: 'Late.', start: 5, end: 5.3 },
      ],
      { maxCharsPerCue: 40, fps: 25, endSeconds: 5.5 }
    );
    expect(cues.map((c) => [c.start, c.end])).toEqual([
      [0, 0.42],
      [0.5, 1.333],
      [5, 5.5],
    ]);
  });

  it('joins a cue too short to read with the speech right after it', () => {
    const cues = buildCuesFromWords(
      [
        { text: 'Go.', start: 0, end: 0.2 },
        { text: 'Now.', start: 0.3, end: 0.6 },
      ],
      { maxCharsPerCue: 40, fps: 25 }
    );
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([[0, 0.833, 'Go. Now.']]);
  });

  it('closes gaps under half a second to two frames (chaining)', () => {
    const cues = buildCuesFromWords(
      [
        { text: 'A whole sentence here.', start: 0, end: 1 },
        { text: 'And the next one.', start: 1.3, end: 2.4 },
      ],
      { maxCharsPerCue: 40, fps: 25 }
    );
    expect(cues.map((c) => [c.start, c.end])).toEqual([
      [0, 1.22],
      [1.3, 2.4],
    ]);
  });

  it('starts a new cue after a pause', () => {
    const cues = buildCuesFromWords(
      [
        { text: 'one', start: 0, end: 0.3 },
        { text: 'two', start: 1.5, end: 1.8 },
      ],
      { maxCharsPerCue: 40, fps: 30 }
    );
    expect(cues.map((c) => c.text)).toEqual(['one', 'two']);
  });

  it('spreads scene text over the scene without word timings', () => {
    const cues = buildCuesFromText('Render on your own machine. No seller cloud, no per-minute bill.', 3, 9, { maxCharsPerCue: 40, fps: 30 });
    expect(cues.map((c) => c.text)).toEqual(['Render on your own machine.', 'No seller cloud, no per-minute bill.']);
    expect(cues[0]!.start).toBe(3);
    expect(cues.at(-1)!.end).toBe(9);
    expect(cues.every((c) => c.words === undefined)).toBe(true);
  });
});

describe('SRT and WebVTT', () => {
  const cues: CaptionCue[] = [
    { start: 1, end: 2.5, text: 'Hello <world> & you' },
    { start: 3.25, end: 3661.5, text: 'A second cue that is long enough to need a line break here.' },
  ];

  it('formats timestamps', () => {
    expect(formatTimestamp(3661.5, ',')).toBe('01:01:01,500');
    expect(formatTimestamp(0.0004, '.')).toBe('00:00:00.000');
  });

  it('writes SRT with numbered cues and line breaks', () => {
    expect(formatSrt(cues, 42)).toBe(
      '1\n00:00:01,000 --> 00:00:02,500\nHello <world> & you\n\n2\n00:00:03,250 --> 01:01:01,500\nA second cue that is long enough\nto need a line break here.\n'
    );
  });

  it('writes WebVTT with a header, escaped text and word timestamps', () => {
    const vtt = formatVtt([cues[0]!, { start: 4, end: 5, text: 'Two words', words: [{ text: 'Two', start: 4, end: 4.4 }, { text: 'words', start: 4.5, end: 5 }] }], { language: 'en' });
    expect(vtt).toBe('WEBVTT\nLanguage: en\n\n00:00:01.000 --> 00:00:02.500\nHello &lt;world&gt; &amp; you\n\n00:00:04.000 --> 00:00:05.000\nTwo <00:00:04.500>words\n');
  });

  it('round-trips through the parsers', () => {
    const back = parseSrt(formatSrt(cues, 42));
    expect(back.map((c) => [c.start, c.end])).toEqual([
      [1, 2.5],
      [3.25, 3661.5],
    ]);
    expect(back[1]!.text).toBe('A second cue that is long enough\nto need a line break here.');
    const vtt = parseVtt(formatVtt(cues));
    expect(vtt[0]!.text).toBe('Hello <world> & you');
  });

  it('parses real-world SRT: BOM, CRLF, tags, missing index, dot separator', () => {
    const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\n<i>Italic</i> {\\an8}text\r\n\r\n00:00:03.5 --> 00:00:04,25\r\nNo index\r\n';
    expect(parseCaptions(srt)).toEqual([
      { start: 1, end: 2, text: 'Italic text' },
      { start: 3.5, end: 4.25, text: 'No index' },
    ]);
  });

  it('parses WebVTT: short timestamps, settings, ids, NOTE/STYLE blocks, voice and timestamp tags', () => {
    const vtt = [
      'WEBVTT - a title',
      'Kind: captions',
      '',
      'NOTE this is ignored',
      '',
      'STYLE',
      '::cue { color: red }',
      '',
      'intro',
      '00:01.000 --> 00:02.500 align:center line:90%',
      '<v Ann>Hello <00:01.500>there',
      '',
      '00:00:03.000 --> 00:00:04.000',
      'Line one',
      'line two',
    ].join('\n');
    expect(parseCaptions(vtt)).toEqual([
      { start: 1, end: 2.5, text: 'Hello there' },
      { start: 3, end: 4, text: 'Line one\nline two' },
    ]);
  });

  it('reports bad input with a line number', () => {
    expect(() => parseVtt('1\n00:00:01,000 --> 00:00:02,000\nHi')).toThrow(CaptionParseError);
    expect(() => parseSrt('1\n00:00:01,000 -> 00:00:02,000\nHi')).toThrow(/line 1: expected a "start --> end"/);
    expect(() => parseSrt('1\n00:00:03,000 --> 00:00:02,000\nHi')).toThrow(/line 2: the cue ends before it starts/);
    expect(() => parseSrt('1\n00:00:aa,000 --> 00:00:02,000\nHi')).toThrow(/not a timestamp/);
  });
});

describe('captions in the manifest', () => {
  it('older manifests stay valid; mode defaults to off and nothing is rendered', () => {
    const r = parsed(v02());
    expect(r.project.captions).toEqual({ enabled: false });
    const c = resolveCaptions(r.project);
    expect(c.mode).toBe('off');
    expect(c.source).toBe('none');
  });

  it('accepts cues, mode, language, style and words on the voice track', () => {
    const m = v02();
    m.captions = {
      mode: 'both',
      language: 'en',
      highlight: 'word',
      maxLineChars: 30,
      style: { position: 'top', outline: null, highlightColor: '#ffcc00', weight: 800, backgroundOpacity: 0.6 },
      cues: [{ start: 0.5, end: 2, text: 'Hello there.', words: [{ text: 'Hello', start: 0.5, end: 0.9 }, { text: 'there.', start: 1, end: 1.4 }] }],
    };
    const r = parsed(m);
    const c = resolveCaptions(r.project);
    expect(c).toMatchObject({ mode: 'both', source: 'cues', language: 'en', maxLineChars: 30, maxCharsPerCue: 60 });
    expect(r.warnings.filter((w) => w.path.startsWith('captions'))).toEqual([]);
    expect(resolveCaptions(r.project, { mode: 'off' }).mode).toBe('off');
  });

  it('rejects cues that end before they start or are out of order', () => {
    const m = v02();
    m.captions = { cues: [{ start: 2, end: 1, text: 'Backwards' }, { start: 0.5, end: 1.5, text: 'Earlier' }] };
    const r = parseProject(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path)).toEqual(['captions.cues.0.end', 'captions.cues.1.start']);
  });

  it('builds cues from the voice word timestamps, shifted by the voice start', () => {
    const m = v02();
    m.assets.push({ id: 'voice', uri: 'project://voice.mp3', mediaType: 'audio', license: { name: 'user-provided', redistributable: false } });
    m.audio.voice = { asset: 'voice', startFrame: 30, words: [{ text: 'Made', start: 0, end: 0.3 }, { text: 'here.', start: 0.4, end: 0.8 }] };
    m.captions = { mode: 'burned' };
    const c = resolveCaptions(parsed(m).project);
    expect(c.source).toBe('voice');
    expect(c.cues).toEqual([{ start: 1, end: 1.833, text: 'Made here.', words: [{ text: 'Made', start: 1, end: 1.3 }, { text: 'here.', start: 1.4, end: 1.8 }] }]);
  });

  it('falls back to scene caption text, over each scene', () => {
    const m = v02();
    m.scenes[1].captions = { text: 'How it works, in one line.' };
    m.captions = { mode: 'sidecar' };
    const r = parsed(m);
    const c = resolveCaptions(r.project);
    expect(c.source).toBe('scenes');
    const start = r.project.scenes[0]!.durationSeconds ?? r.project.scenes[0]!.durationFrames! / 30;
    expect(c.cues[0]!.start).toBeCloseTo(start, 6);
  });

  it('warns about quality problems, captions left off and modes with no cues', () => {
    const m = v02();
    m.captions = { enabled: true, cues: [{ start: 0, end: 0.4, text: 'This is far too much text for such a short cue.' }] };
    const w = parsed(m).warnings.filter((x) => x.path.startsWith('captions'));
    expect(w.map((x) => x.path)).toEqual(['captions.enabled', 'captions.mode', 'captions.cues.0', 'captions.cues.0']);
    expect(w[2]!.message).toMatch(/\[readingSpeed\]/);
    expect(w[3]!.message).toMatch(/\[minDuration\]/);
    const n = v02();
    n.captions = { mode: 'burned' };
    expect(parsed(n).warnings.find((x) => x.path === 'captions.mode')?.message).toMatch(/no cues/);
  });
});
