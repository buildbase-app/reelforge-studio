# Draft: request to BuildBase for signed licence answers

**Status: DRAFT, not filed.** Written for issue #26 (D-038 follow-up 1). The
founder decides whether and where to file it (BuildBase's tracker for the
licence API, `saas-os/os`, where earlier ReelForge requests went).

---

**Title:** Licences API: sign `validate` / `activate` / `deactivate` answers (Ed25519) so self-hosted products can verify them offline

**Who asks and why.** ReelForge Studio is a self-hosted video studio sold
through a BuildBase store. Every installation activates its licence key with
`POST /api/v1/licenses/{orgId}/{activate|validate|deactivate}` (the routes
`LicensesApi` in `@buildbase/sdk` 1.8 calls) and validates daily, with a
14-day offline grace period.

**The problem.** The answers (`LicenseCheckView`: `valid`, `reason`, `key`,
`item`, `instance`) are plain JSON over TLS. A self-hosted product cannot tell
a real answer from one made up by a local server: an operator who points DNS
for `api.console.buildbase.app` at their own server and adds their own CA to the
trust store gets `{"valid": true}` for any key. TLS pinning in the product only
moves the problem (and breaks legitimate TLS-intercepting corporate proxies).
The same gap blocks an **offline / air-gapped** licence option, which
enterprise buyers ask for: today there is nothing the product could check
without reaching BuildBase.

**Request.**

1. Sign every licence answer with an organisation-scoped (or
   BuildBase-wide) **Ed25519** key, and publish the public key(s) with a key id
   so products can embed them and rotate:
   - add `signature` (base64url) and `kid` to the response, or an
     `X-BuildBase-Signature: kid=...; sig=...` header;
   - sign a canonical payload that binds the answer to the request, e.g. the
     JCS (RFC 8785) serialisation of
     `{ "v": 1, "org": orgId, "op": "validate", "keyHash": sha256(key), "instance": instanceId, "valid": bool, "reason": string|null, "expiresAt": string|null, "activationLimit": number|null, "activations": number, "issuedAt": iso8601, "nonce": string }`;
   - accept an optional client `nonce` in the request body and echo it in the
     signed payload, so a captured answer cannot be replayed to another
     installation or at another time;
   - include `issuedAt` (server time), so products get a trusted clock reading
     with every check (this also closes "freeze the clock" bypasses).
2. **Signed licence files** for offline installations: an endpoint (or a
   console action) that issues a signed document for one key and one instance
   (`{ org, keyHash, instance, item, notBefore, notAfter, features }`), valid
   for a period the seller chooses, which the product verifies with the same
   public key and never calls home for.
3. Document the public key endpoint, the payload format, the algorithm and
   the rotation policy, and add verification helpers to `@buildbase/sdk`
   behind a server-only entry point (the current package pulls `next`,
   `react` and `react-dom` as peers, which a server image cannot carry;
   ReelForge calls the routes over plain HTTP for that reason, D-035).

**What ReelForge would do with it.** Embed the public key in the release
image, verify every answer (and the nonce and `issuedAt`) before trusting it,
treat an unsigned or wrongly signed answer as "unreachable" (offline grace
rules, no new trust), and offer the signed licence file as the air-gapped
enterprise option (D-028).

**Compatibility.** Additive: existing clients ignore the new fields. Products
can require signatures once BuildBase announces them.

---

_Context: docs/DECISIONS.md D-028, D-035, D-037, D-038, D-039; docs/DEPLOY.md
"Release image and editions"._
