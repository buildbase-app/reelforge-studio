import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeFileAtomic } from './fsutil';

/**
 * HMAC signer for time-limited download links, so an agent can hand a plain
 * URL to a person or a tool that cannot send an Authorization header.
 * The key lives in <dataDir>/signing.key (mode 0600), created on first use.
 */
export class UrlSigner {
  private key: Buffer | null = null;

  constructor(private readonly dataDir: string) {}

  async init(): Promise<void> {
    const file = resolve(this.dataDir, 'signing.key');
    try {
      this.key = Buffer.from((await readFile(file, 'utf8')).trim(), 'hex');
    } catch {
      this.key = randomBytes(32);
      await writeFileAtomic(file, this.key.toString('hex') + '\n');
      await chmod(file, 0o600).catch(() => undefined);
    }
  }

  private mac(payload: string): string {
    if (!this.key) throw new Error('UrlSigner not initialised');
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  sign(parts: string[], ttlSeconds: number, now = Date.now()): { expires: number; sig: string } {
    const expires = Math.floor(now / 1000) + ttlSeconds;
    return { expires, sig: this.mac([...parts, String(expires)].join('\n')) };
  }

  verify(parts: string[], expires: number, sig: string, now = Date.now()): boolean {
    if (!Number.isInteger(expires) || expires < Math.floor(now / 1000)) return false;
    const want = Buffer.from(this.mac([...parts, String(expires)].join('\n')));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }
}
