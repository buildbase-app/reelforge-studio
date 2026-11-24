import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isPrivateAddress, publicOnlyLookup } from '../assets';
import { ApiError } from '../errors';
import { userAgent } from '../product';

/**
 * Outbound HTTP for webhooks and chat channels with the SSRF guard (D-072):
 * https only, and no loopback/private/link-local/CGNAT/multicast addresses,
 * unless the start-up settings webhooks.allowHttp / webhooks.allowPrivateNetworks
 * say otherwise. The address is checked by the socket's DNS lookup, so the
 * address checked is the one connected to (no DNS-rebinding window), as for
 * add_asset_from_url. Redirects are never followed.
 */
export interface OutboundPolicy {
  allowHttp: boolean;
  allowPrivateNetworks: boolean;
}

/** Check a target URL when it is saved (the connect-time check still runs on every attempt). Throws url_not_allowed. */
export function checkTargetUrl(raw: string, policy: OutboundPolicy): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError('bad_request', 400, `not a valid URL: ${raw.slice(0, 200)}`);
  }
  if (u.protocol !== 'https:' && !(policy.allowHttp && u.protocol === 'http:')) {
    throw new ApiError('url_not_allowed', 400, `only https:// URLs are allowed (got ${u.protocol}); http:// needs the start-up setting webhooks.allowHttp`);
  }
  if (u.username || u.password) throw new ApiError('url_not_allowed', 400, 'URLs with credentials (user:password@) are not allowed; put a token in the path or use the signing secret');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!policy.allowPrivateNetworks) {
    if ((isIP(host) && isPrivateAddress(host)) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
      throw new ApiError('url_not_allowed', 400, `refusing ${host}: private, loopback and link-local targets need the start-up setting webhooks.allowPrivateNetworks`);
    }
  }
  if (raw.length > 2048) throw new ApiError('bad_request', 400, 'the URL is longer than 2048 characters');
  return u;
}

export interface HttpResult {
  /** HTTP status, when the server answered. */
  status?: number;
  retryAfterSeconds?: number;
  /** Network error (refused, timeout, SSRF guard...). */
  error?: string;
  /** The SSRF guard refused the address: not worth retrying. */
  refused?: boolean;
  durationMs: number;
}

/** POST a body; resolves (never rejects) with the outcome. Reads at most 4 KB of the answer and drops it. */
export function postOnce(
  url: string,
  body: string,
  headers: Record<string, string>,
  opts: OutboundPolicy & { timeoutMs: number; signal?: AbortSignal; userAgent?: string }
): Promise<HttpResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = checkTargetUrl(url, opts);
    } catch (e) {
      resolve({ error: (e as Error).message, refused: true, durationMs: 0 });
      return;
    }
    let done = false;
    const finish = (r: Omit<HttpResult, 'durationMs'>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...r, durationMs: Date.now() - started });
    };
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      {
        method: 'POST',
        lookup: opts.allowPrivateNetworks ? undefined : publicOnlyLookup,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'user-agent': opts.userAgent ?? userAgent('Webhooks'),
          ...headers,
        },
        signal: opts.signal,
      },
      (res: IncomingMessage) => {
        let read = 0;
        res.on('data', (c: Buffer) => {
          read += c.length;
          if (read > 4096) res.destroy();
        });
        const end = () => finish({ status: res.statusCode ?? 0, ...retryAfter(res.headers['retry-after']) });
        res.on('end', end);
        res.on('close', end);
        res.on('error', end);
      }
    );
    // One deadline for connect + send + answer.
    const timer = setTimeout(() => {
      req.destroy(new Error(`timed out after ${opts.timeoutMs} ms`));
    }, opts.timeoutMs);
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ESSRF') return finish({ error: e.message, refused: true });
      finish({ error: e.code && !e.message.includes(e.code) ? `${e.code}: ${e.message}` : e.message });
    });
    req.end(body);
  });
}

function retryAfter(h: string | string[] | undefined): { retryAfterSeconds?: number } {
  const v = Array.isArray(h) ? h[0] : h;
  if (!v) return {};
  if (/^\d+$/.test(v.trim())) return { retryAfterSeconds: Number(v.trim()) };
  const t = Date.parse(v);
  return Number.isFinite(t) ? { retryAfterSeconds: Math.max(0, Math.round((t - Date.now()) / 1000)) } : {};
}

/**
 * How an HTTP answer counts (D-071): 2xx delivered; 408, 425, 429 and 5xx
 * retried; other 4xx and 3xx failed for good (the request will not get
 * better by repeating it); 410 Gone also disables the endpoint.
 */
export function classifyStatus(status: number): 'success' | 'retry' | 'failed' {
  if (status >= 200 && status < 300) return 'success';
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retry';
  return 'failed';
}
