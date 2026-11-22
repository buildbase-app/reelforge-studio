import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Standard Webhooks symmetric signatures (https://www.standardwebhooks.com,
 * spec/standard-webhooks.md, checked 2026-11-21; research/SOURCES.md):
 *
 *   signed content  = `${webhook-id}.${webhook-timestamp}.${body}`
 *   signature       = base64(HMAC-SHA256(key = base64decode(secret without "whsec_"), signed content))
 *   webhook-signature: v1,<signature>[ v1,<signature of the previous secret>]
 *
 * Verified against the reference libraries' test vector (test/webhooks.test.ts, WHK-01).
 */

export const SECRET_PREFIX = 'whsec_';

/** A new signing secret: `whsec_` + base64 of 32 random bytes (24..64 bytes per the spec). */
export function newSigningSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString('base64');
}

function secretKey(secret: string): Buffer {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const key = Buffer.from(raw, 'base64');
  if (key.length === 0) throw new Error('the signing secret is empty');
  return key;
}

/** `v1,<base64>` for one secret. `timestamp` is unix seconds. */
export function signPayload(secret: string, messageId: string, timestamp: number, body: string): string {
  const mac = createHmac('sha256', secretKey(secret)).update(`${messageId}.${timestamp}.${body}`, 'utf8').digest('base64');
  return `v1,${mac}`;
}

/** The three Standard Webhooks headers; several secrets (rotation overlap) give space-separated signatures. */
export function signatureHeaders(secrets: string[], messageId: string, timestamp: number, body: string): { 'webhook-id': string; 'webhook-timestamp': string; 'webhook-signature': string } {
  return {
    'webhook-id': messageId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': secrets.map((s) => signPayload(s, messageId, timestamp, body)).join(' '),
  };
}

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureError';
  }
}

/**
 * Receiver-side check (tests, the Docker e2e receiver, docs): the timestamp
 * within `toleranceSeconds` (default 5 min) and at least one `v1` signature
 * matching. Unknown versions and malformed entries are skipped.
 */
export function verifySignature(
  secret: string,
  headers: Record<string, string | undefined>,
  body: string,
  opts: { toleranceSeconds?: number; now?: number } = {}
): void {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sig = headers['webhook-signature'];
  if (!id || !ts || !sig) throw new SignatureError('missing webhook-id, webhook-timestamp or webhook-signature');
  const t = Number(ts);
  if (!/^\d+$/.test(ts) || !Number.isFinite(t)) throw new SignatureError('invalid webhook-timestamp');
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const tol = opts.toleranceSeconds ?? 300;
  if (now - t > tol) throw new SignatureError('message timestamp too old');
  if (t - now > tol) throw new SignatureError('message timestamp too new');
  const expected = Buffer.from(signPayload(secret, id, t, body).slice(3), 'base64');
  for (const part of sig.split(' ')) {
    const [version, value] = part.split(',', 2);
    if (version !== 'v1' || !value) continue;
    const given = Buffer.from(value, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return;
  }
  throw new SignatureError('no matching signature');
}
