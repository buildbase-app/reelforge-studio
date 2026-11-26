# Security policy

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub: **Security → Report a vulnerability**
(<https://github.com/buildbase-app/reelforge-studio/security/advisories/new>). Include:

- what is affected and the impact;
- steps to reproduce or a proof of concept;
- the version, commit or image tag;
- whether you used AI tools to find or write it (allowed, but say so, and verify
  the finding yourself first; fabricated reports get the reporter blocked).

We aim to acknowledge reports within **3 working days** and to agree a fix and
disclosure timeline with you. We credit reporters who want credit.

## Supported versions

Security fixes go into the latest release on `main`. Older releases are not
patched unless stated in the release notes.

## Scope

The RenderWeld server and Docker image in this repository: the REST API, the MCP endpoint, authentication and API keys, rendering sandboxes (HTML, HyperFrames, Motion Canvas, Remotion), storage, configuration and secrets handling, and the licence check.

Out of scope: findings that need a compromised machine or stolen credentials,
missing security headers on pages without sensitive actions, rate limits on
public pages, and reports from automated scanners without a demonstrated impact.

## Hardening defaults

What the server does by default to isolate agent-supplied scenes, protect its
secrets and limit what anonymous callers see, and how to configure it:
[docs/security/HARDENING.md](docs/security/HARDENING.md).

## Handling secrets

Never paste secrets, licence keys or API keys into issues, pull requests or
reports. If you find a leaked secret belonging to RenderWeld or BuildBase,
report it privately as above.
