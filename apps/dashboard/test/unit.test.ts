import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { can, parseEvent, sameOriginLink } from '../src/api';
import { labelEvery, niceTicks, tickText } from '../src/chart';
import { ago, between, bucketLabel, bucketTitle, bytes, downloadLabel, duration, groupTitle, jobType, latency, outputFormat, outputShort, percent, playerKind, rate, scopeText, size, stillNote } from '../src/format';
import { auditQuery } from '../src/views/audit';
import { parseInput } from '../src/views/settings';

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

describe('analytics figures and chart scales', () => {
  it('rates, latencies, bucket labels and group titles', () => {
    expect(rate(0.5)).toBe('50 %');
    expect(rate(0.9556)).toBe('95.6 %');
    expect(rate(1)).toBe('100 %');
    expect(rate(null)).toBe('–');
    expect(latency(3.4)).toBe('3 ms');
    expect(latency(1500)).toBe('1.5 s');
    expect(latency(undefined)).toBe('–');
    expect(bucketLabel('2026-11-24T00:00:00.000Z', 'day')).toBe('24 Nov');
    expect(bucketLabel('2026-11-24T15:00:00.000Z', 'hour')).toBe('15:00');
    expect(bucketTitle('2026-11-24T15:00:00.000Z', 'hour')).toMatch(/24 Nov 2026, 15:00 UTC$/);
    expect(groupTitle('observability')).toBe('Observability');
    expect(groupTitle('mcpOauth')).toBe('Mcp oauth');
  });
  it('round axis ticks that reach the largest value, compact past 10 000', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(21)).toEqual([0, 10, 20, 30]);
    expect(niceTicks(17)).toEqual([0, 5, 10, 15, 20]);
    expect(niceTicks(4200)).toEqual([0, 2000, 4000, 6000]);
    expect(tickText(2000, 3000)).toBe('2,000');
    expect(tickText(20_000, 30_000)).toBe('20K');
    expect(tickText(1_500_000, 2_000_000)).toBe('1.5M');
    expect(labelEvery(30, 8)).toBe(4);
    expect(labelEvery(5, 8)).toBe(1);
  });
});

describe('settings and audit inputs', () => {
  it('checks a setting the way the server will, before update_config', () => {
    expect(parseInput({ kind: 'integer', min: 0, max: 86400 }, '900')).toEqual({ ok: true, value: 900 });
    expect(parseInput({ kind: 'integer', min: 0 }, '-5')).toEqual({ ok: false, message: 'The lowest value is 0.' });
    expect(parseInput({ kind: 'integer', max: 10 }, '11')).toEqual({ ok: false, message: 'The highest value is 10.' });
    expect(parseInput({ kind: 'integer' }, '1.5')).toEqual({ ok: false, message: 'Enter a whole number.' });
    expect(parseInput({ kind: 'number' }, 'abc')).toEqual({ ok: false, message: 'Enter a number.' });
    expect(parseInput({ kind: 'number' }, '0.25')).toEqual({ ok: true, value: 0.25 });
    expect(parseInput({ kind: 'boolean' }, true)).toEqual({ ok: true, value: true });
    expect(parseInput({ kind: 'enum', options: ['proxy', 'signed'] }, 'signed')).toEqual({ ok: true, value: 'signed' });
    expect(parseInput({ kind: 'enum', options: ['proxy', 'signed'] }, 'other').ok).toBe(false);
    expect(parseInput({ kind: 'list' }, ' a.example.com, b.example.com ,')).toEqual({ ok: true, value: ['a.example.com', 'b.example.com'] });
    expect(parseInput({ kind: 'url' }, 'ftp://x').ok).toBe(false);
    expect(parseInput({ kind: 'url' }, 'https://studio.example.com')).toEqual({ ok: true, value: 'https://studio.example.com' });
    expect(parseInput({ kind: 'string' }, '  ').ok).toBe(false);
  });
  it('builds the audit query: actions as prefixes, local times as ISO', () => {
    const q = auditQuery({ action: 'key.', result: 'denied', actor: ' key_1 ', from: '2026-11-24T10:00', to: '' });
    expect(q.get('action')).toBe('key.*');
    expect(q.get('result')).toBe('denied');
    expect(q.get('actorId')).toBe('key_1');
    expect(q.get('from')).toBe(new Date('2026-11-24T10:00').toISOString());
    expect(q.has('to')).toBe(false);
    expect(auditQuery({ action: 'config.*', result: '', actor: '', from: '', to: '' }).get('action')).toBe('config.*');
  });
  it('scopes as the server reads them: admin implies all but owner, owner implies all', () => {
    expect(can(['read'], 'read')).toBe(true);
    expect(can(['read'], 'admin')).toBe(false);
    expect(can(['admin'], 'render')).toBe(true);
    expect(can(['admin'], 'owner')).toBe(false);
    expect(can(['owner'], 'admin')).toBe(true);
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
  const files = ['main.ts', 'api.ts', 'dom.ts', 'format.ts', 'chart.ts', 'views/jobs.ts', 'views/library.ts', 'views/login.ts', 'views/analytics.ts', 'views/settings.ts', 'views/audit.ts'];
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

describe('RenderWeld name, icons and manifest (#413)', () => {
  it('the build links the kit icons and a manifest that opens /dashboard/', async () => {
    const { buildDashboard } = await import('../build');
    const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const out = mkdtempSync(join(tmpdir(), 'renderweld-dashboard-build-'));
    try {
      await buildDashboard(out);
      const html = readFileSync(join(out, 'index.html'), 'utf8');
      expect(html).toContain('<title>RenderWeld</title>');
      expect(html).not.toMatch(/ReelForge|%[A-Z_]+%/);
      const files = readdirSync(join(out, 'assets'));
      const linked = (rel: string) => html.match(new RegExp(`rel="${rel}" href="assets/([^"]+)"`))?.[1];
      for (const rel of ['icon', 'apple-touch-icon', 'manifest']) expect(files, rel).toContain(linked(rel));
      const manifest = JSON.parse(readFileSync(join(out, 'assets', linked('manifest')!), 'utf8'));
      expect(manifest).toMatchObject({ name: 'RenderWeld', short_name: 'RenderWeld', start_url: '../', scope: '../', display: 'standalone' });
      expect(manifest.icons.map((i: { purpose: string; sizes: string }) => `${i.purpose} ${i.sizes}`)).toEqual(['any 192x192', 'any 512x512', 'maskable 512x512']);
      for (const icon of manifest.icons) expect(files).toContain(icon.src);
      expect(readFileSync(join(out, 'assets', linked('icon')!), 'utf8')).toContain('<title>RenderWeld</title>');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
