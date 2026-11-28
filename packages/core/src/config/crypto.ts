import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/** `scheme` value of a value encrypted by SecretCipher (ProviderSetting.scheme, Setting.scheme). */
export const ENCRYPTED_SCHEME = 'aes-256-gcm';
export const PLAIN_SCHEME = 'plain';

export const SECRET_KEY_HELP =
  'Set RENDERWELD_SECRET_KEY (or RENDERWELD_SECRET_KEY_FILE, a file holding it) to at least 32 random characters, e.g. `openssl rand -base64 32`, and restart the server. Keep it safe: secrets stored with it cannot be read without it.';

/**
 * AES-256-GCM for secrets stored in the database (provider keys, the licence
 * key). The 256-bit key is derived from RENDERWELD_SECRET_KEY with HKDF-SHA256.
 *
 * Stored form: `v1.<kid>.<iv>.<tag>.<ciphertext>` (base64url parts). `kid`
 * identifies the key (an HMAC of a constant, so it reveals nothing about the
 * key) so a wrong key is reported as such, and key rotation can be added
 * later without a schema change. The setting name is authenticated data, so a
 * ciphertext copied to another setting does not decrypt.
 */
export class SecretCipher {
  private readonly key: Buffer;
  readonly kid: string;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error(`RENDERWELD_SECRET_KEY is too short (at least 32 characters). ${SECRET_KEY_HELP}`);
    this.key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('reelforge-studio'), Buffer.from('settings-encryption-v1'), 32));
    this.kid = createHmac('sha256', this.key).update('reelforge-key-id').digest('base64url').slice(0, 8);
  }

  encrypt(name: string, plaintext: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(name, 'utf8'));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return ['v1', this.kid, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  /** Throws SecretDecryptError (never with the value) when the key is wrong or the data was changed. */
  decrypt(name: string, stored: string): string {
    const parts = stored.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') throw new SecretDecryptError(name, 'unknown encrypted format');
    const [, kid, iv, tag, ct] = parts as [string, string, string, string, string];
    if (kid !== this.kid) throw new SecretDecryptError(name, 'it was encrypted with a different RENDERWELD_SECRET_KEY');
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      d.setAAD(Buffer.from(name, 'utf8'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    } catch {
      throw new SecretDecryptError(name, 'authentication failed (wrong key or changed data)');
    }
  }
}

export class SecretDecryptError extends Error {
  constructor(
    readonly settingName: string,
    readonly reason: string
  ) {
    super(`cannot decrypt the stored value of ${settingName}: ${reason}`);
    this.name = 'SecretDecryptError';
  }
}
