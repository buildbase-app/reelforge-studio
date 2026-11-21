import { createHash } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { ApiError, notFound } from './errors';
import type { PutAssetInput, StoredAsset } from './plugins';
import type { AssetRecord, AssetRepository } from './repositories';
import { LocalStorageDriver } from './storage';

/**
 * Content types the asset store accepts, decided from the file's bytes, not
 * from what the client claims. SVG and HTML are deliberately absent.
 */
export function sniffContentType(b: Buffer): { contentType: string; mediaType: StoredAsset['mediaType']; ext: string } | null {
  const starts = (sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);
  const ascii = (s: string, offset = 0) => b.subarray(offset, offset + s.length).toString('latin1') === s;
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: 'image/png', mediaType: 'image', ext: 'png' };
  if (starts([0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', mediaType: 'image', ext: 'jpg' };
  if (ascii('GIF87a') || ascii('GIF89a')) return { contentType: 'image/gif', mediaType: 'image', ext: 'gif' };
  if (ascii('RIFF') && ascii('WEBP', 8)) return { contentType: 'image/webp', mediaType: 'image', ext: 'webp' };
  if (ascii('RIFF') && ascii('WAVE', 8)) return { contentType: 'audio/wav', mediaType: 'audio', ext: 'wav' };
  if (ascii('OggS')) return { contentType: 'audio/ogg', mediaType: 'audio', ext: 'ogg' };
  if (ascii('fLaC')) return { contentType: 'audio/flac', mediaType: 'audio', ext: 'flac' };
  if (ascii('ID3') || (b[0] === 0xff && b.length > 1 && ((b[1] ?? 0) & 0xe0) === 0xe0 && ((b[1] ?? 0) & 0x06) !== 0)) {
    return { contentType: 'audio/mpeg', mediaType: 'audio', ext: 'mp3' };
  }
  if (b[0] === 0xff && ((b[1] ?? 0) & 0xf6) === 0xf0) return { contentType: 'audio/aac', mediaType: 'audio', ext: 'aac' };
  if (ascii('ftyp', 4)) {
    const brand = b.subarray(8, 12).toString('latin1');
    if (brand.startsWith('M4A') || brand === 'M4B ') return { contentType: 'audio/mp4', mediaType: 'audio', ext: 'm4a' };
    if (brand === 'qt  ') return { contentType: 'video/quicktime', mediaType: 'video', ext: 'mov' };
    return { contentType: 'video/mp4', mediaType: 'video', ext: 'mp4' };
  }
  if (starts([0x1a, 0x45, 0xdf, 0xa3])) return { contentType: 'video/webm', mediaType: 'video', ext: 'webm' };
  if (ascii('wOFF')) return { contentType: 'font/woff', mediaType: 'font', ext: 'woff' };
  if (ascii('wOF2')) return { contentType: 'font/woff2', mediaType: 'font', ext: 'woff2' };
  if (starts([0x00, 0x01, 0x00, 0x00, 0x00])) return { contentType: 'font/ttf', mediaType: 'font', ext: 'ttf' };
  if (ascii('OTTO')) return { contentType: 'font/otf', mediaType: 'font', ext: 'otf' };
  return null;
}

// ---- SSRF guard -----------------------------------------------------------

const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked4.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked6.addSubnet(net, prefix, 'ipv6');
}

/** True for loopback, private, link-local, CGNAT, multicast, documentation and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked4.check(ip, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return blocked4.check(mapped[1]!, 'ipv4');
    if (/^::ffff:/i.test(ip)) return true; // other IPv4-mapped spellings: refuse
    return blocked6.check(ip, 'ipv6');
  }
  return true;
}

/**
 * A DNS lookup that refuses non-public addresses. Used as the socket's lookup
 * function, so the address that is checked is the one that is connected to
 * (no DNS-rebinding window between check and connect).
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = addresses as unknown as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || list.length === 0) {
      const e = new Error(`refusing to connect to non-public address ${bad?.address ?? '(none)'} for ${hostname}`) as NodeJS.ErrnoException;
      e.code = 'ESSRF';
      return callback(e, '', 4);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

export interface FetchLimits {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  /** Tests only: allow http:// and private addresses (e.g. a local test server). */
  allowInsecureForTests?: boolean;
}

