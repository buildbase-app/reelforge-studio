import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { AuthContext, Scope } from '@reelforge/core';

/**
 * MCP authorization (#305, D-112): ReelForge as an OAuth 2.1 resource server
 * per the MCP authorization specification. An authorization server you run
 * (Keycloak, Auth0, Entra ID, Okta, ...) issues JWT access tokens; /mcp
 * accepts them next to API keys. ReelForge never issues tokens, never sees
 * user passwords and never passes a token on.
 *
 *   - Protected-resource metadata (RFC 9728) at
 *     /.well-known/oauth-protected-resource and .../mcp, naming the issuer.
 *   - A 401 from /mcp carries `WWW-Authenticate: Bearer resource_metadata=...`.
 *   - Tokens: JWT (RFC 9068 profile) signed with an asymmetric key from the
 *     issuer's JWKS; `iss` must be the issuer, `aud` must contain the
 *     audience (the MCP endpoint URL, RFC 8707), `exp` in the future.
 *   - Scopes: `renderweld:read`, `renderweld:write`, `renderweld:render`, `renderweld:admin`
 *     (and the old `reelforge:*` names, #413) in `scope` (space-separated) or `scp`
 *     (array) map to RenderWeld's scopes.
 */
export interface OAuthSettings {
  /** The authorization server's issuer identifier (exact `iss`). */
  issuer: string;
  /** What `aud` must contain: the MCP endpoint's canonical URL. */
  audience: string;
  /** JWKS URL; unset: `jwks_uri` from the issuer's metadata (RFC 8414, then OpenID discovery). */
  jwksUrl?: string;
}

/** Token scopes: the RenderWeld names, then the old ReelForge names (accepted until phase 7, #416; docs/RENAMED.md). */
export const OAUTH_SCOPES: Record<string, Scope> = {
  'renderweld:read': 'read',
  'renderweld:write': 'write',
  'renderweld:render': 'render',
  'renderweld:admin': 'admin',
  'reelforge:read': 'read',
  'reelforge:write': 'write',
  'reelforge:render': 'render',
  'reelforge:admin': 'admin',
};

export type OAuthResult = { ok: true; auth: AuthContext; subject: string } | { ok: false; error: 'invalid_token' | 'insufficient_scope'; description: string };

/** Accepted signature algorithms: asymmetric only (a shared-secret HS* token could be forged by anyone holding the secret). */
const ALGS: Record<string, { hash: string; kty: string; opts?: { padding?: number; saltLength?: number; dsaEncoding?: 'ieee-p1363' } }> = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  RS384: { hash: 'sha384', kty: 'RSA' },
  RS512: { hash: 'sha512', kty: 'RSA' },
  PS256: { hash: 'sha256', kty: 'RSA', opts: { padding: 6, saltLength: 32 } },
  PS384: { hash: 'sha384', kty: 'RSA', opts: { padding: 6, saltLength: 48 } },
  PS512: { hash: 'sha512', kty: 'RSA', opts: { padding: 6, saltLength: 64 } },
  ES256: { hash: 'sha256', kty: 'EC', opts: { dsaEncoding: 'ieee-p1363' } },
  ES384: { hash: 'sha384', kty: 'EC', opts: { dsaEncoding: 'ieee-p1363' } },
  ES512: { hash: 'sha512', kty: 'EC', opts: { dsaEncoding: 'ieee-p1363' } },
  EdDSA: { hash: '', kty: 'OKP' },
};

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/; // an empty signature (alg none) is still a JWT, refused below
const SKEW_S = 60;
const JWKS_TTL_MS = 10 * 60_000;
const JWKS_REFRESH_MIN_MS = 30_000;

/** A compact JWS: the only token form /mcp checks with the issuer's keys (API keys start with rf_). */
export function looksLikeJwt(token: string): boolean {
  return token.length < 16_384 && JWT.test(token);
}

function b64json(part: string): Record<string, unknown> {
  const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a JSON object');
  return v as Record<string, unknown>;
}

/** RenderWeld scopes from the token's `scope` (space-separated) or `scp` (array) claim; unknown values are ignored. */
export function scopesFromClaims(claims: Record<string, unknown>): Scope[] {
  const raw = typeof claims.scope === 'string' ? claims.scope.split(' ') : Array.isArray(claims.scp) ? claims.scp.filter((s): s is string => typeof s === 'string') : [];
  return [...new Set(raw.map((s) => OAUTH_SCOPES[s]).filter((s): s is Scope => Boolean(s)))];
}

/** RFC 9728 metadata for the MCP endpoint. */
export function protectedResourceMetadata(s: OAuthSettings) {
  return {
    resource: s.audience,
    authorization_servers: [s.issuer],
    scopes_supported: Object.keys(OAUTH_SCOPES),
    bearer_methods_supported: ['header'],
    resource_name: 'RenderWeld MCP',
    resource_documentation: 'https://github.com/buildbase-app/reelforge-studio/blob/main/docs/DEPLOY.md#mcp-oauth',
  };
}

/** Where RFC 9728 puts the metadata of a resource URL: /.well-known/oauth-protected-resource + the resource's path. */
export function resourceMetadataUrl(audience: string): string {
  const u = new URL(audience);
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  return `${u.origin}/.well-known/oauth-protected-resource${path}`;
}

