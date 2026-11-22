import { createHash } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { ApiError, notFound } from './errors';
import type { PutAssetInput, StoredAsset } from './plugins';
import type { AssetRecord, AssetRepository } from './repositories';
import type { StorageDriver } from './plugins';
import { ASSETS_PREFIX } from './storage/keys';
import { LocalStorageDriver } from './storage/local';

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
// IPv6: loopback/unspecified/IPv4-compatible, SIIT, NAT64 (well-known and local-use),
// discard, IETF protocol assignments (incl. Teredo), documentation, 6to4, ULA,
// link-local, site-local, multicast (SEC-05).
for (const [net, prefix] of [
  ['::', 96],
  ['::ffff:0:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked6.addSubnet(net, prefix, 'ipv6');
}

/** The eight 16-bit groups of an IPv6 address (dotted IPv4 tail and zone id allowed), or null. */
export function ipv6Groups(input: string): number[] | null {
  let ip = input.trim().replace(/^\[|\]$/g, '');
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (isIP(ip) !== 6) return null;
  let tail: number[] = [];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (dotted) {
    const b = dotted.slice(1).map(Number);
    tail = [(b[0]! << 8) | b[1]!, (b[2]! << 8) | b[3]!];
    ip = ip.slice(0, dotted.index) + (ip.slice(0, dotted.index).endsWith(':') ? '' : ':');
    if (ip.endsWith(':') && !ip.endsWith('::')) ip = ip.slice(0, -1);
  }
  const [head = '', rest] = ip.split('::');
  const parse = (part: string) => (part ? part.split(':').filter((g) => g !== '').map((g) => parseInt(g, 16)) : []);
  const left = parse(head);
  const right = rest === undefined ? [] : parse(rest);
  const fill = 8 - tail.length - left.length - right.length;
  if (fill < 0 || (rest === undefined && fill !== 0)) return null;
  const groups = [...left, ...Array(fill).fill(0), ...right, ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True for loopback, private, link-local, CGNAT, multicast, documentation, transition and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  // Drop an IPv6 zone id (`fe80::1%eth0`) by slicing, not a regex: linear on any input.
  const zone = ip.indexOf('%');
  const family = isIP(zone === -1 ? ip : ip.slice(0, zone));
  if (family === 4) return blocked4.check(ip, 'ipv4');
  const g = ipv6Groups(ip);
  if (!g) return true;
  // IPv4-mapped (::ffff:a.b.c.d): the socket connects to the IPv4 address, so judge that.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return blocked4.check(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`, 'ipv4');
  }
  return blocked6.check(g.map((x) => x.toString(16)).join(':'), 'ipv6');
}

/**
 * What is stored as an asset's `source`: scheme, host and path of the import
 * URL. Credentials, query string (presigned URLs carry signatures there) and
 * fragment are dropped (SEC-08).
 */
export function sanitizeSourceUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return stripQueryAndUserinfo(url);
  }
}

/** Fallback for unparseable URLs: cut at the first `?` or `#`, drop `user:pass@` after `//`. Linear time (no regex). */
function stripQueryAndUserinfo(url: string): string {
  let end = url.length;
  for (const ch of ['?', '#']) {
    const i = url.indexOf(ch);
    if (i !== -1 && i < end) end = i;
  }
  const out = url.slice(0, end);
  const slashes = out.indexOf('//');
  if (slashes === -1) return out;
  const authorityStart = slashes + 2;
  const nextSlash = out.indexOf('/', authorityStart);
  const authorityEnd = nextSlash === -1 ? out.length : nextSlash;
  const at = out.lastIndexOf('@', authorityEnd - 1);
  return at >= authorityStart ? out.slice(0, authorityStart) + out.slice(at + 1) : out;
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

/** Where AssetStore keeps bytes: the current driver and a way to get a local file (StorageManager). */
export interface AssetStorage {
  readonly driver: StorageDriver;
  localFile(key: string, expectedBytes?: number): Promise<string>;
}

/**
 * Content-addressed asset store. The bytes go to the storage driver at
 * assets/<id>/file.<ext> (local: <dataDir>/assets/<id>/file.<ext>; remote: the
 * bucket, D-065), the metadata to AssetRepository, where id = "ast-" + first
 * 16 hex digits of the sha256. Uploading the same bytes twice returns the
 * same asset.
 */
export class AssetStore {
  private readonly storage: AssetStorage;

  constructor(
    private readonly repo: AssetRepository,
    /** A data directory (local storage) or the server's StorageManager. */
    storage: string | AssetStorage,
    readonly limits: FetchLimits
  ) {
    if (typeof storage === 'string') {
      const driver = new LocalStorageDriver(storage);
      this.storage = { driver, localFile: async (key) => driver.localPath(key) };
    } else this.storage = storage;
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
    await this.storage.driver.put(ASSETS_PREFIX + storageKey, input.data, { contentType: sniffed.contentType });
    return toStored(await this.repo.insertIfAbsent(record));
  }

  async fromUrl(url: string, extra: Omit<PutAssetInput, 'data' | 'source'> = {}): Promise<StoredAsset> {
    const { data, declaredType } = await fetchRemoteFile(url, this.limits);
    return this.put({ ...extra, data, source: sanitizeSourceUrl(url), declaredContentType: declaredType });
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

  /** Absolute path of the asset's bytes (for remote storage: a cached local copy). */
  async file(id: string): Promise<string> {
    const a = ASSET_ID.test(id) ? await this.repo.get(id) : null;
    if (!a) throw notFound('asset', id);
    const key = ASSETS_PREFIX + a.storageKey;
    if (!(await this.storage.driver.stat(key))) throw notFound('asset file', id);
    return this.storage.localFile(key, a.bytes);
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
