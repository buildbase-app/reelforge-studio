import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEvent, sameOriginLink } from '../src/api';
import { ago, between, bytes, downloadLabel, duration, jobType, outputFormat, outputShort, percent, playerKind, scopeText, size, stillNote } from '../src/format';

describe('output formats (#302)', () => {
  it('names the format, codec and alpha, MP4 for renders made before formats', () => {
    expect(outputFormat({})).toBe('MP4 · H.264');
    expect(outputFormat({ format: 'mov', codec: 'prores-4444', alpha: true })).toBe('MOV · ProRes 4444 · alpha');
    expect(outputFormat({ format: 'webm', codec: 'av1', alpha: false })).toBe('WebM · AV1');
    expect(outputFormat({ format: 'png-sequence', codec: 'png', alpha: true })).toBe('PNG sequence · alpha');
    expect(outputFormat({ format: 'gif', codec: 'gif' })).toBe('GIF');
    expect(outputFormat({ format: 'wav', codec: 'pcm-s16le' })).toBe('WAV · PCM');
  });
  it('picks the player for each format', () => {
    // Browsers do not decode ProRes: MOV shows its first frame, as a PNG zip does.
    expect([undefined, 'mp4', 'mov', 'webm', 'gif', 'png-sequence', 'm4a', 'wav'].map(playerKind)).toEqual(['video', 'video', 'still', 'video', 'image', 'still', 'audio', 'audio']);
    expect(stillNote('mov')).toMatch(/ProRes plays in editing apps/);
    expect(stillNote('webm')).toBeNull();
  });
  it('labels cards and downloads by container', () => {
    expect([outputShort({}), outputShort({ format: 'mov', alpha: true }), outputShort({ format: 'png-sequence' })]).toEqual(['MP4', 'MOV · alpha', 'PNG frames']);
    expect([downloadLabel('final.mp4'), downloadLabel('final.webm'), downloadLabel('frames.zip')]).toEqual(['Download MP4', 'Download WebM', 'Download frames (ZIP)']);
  });
});

describe('figures', () => {
  it('formats durations in one style', () => {
    expect(duration(12_040)).toBe('12.0 s');
    expect(duration(65_000)).toBe('1 min 05 s');
    expect(duration(3_720_000)).toBe('1 h 02 min');
    expect(duration(-1)).toBe('–');
    expect(between('2026-11-23T10:00:00Z', '2026-11-23T10:00:46.300Z')).toBe('46.3 s');
    expect(between(undefined)).toBe('–');
  });
  it('says how long ago, then the date', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');
    expect(ago('2026-11-23T11:59:50Z', now)).toBe('just now');
    expect(ago('2026-11-23T11:56:00Z', now)).toBe('4 min ago');
    expect(ago('2026-11-23T09:00:00Z', now)).toBe('3 h ago');
    expect(ago('2026-11-20T09:00:00Z', now)).toMatch(/^20 Nov 2026/);
  });
  it('percent, size, bytes, job types and scopes', () => {
    expect(percent(0.426)).toBe('42 %');
    expect(percent(2)).toBe('100 %');
    expect(percent(undefined)).toBe('0 %');
    expect(size(1080, 1920)).toBe('1080 × 1920');
    expect(bytes(1_234_567)).toBe('1.2 MB');
    expect(bytes(512)).toBe('512 B');
    expect(jobType('render_unit')).toBe('Render unit');
    expect(scopeText(['read'])).toBe('read only');
    expect(scopeText(['read', 'render'])).toBe('read, render');
    expect(scopeText(['admin'])).toBe('admin');
  });
});

describe('API helpers', () => {
  it('parses server-sent event blocks', () => {
    expect(parseEvent('event: status\ndata: {"id":"job_1"}')).toEqual({ event: 'status', data: '{"id":"job_1"}' });
    expect(parseEvent('data: a\ndata: b')).toEqual({ event: 'message', data: 'a\nb' });
    expect(parseEvent(': keep-alive')).toBeNull();
  });
  it('plays a server-signed link from this origin, never a bucket link', () => {
    expect(sameOriginLink({ downloadVia: 'server', downloadUrl: 'https://studio.example.com/v1/renders/run_a/output?expires=1&sig=x' })).toBe('/v1/renders/run_a/output?expires=1&sig=x');
    expect(sameOriginLink({ downloadVia: 'bucket', downloadUrl: 'https://bucket.s3.amazonaws.com/x?X-Amz-Signature=y' })).toBeNull();
    expect(sameOriginLink({ downloadVia: 'server', downloadUrl: 'https://studio.example.com/elsewhere' })).toBeNull();
  });
});

describe('sources stay inside the CSP', () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, '..', 'src', f), 'utf8');
  const files = ['main.ts', 'api.ts', 'dom.ts', 'format.ts', 'views/jobs.ts', 'views/library.ts', 'views/login.ts'];
  it('never writes HTML strings, inline styles, eval or an external URL', () => {
    for (const f of files) {
      const text = src(f);
      expect(text, f).not.toMatch(/\.innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
      expect(text, f).not.toMatch(/setAttribute\(\s*['"]style/);
      expect(text, f).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    }
  });
  it('the page loads only its own files', () => {
    const html = src('index.html');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script>(?!<\/script>)|style=/);
  });
  it('never puts the key in a cookie or a URL', () => {
    for (const f of files) expect(src(f), f).not.toMatch(/document\.cookie|[?&](key|token|api_key)=/);
  });
});