/** RFC 8414 metadata locations of an issuer (path inserted after the well-known prefix), then OpenID discovery. */
function metadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  return [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`];
}

/** Checks access tokens against the issuer's keys. One per server; keys are cached and refetched for an unknown `kid`. */
export class OAuthVerifier {
  private keys = new Map<string, { key: KeyObject; jwk: JsonWebKey }>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;
  private jwksUri: string | undefined;

  constructor(
    readonly settings: OAuthSettings,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {
    this.jwksUri = settings.jwksUrl;
  }

  async verify(token: string): Promise<OAuthResult> {
    const bad = (description: string): OAuthResult => ({ ok: false, error: 'invalid_token', description });
    if (!looksLikeJwt(token)) return bad('not a JWT access token');
    const [h, p, sig] = token.split('.') as [string, string, string];
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = b64json(h);
      claims = b64json(p);
    } catch {
      return bad('the token is not valid JSON');
    }
    const alg = typeof header.alg === 'string' ? ALGS[header.alg] : undefined;
    if (!alg) return bad(`algorithm ${JSON.stringify(header.alg)} is not accepted (asymmetric signatures only)`);
    if (header.crit !== undefined) return bad('critical header parameters are not supported');
    const kid = typeof header.kid === 'string' ? header.kid : undefined;
    let entry: { key: KeyObject; jwk: JsonWebKey } | undefined;
    try {
      entry = await this.key(kid, alg.kty);
    } catch (e) {
      return bad(`the issuer's keys could not be read: ${(e as Error).message}`);
    }
    if (!entry) return bad('no key of the issuer matches the token (kid)');
    if (entry.jwk.alg && entry.jwk.alg !== header.alg) return bad('the key is not for this algorithm');
    const ok = verifySignature(alg.hash || null, Buffer.from(`${h}.${p}`), { key: entry.key, ...(alg.opts ?? {}) }, Buffer.from(sig, 'base64url'));
    if (!ok) return bad('bad signature');
    const now = Math.floor(this.now() / 1000);
    if (claims.iss !== this.settings.issuer) return bad('wrong issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.settings.audience)) return bad(`the token is not for this server (aud must contain ${this.settings.audience})`);
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S <= now) return bad('the token has expired');
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW_S > now) return bad('the token is not valid yet');
    if (typeof claims.sub !== 'string' || !claims.sub) return bad('the token has no subject (sub)');
    const scopes = scopesFromClaims(claims);
    if (!scopes.length) return { ok: false, error: 'insufficient_scope', description: `the token carries none of ${Object.keys(OAUTH_SCOPES).join(', ')}` };
    const client = typeof claims.client_id === 'string' ? claims.client_id : typeof claims.azp === 'string' ? claims.azp : undefined;
    return {
      ok: true,
      subject: claims.sub,
      // The rate limit, quotas and audit trail count per subject, like per key.
      auth: { keyId: `oauth:${claims.sub}`.slice(0, 200), name: `oauth ${client ? `${client} for ` : ''}${claims.sub}`.slice(0, 200), scopes },
    };
  }

  private async key(kid: string | undefined, kty: string): Promise<{ key: KeyObject; jwk: JsonWebKey } | undefined> {
    const find = () => {
      if (kid) return this.keys.get(kid);
      const same = [...this.keys.values()].filter((k) => k.jwk.kty === kty);
      return same.length === 1 ? same[0] : undefined; // without kid only an unambiguous key
    };
    const age = this.now() - this.fetchedAt;
    if (age > JWKS_TTL_MS) await this.refresh();
    let found = find();
    // A key the issuer added since (rotation): fetch again, at most every 30 s.
    if (!found && age > JWKS_REFRESH_MIN_MS) {
      await this.refresh();
      found = find();
    }
    return found && found.jwk.kty === kty ? found : undefined;
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<void> {
    if (!this.jwksUri) {
      for (const url of metadataUrls(this.settings.issuer)) {
        const r = await this.fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'error' }).catch(() => null);
        if (!r?.ok) continue;
        const m = (await r.json().catch(() => null)) as { issuer?: unknown; jwks_uri?: unknown } | null;
        if (m && m.issuer === this.settings.issuer && typeof m.jwks_uri === 'string') {
          this.jwksUri = m.jwks_uri;
          break;
        }
      }
      if (!this.jwksUri) throw new Error(`no authorization server metadata with jwks_uri for ${this.settings.issuer}`);
    }
    const r = await this.fetchImpl(this.jwksUri, { headers: { accept: 'application/json' }, redirect: 'error' });
    if (!r.ok) throw new Error(`JWKS ${r.status}`);
    const body = (await r.json()) as { keys?: unknown };
    const keys = new Map<string, { key: KeyObject; jwk: JsonWebKey }>();
    for (const [i, jwk] of (Array.isArray(body.keys) ? (body.keys as JsonWebKey[]) : []).entries()) {
      if (!jwk || typeof jwk !== 'object' || (jwk.use && jwk.use !== 'sig') || !['RSA', 'EC', 'OKP'].includes(String(jwk.kty))) continue;
      try {
        // Public parts only: a JWKS that leaks a private key must not make us accept tokens signed by anyone holding it.
        const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...pub } = jwk;
        keys.set(typeof jwk.kid === 'string' ? jwk.kid : `#${i}`, { key: createPublicKey({ key: pub, format: 'jwk' }), jwk: pub });
      } catch {
        // an unusable key is skipped
      }
    }
    this.keys = keys;
    this.fetchedAt = this.now();
  }
}