export async function fetchRemoteFile(url: string, limits: FetchLimits): Promise<{ data: Buffer; finalUrl: string; declaredType?: string }> {
  let current = url;
  for (let hop = 0; hop <= limits.maxRedirects; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      throw new ApiError('bad_request', 400, `not a valid URL: ${current}`);
    }
    if (u.protocol !== 'https:' && !(limits.allowInsecureForTests && u.protocol === 'http:')) {
      throw new ApiError('url_not_allowed', 400, `only https:// URLs can be imported (got ${u.protocol})`);
    }
    if (u.username || u.password) throw new ApiError('url_not_allowed', 400, 'URLs with credentials are not allowed');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!limits.allowInsecureForTests && isIP(host) && isPrivateAddress(host)) {
      throw new ApiError('url_not_allowed', 400, `refusing to fetch from non-public address ${host}`);
    }
    const res = await getOnce(u, limits);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, u).toString();
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new ApiError('fetch_failed', 502, `fetching ${u.origin}${u.pathname} returned HTTP ${status}`);
    }
    const declared = Number(res.headers['content-length'] ?? 0);
    if (declared > limits.maxBytes) {
      res.destroy();
      throw new ApiError('too_large', 413, `remote file is ${declared} bytes; the limit is ${limits.maxBytes}`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      res.on('data', (c: Buffer) => {
        total += c.length;
        if (total > limits.maxBytes) {
          res.destroy();
          reject(new ApiError('too_large', 413, `remote file is larger than the limit of ${limits.maxBytes} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', resolve);
      res.on('error', reject);
    });
    return { data: Buffer.concat(chunks), finalUrl: current, declaredType: res.headers['content-type'] };
  }
  throw new ApiError('fetch_failed', 502, `too many redirects (more than ${limits.maxRedirects})`);
}

function getOnce(u: URL, limits: FetchLimits): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      {
        method: 'GET',
        lookup: limits.allowInsecureForTests ? undefined : publicOnlyLookup,
        headers: { 'user-agent': 'reelforge-studio-asset-fetch', accept: '*/*' },
        timeout: limits.timeoutMs,
      },
      resolve
    );
    req.on('timeout', () => req.destroy(new ApiError('fetch_failed', 504, `timed out after ${limits.timeoutMs} ms`)));
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e instanceof ApiError) return reject(e);
      if (e.code === 'ESSRF') return reject(new ApiError('url_not_allowed', 400, e.message));
      reject(new ApiError('fetch_failed', 502, `could not fetch ${u.origin}: ${e.message}`));
    });
    req.end();
  });
}

// ---- store ----------------------------------------------------------------

const ASSET_ID = /^ast-[0-9a-f]{16}$/;

const toStored = ({ storageKey: _k, ...asset }: AssetRecord): StoredAsset => asset;

/**
 * Content-addressed asset store. The bytes go to the storage driver at
 * <id>/file.<ext> (local: <dataDir>/assets/<id>/file.<ext>), the metadata to
 * AssetRepository, where id = "ast-" + first 16 hex digits of the sha256.
 * Uploading the same bytes twice returns the same asset.
 */
export class AssetStore {
  readonly storage: LocalStorageDriver;

  constructor(
    private readonly repo: AssetRepository,
    dataDir: string,
    readonly limits: FetchLimits
  ) {
    this.storage = new LocalStorageDriver(`${dataDir}/assets`);
  }

  async put(input: PutAssetInput): Promise<StoredAsset> {
    if (input.data.length === 0) throw new ApiError('bad_request', 400, 'the file is empty');
    if (input.data.length > this.limits.maxBytes) {
      throw new ApiError('too_large', 413, `file is ${input.data.length} bytes; the limit is ${this.limits.maxBytes}`);
    }
    const sniffed = sniffContentType(input.data);
    if (!sniffed) {
      throw new ApiError(
        'unsupported_media_type',
        415,
        'unsupported file type; accepted: PNG, JPEG, GIF, WebP, MP3, WAV, AAC, M4A, OGG, FLAC, MP4, MOV, WebM, TTF, OTF, WOFF, WOFF2',
        { declaredContentType: input.declaredContentType }
      );
    }
    const sha256 = createHash('sha256').update(input.data).digest('hex');
    const id = `ast-${sha256.slice(0, 16)}`;
    const existing = await this.find(id);
    if (existing) return existing;
    const storageKey = `${id}/file.${sniffed.ext}`;
    const record: AssetRecord = {
      id,
      sha256,
      bytes: input.data.length,
      contentType: sniffed.contentType,
      mediaType: sniffed.mediaType,
      createdAt: new Date().toISOString(),
      source: input.source,
      storageKey,
      ...(input.originalName ? { originalName: input.originalName.slice(0, 200) } : {}),
      ...(input.license ? { license: input.license } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    // Bytes first: a row never points at a missing file.
    await this.storage.put(storageKey, input.data);
    return toStored(await this.repo.insertIfAbsent(record));
  }

  async fromUrl(url: string, extra: Omit<PutAssetInput, 'data' | 'source'> = {}): Promise<StoredAsset> {
    const { data, declaredType } = await fetchRemoteFile(url, this.limits);
    return this.put({ ...extra, data, source: url, declaredContentType: declaredType });
  }

  async find(id: string): Promise<StoredAsset | undefined> {
    if (!ASSET_ID.test(id)) return undefined;
    const a = await this.repo.get(id);
    return a ? toStored(a) : undefined;
  }

  async get(id: string): Promise<StoredAsset> {
    const a = await this.find(id);
    if (!a) throw notFound('asset', id);
    return a;
  }

  /** Absolute path of the asset's bytes. */
  async file(id: string): Promise<string> {
    const a = ASSET_ID.test(id) ? await this.repo.get(id) : null;
    if (!a) throw notFound('asset', id);
    if (!(await this.storage.stat(a.storageKey))) throw notFound('asset file', id);
    return this.storage.localPath(a.storageKey);
  }

  async list(): Promise<StoredAsset[]> {
    return (await this.repo.list()).map(toStored);
  }

  async updateMetadata(id: string, patch: Partial<Pick<StoredAsset, 'durationSeconds' | 'metadata' | 'license'>>): Promise<StoredAsset> {
    const a = ASSET_ID.test(id) ? await this.repo.update(id, patch) : null;
    if (!a) throw notFound('asset', id);
    return toStored(a);
  }
}
