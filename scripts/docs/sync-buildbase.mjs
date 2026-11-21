#!/usr/bin/env node
// Publishes the public docs from this repository to BuildBase Docs.
//
//   node scripts/docs/sync-buildbase.mjs --env <environment key | production> [--dry-run] [--json]
//
// Reads the allowlist docs/public/manifest.json, turns every listed Markdown
// file into a doc page and makes BuildBase Docs match: creates missing folders
// and tags, creates or updates pages matched by path, archives (never deletes)
// pages whose file left the allowlist, and never touches a page it did not
// create. A second run with nothing changed writes nothing and says so.
//
// Credentials only from the environment, never from arguments:
//   BUILDBASE_API_TOKEN or BUILDBASE_API_TOKEN_FILE   org API token, "<orgId>[-<env>]:<secret>"
//   BUILDBASE_SERVER_URL                              default https://api.console.buildbase.app
// `--env` must name the environment the token belongs to, so a token for
// production cannot be used by accident (and the reverse).
//
// Node 22+, no dependencies. Behind an HTTPS proxy set NODE_USE_ENV_PROXY=1.
// docs/DOCS_PUBLISHING.md has the details; decisions D-080..D-082.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesiredDocs, summarize, syncDocs } from './sync-lib.mjs';

export const DEFAULT_SERVER_URL = 'https://api.console.buildbase.app';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A thin client for the organization API's docs routes. */
export function createDocsApi({ serverUrl = DEFAULT_SERVER_URL, token, fetchImpl = fetch, userAgent = 'reelforge-docs-sync' }) {
  const base = serverUrl.replace(/\/$/, '');
  async function call(method, path, body) {
    // GET and PATCH are safe to repeat; a POST is only retried when it was
    // refused before it ran (429), so a lost answer never creates a duplicate.
    const repeatable = method !== 'POST';
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${base}/api/${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'User-Agent': userAgent,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        if (!repeatable) throw e;
        lastError = e;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (res.status === 429 || (repeatable && res.status >= 500)) {
        lastError = new Error(`${method} /api/${path}: HTTP ${res.status}`);
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const message = (parsed && typeof parsed === 'object' && (parsed.message || parsed.error?.message || parsed.error)) || text.slice(0, 200);
        throw new Error(`${method} /api/${path}: HTTP ${res.status} ${typeof message === 'string' ? message : JSON.stringify(message)}`);
      }
      if (parsed && typeof parsed === 'object' && parsed.success === false) {
        throw new Error(`${method} /api/${path}: the API saved nothing (${parsed.message ?? 'success: false'})`);
      }
      return parsed && typeof parsed === 'object' && 'data' in parsed && !('docs' in parsed) ? parsed.data : parsed;
    }
    throw lastError;
  }
  async function listAll(path, extra = '') {
    const out = [];
    for (let page = 1; page <= 100; page++) {
      const body = await call('GET', `${path}?$limit=500&$page=${page}${extra}`);
      const docs = Array.isArray(body) ? body : body?.docs ?? [];
      out.push(...docs);
      if (Array.isArray(body) || !body?.hasNextPage) break;
    }
    return out;
  }
  return {
    listFolders: () => listAll('docs/folders'),
    createFolder: (body) => call('POST', 'docs/folders', body),
    archiveFolder: (id, archived) => call('PATCH', `docs/folders/${id}/archive`, { archived }),
    listTags: () => listAll('docs/tags'),
    createTag: (body) => call('POST', 'docs/tags', body),
    updateTag: (id, body) => call('PATCH', `docs/tags/${id}`, body),
    archiveTag: (id, archived) => call('PATCH', `docs/tags/${id}/archive`, { archived }),
    listDocs: () => listAll('docs', '&draftPreview=true'),
    createDoc: (title) => call('POST', 'docs', { title }),
    updateDoc: (id, patch) => call('PATCH', `docs/${id}`, patch),
    getByPath: (path) => call('GET', `docs/path?path=${encodeURIComponent(path)}`),
    tree: () => call('GET', 'docs/folders/tree'),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The token from BUILDBASE_API_TOKEN or the file named by BUILDBASE_API_TOKEN_FILE. */
export function readToken(env = process.env) {
  if (env.BUILDBASE_API_TOKEN_FILE) return readFileSync(env.BUILDBASE_API_TOKEN_FILE, 'utf8').trim();
  return (env.BUILDBASE_API_TOKEN ?? '').trim();
}

/**
 * Checks that the token belongs to the environment named on the command line:
 * production tokens are "<orgId>:<secret>", environment tokens
 * "<orgId>-<key>:<secret>". Returns the org id. Never echoes the secret.
 */
export function checkTokenEnvironment(token, envName, expectedOrgId) {
  const colon = token.indexOf(':');
  if (colon < 1 || colon === token.length - 1) throw new Error('the API token is not in the "<orgId>[-<env>]:<secret>" form');
  const tenant = token.slice(0, colon);
  const dash = tenant.indexOf('-');
  const orgId = dash === -1 ? tenant : tenant.slice(0, dash);
  const tokenEnv = dash === -1 ? 'production' : tenant.slice(dash + 1);
  if (tokenEnv !== envName) {
    throw new Error(`--env ${envName} was given, but the API token belongs to the environment "${tokenEnv}"`);
  }
  if (expectedOrgId && orgId !== expectedOrgId) {
    throw new Error(`the API token belongs to organization ${orgId}, not BUILDBASE_ORG_ID ${expectedOrgId}`);
  }
  return orgId;
}

function parseArgs(argv) {
  const args = { dryRun: false, json: false, env: null, manifest: 'docs/public/manifest.json', root: REPO_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a.startsWith('--env')) args.env = value();
    else if (a.startsWith('--manifest')) args.manifest = value();
    else if (a.startsWith('--root')) args.root = resolve(value());
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/** Reads the allowlist and its files from `root` and returns the desired state. */
export function loadDesired(root, manifestPath) {
  const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'));
  const desired = buildDesiredDocs(manifest, (rel) => readFileSync(join(root, rel), 'utf8'));
  return {
    manifest,
    desired,
    ownerTag: manifest.ownerTag ?? { slug: 'source-repo', title: 'Source: repository' },
    archivedTag: manifest.archivedTag ?? { slug: 'source-archived', title: 'Source: archived' },
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: node scripts/docs/sync-buildbase.mjs --env <environment key | production> [--dry-run] [--json] [--manifest path] [--root dir]');
    return 0;
  }
  if (!args.env) throw new Error('--env is required: the environment key (e.g. fsyqdskf) or "production"');
  const token = readToken(env);
  if (!token) throw new Error('set BUILDBASE_API_TOKEN or BUILDBASE_API_TOKEN_FILE');
  checkTokenEnvironment(token, args.env, env.BUILDBASE_ORG_ID);

  const { desired, ownerTag, archivedTag } = loadDesired(args.root, args.manifest);
  const api = createDocsApi({ serverUrl: env.BUILDBASE_SERVER_URL || DEFAULT_SERVER_URL, token });
  const result = await syncDocs({
    api,
    desired,
    ownerTag,
    archivedTag,
    dryRun: args.dryRun,
    log: args.json ? () => {} : (line) => console.log(`${args.dryRun ? '[dry run] ' : ''}${line}`),
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`\n${desired.docs.length} pages in the allowlist (environment: ${args.env}).\n${summarize(result)}`);
  return result.docs.conflicts.length ? 2 : 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`docs sync failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  );
}
