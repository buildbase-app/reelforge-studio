import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssetStore, fetchRemoteFile, isPrivateAddress, sniffContentType, createMemoryRepositories } from '../src/index';
import { makeTone, tempDir } from './helpers';

const { dir, cleanup } = tempDir('reelforge-assets-');
afterAll(cleanup);

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

describe('sniffContentType', () => {
  it('decides by bytes, not by the claimed type', () => {
    expect(sniffContentType(PNG)?.contentType).toBe('image/png');
    expect(sniffContentType(Buffer.from('ID3\x03\x00'))?.contentType).toBe('audio/mpeg');
    expect(sniffContentType(Buffer.from('RIFF0000WAVEfmt '))?.contentType).toBe('audio/wav');
    expect(sniffContentType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffContentType(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull();
  });
});

describe('isPrivateAddress (SSRF guard)', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['::1', true],
    ['fd00::1', true],
    ['fe80::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:10.0.0.1', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['2606:4700:4700::1111', false],
    ['not-an-ip', true],
  ])('%s -> %s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe('fetchRemoteFile guards', () => {
  const limits = { maxBytes: 1024, timeoutMs: 2000, maxRedirects: 2 };
  it('allows only https', async () => {
    await expect(fetchRemoteFile('http://example.com/a.png', limits)).rejects.toMatchObject({ code: 'url_not_allowed' });
    await expect(fetchRemoteFile('file:///etc/passwd', limits)).rejects.toMatchObject({ code: 'url_not_allowed' });
  });
  it('refuses private IP literals and names that resolve to private addresses', async () => {
    await expect(fetchRemoteFile('https://127.0.0.1/a.png', limits)).rejects.toMatchObject({ code: 'url_not_allowed' });
    await expect(fetchRemoteFile('https://[::1]/a.png', limits)).rejects.toMatchObject({ code: 'url_not_allowed' });
    await expect(fetchRemoteFile('https://169.254.169.254/latest/meta-data', limits)).rejects.toMatchObject({ code: 'url_not_allowed' });
    await expect(fetchRemoteFile('https://localhost/a.png', limits)).rejects.toMatchObject({ code: 'url_not_allowed' });
  });
  it('refuses credentials in URLs', async () => {
    await expect(fetchRemoteFile('https://user:pass@example.com/a.png', limits)).rejects.toMatchObject({ code: 'url_not_allowed' });
  });
});

describe('AssetStore', () => {
  let server: Server;
  let base: string;
  let mp3: Buffer;
  const agents: string[] = [];
  beforeAll(async () => {
    const f = join(dir, 'tone.mp3');
    await makeTone(f, 1);
    mp3 = readFileSync(f);
    server = createServer((req, res) => {
      agents.push(req.headers['user-agent'] ?? '');
      if (req.url === '/tone.mp3') return res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(mp3);
      if (req.url === '/big') return res.writeHead(200).end(Buffer.alloc(5000, 1));
      if (req.url === '/loop') return res.writeHead(302, { location: '/loop' }).end();
      if (req.url === '/redirect') return res.writeHead(302, { location: '/tone.mp3' }).end();
      if (req.url === '/page') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const repo = createMemoryRepositories().assets;
  const store = () => new AssetStore(repo, dir, { maxBytes: 64 * 1024, timeoutMs: 2000, maxRedirects: 2, allowInsecureForTests: true });

  it('stores uploads content-addressed and deduplicates', async () => {
    const a = await store().put({ data: mp3, source: 'upload', originalName: 'tone.mp3' });
    expect(a.id).toMatch(/^ast-[0-9a-f]{16}$/);
    expect(a.mediaType).toBe('audio');
    expect(a.contentType).toBe('audio/mpeg');
    const again = await store().put({ data: mp3, source: 'upload' });
    expect(again.id).toBe(a.id);
    expect(readFileSync(await store().file(a.id)).equals(mp3)).toBe(true);
    expect((await store().list()).map((x) => x.id)).toContain(a.id);
  });

  it('rejects unsupported types, empty and oversized files', async () => {
    await expect(store().put({ data: Buffer.from('<html>'), source: 'upload' })).rejects.toMatchObject({ code: 'unsupported_media_type' });
    await expect(store().put({ data: Buffer.alloc(0), source: 'upload' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(store().put({ data: Buffer.alloc(70 * 1024, 0xff), source: 'upload' })).rejects.toMatchObject({ code: 'too_large' });
  });

  it('imports from a URL, following a limited number of redirects', async () => {
    const a = await store().fromUrl(`${base}/redirect`);
    expect(a.contentType).toBe('audio/mpeg');
    // The RenderWeld User-Agent, with the old token after it (#413), on the request and the redirect.
    expect(agents.slice(-2)).toEqual(['RenderWeld-Asset-Fetch/1 reelforge-studio-asset-fetch', 'RenderWeld-Asset-Fetch/1 reelforge-studio-asset-fetch']);
    // Same bytes as the earlier upload: the existing asset is returned.
    expect(a.id).toBe((await store().put({ data: mp3, source: 'upload' })).id);
    await expect(store().fromUrl(`${base}/loop`)).rejects.toMatchObject({ code: 'fetch_failed' });
    await expect(store().fromUrl(`${base}/missing`)).rejects.toMatchObject({ code: 'fetch_failed' });
    await expect(store().fromUrl(`${base}/page`)).rejects.toMatchObject({ code: 'unsupported_media_type' });
  });

  it('stops downloads over the size limit', async () => {
    const small = new AssetStore(repo, dir, { maxBytes: 1000, timeoutMs: 2000, maxRedirects: 0, allowInsecureForTests: true });
    await expect(small.fromUrl(`${base}/big`)).rejects.toMatchObject({ code: 'too_large' });
  });
});
