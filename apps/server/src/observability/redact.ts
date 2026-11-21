/**
 * Redaction for everything the server logs or exports (D-051). Log lines are
 * written by many code paths (errors from tools, URLs, provider messages), so
 * redaction runs on the way out, not at each call site:
 *
 *   - API keys (`rf_...`), `Bearer ...` and `Basic ...` credentials;
 *   - passwords in URLs (`postgresql://user:<password>@host`);
 *   - signatures and tokens in query strings (`?sig=`, `token=`, `key=` ...);
 *   - the current value of every secret setting (database URL, provider keys,
 *     licence key, OTLP headers, metrics token, ...), wherever it appears;
 *   - fields whose name says they hold a secret (password, token, apiKey,
 *     authorization, cookie, secret, credential).
 */

export const REDACTED = '[REDACTED]';

const TEXT_RULES: Array<[RegExp, string]> = [
  [/\brf_[A-Za-z0-9_-]{8,}/g, `rf_${REDACTED}`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, `$1:${REDACTED}@`],
  [/([?&](?:sig|signature|token|access_token|key|api_key|apikey|password|secret)=)[^&\s"']+/gi, `$1${REDACTED}`],
];

const SECRET_FIELD = /pass(word)?|secret|token|api[-_]?key|authori[sz]ation|cookie|credential|private[-_]?key|^key$/i;
/** Field names that look like secrets but carry ids (never the key itself). */
const SAFE_FIELDS = new Set(['key_id', 'keyId', 'reelforge.key_id', 'tokens_used']);

/** Shortest secret value replaced by exact match (shorter values would hit ordinary words). */
const MIN_SECRET_LENGTH = 6;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A text redactor for the given secret values (rebuilt when they change). */
export class Redactor {
  private exact: RegExp | null = null;

  constructor(secrets: Iterable<string> = []) {
    this.setSecrets(secrets);
  }

  setSecrets(secrets: Iterable<string>): void {
    const values = [...new Set([...secrets].filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH))];
    // Longest first, so a value containing another is replaced whole.
    values.sort((a, b) => b.length - a.length);
    this.exact = values.length ? new RegExp(values.map(escapeRegExp).join('|'), 'g') : null;
  }

  text(input: string): string {
    let out = this.exact ? input.replace(this.exact, REDACTED) : input;
    for (const [re, to] of TEXT_RULES) out = out.replace(re, to);
    return out;
  }

  /** A JSON-friendly copy of a value: secret-named fields replaced, strings redacted, errors flattened. */
  value(input: unknown, depth = 0): unknown {
    if (typeof input === 'string') return this.text(input);
    if (input === null || typeof input !== 'object') return typeof input === 'bigint' ? String(input) : input;
    if (depth > 6) return '[depth limit]';
    if (input instanceof Error) {
      return { name: input.name, message: this.text(input.message), ...(input.stack ? { stack: this.text(input.stack) } : {}) };
    }
    if (Array.isArray(input)) return input.slice(0, 100).map((v) => this.value(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = SECRET_FIELD.test(k) && !SAFE_FIELDS.has(k) && v !== undefined && v !== null && typeof v !== 'boolean' ? REDACTED : this.value(v, depth + 1);
    }
    return out;
  }
}
