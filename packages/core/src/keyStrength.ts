/**
 * Strength check for operator-supplied secrets that act as API keys
 * (security.bootstrapKey; D-089). Generated keys (`rf_` + 32 random bytes) pass
 * easily; hand-typed or repetitive values do not.
 */
export const MIN_KEY_RANDOM_CHARS = 32;

/** Shannon entropy of the characters in `s`, in bits per character. */
export function entropyBitsPerChar(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Why an `rf_...` key is too weak, or null when it is fine: at least 32
 * URL-safe characters after `rf_`, at least 8 distinct characters and at least
 * 2.75 bits of entropy per character (`openssl rand -hex 24` or
 * `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` both pass).
 */
export function weakKeyReason(key: string): string | null {
  const m = /^rf_([A-Za-z0-9_-]+)$/.exec(key);
  if (!m) return 'must be rf_ followed by URL-safe characters (A-Z, a-z, 0-9, "_", "-")';
  const body = m[1]!;
  if (body.length < MIN_KEY_RANDOM_CHARS) return `needs at least ${MIN_KEY_RANDOM_CHARS} random characters after rf_ (got ${body.length}); generate one with \`openssl rand -hex 24\``;
  if (new Set(body).size < 8 || entropyBitsPerChar(body) < 2.75) return 'is not random enough (too few distinct characters or a repeating pattern); generate one with `openssl rand -hex 24`';
  return null;
}
