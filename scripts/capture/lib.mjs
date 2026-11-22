// Pure helpers of the capture pipeline (no browser, no network, no ffmpeg), so
// the naming, masking, manifest and upload-planning rules are unit tested
// (scripts/capture/capture.test.mjs). docs/CAPTURE.md explains the pipeline.

import { createHash } from 'node:crypto';

export const STEPS = ['pages', 'flows', 'videos', 'studio', 'console'];

/** Parses `pnpm capture` arguments. Unknown arguments are an error. */
export function parseArgs(argv) {
  const args = {
    sites: [],
    only: [...STEPS],
    upload: false,
    dryRun: false,
    out: 'out/capture',
    storeDir: null,
    reel: null,
    blueprint: null,
    routes: null,
    themes: null,
    widths: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a.split('=')[0]} needs a value`);
      return v;
    };
    const list = () => value().split(',').map((s) => s.trim()).filter(Boolean);
    if (a === '--upload') args.upload = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--site')) args.sites.push(value().replace(/\/$/, ''));
    else if (a.startsWith('--only')) {
      const only = list();
      for (const s of only) if (!STEPS.includes(s)) throw new Error(`--only takes ${STEPS.join('|')}, not "${s}"`);
      args.only = only;
    } else if (a.startsWith('--out')) args.out = value();
    else if (a.startsWith('--store-dir')) args.storeDir = value();
    else if (a.startsWith('--reel')) args.reel = value();
    else if (a.startsWith('--blueprint')) args.blueprint = value();
    else if (a.startsWith('--routes')) args.routes = list();
    else if (a.startsWith('--themes')) args.themes = list();
    else if (a.startsWith('--widths')) args.widths = list().map(Number);
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** `/` → `home`, `/docs/start/quick-start` → `docs-start-quick-start`. */
export function routeSlug(route) {
  const path = route.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
  if (!path) return 'home';
  return path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** `https://reelforge-dev.buildbase.app` → `dev`, production → `prod`, anything else → its host. */
export function siteLabel(site) {
  const host = new URL(site).host;
  if (/^reelforge-dev\./.test(host)) return 'dev';
  if (/^reelforge\./.test(host)) return 'prod';
  return host.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

/**
 * The deterministic key of one image: the same page, site, width, theme and
 * crop always map to the same key (and file name), whatever the run.
 */
export function shotKey({ group, site, slug, width, theme, crop }) {
  return [group, site, slug, width && `${width}`, theme, crop].filter(Boolean).join('--');
}

/** The asset name in BuildBase: the key plus the first 8 hex of the content hash. */
export function assetName(key, hash, ext = 'webp') {
  return `rf-capture--${key}--${hash.slice(0, 8)}.${ext}`;
}

export const ASSET_PREFIX = 'rf-capture--';

/** Recovers the key and short hash from an asset name, or null. */
export function parseAssetName(name) {
  const m = /^rf-capture--(.+)--([0-9a-f]{8})\.[a-z0-9]+$/.exec(name ?? '');
  return m ? { key: m[1], hash8: m[2] } : null;
}

// ── Masking ──────────────────────────────────────────────────────────────

/** Licence keys as the store issues them (five groups of five). */
export const LICENCE_KEY = /\b[A-Z0-9]{5}(?:-[A-Z0-9]{5}){4}\b/g;
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** Studio API keys, Stripe secrets, bearer tokens, signed download links. */
export const TOKEN =
  /\b(?:rf_[A-Za-z0-9_]{12,}|sk_(?:test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)|(?<=Bearer\s)[A-Za-z0-9._~+/-]{16,}|(?<=[?&]sig=)[A-Za-z0-9_-]{16,}/g;

export const MASK = {
  key: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX',
  email: 'name@example.com',
  token: '••••••••',
};

/** Public addresses that may stay readable in captures (printed on the site itself). */
export const DEFAULT_ALLOWED_EMAILS = ['noreply@anthropic.com'];

/** Replaces licence keys, emails (except allowed ones) and tokens in text. */
export function maskText(text, { allowEmails = DEFAULT_ALLOWED_EMAILS } = {}) {
  const allowed = new Set(allowEmails.map((e) => e.toLowerCase()));
  return String(text)
    .replace(LICENCE_KEY, MASK.key)
    .replace(TOKEN, MASK.token)
    .replace(EMAIL, (m) => (allowed.has(m.toLowerCase()) || m === MASK.email ? m : MASK.email));
}

/** What would leak if this text were published: returns a list of findings (kind + a short, masked hint). */
export function findSecrets(text, { allowEmails = DEFAULT_ALLOWED_EMAILS } = {}) {
  const allowed = new Set(allowEmails.map((e) => e.toLowerCase()));
  const found = [];
  const hint = (s) => `${s.slice(0, 3)}…(${s.length})`;
  for (const m of String(text).matchAll(LICENCE_KEY)) if (m[0] !== MASK.key) found.push({ kind: 'licence-key', hint: hint(m[0]) });
  for (const m of String(text).matchAll(TOKEN)) found.push({ kind: 'token', hint: hint(m[0]) });
  for (const m of String(text).matchAll(EMAIL)) {
    if (!allowed.has(m[0].toLowerCase()) && m[0] !== MASK.email) found.push({ kind: 'email', hint: hint(m[0]) });
  }
  return found;
}

/**
 * The script injected into every page and frame before it loads: hides the
 * value of email/password inputs and rewrites licence keys, emails and tokens
 * in text nodes and input values as they appear (MutationObserver). It is a
 * string so the browser runs it as is; the patterns are the ones above.
 */
export function maskingInitScript({ allowEmails = DEFAULT_ALLOWED_EMAILS } = {}) {
  return `(() => {
  const KEY = ${LICENCE_KEY};
  const EMAIL = ${EMAIL};
  const TOKEN = ${TOKEN};
  const ALLOWED = new Set(${JSON.stringify(allowEmails.map((e) => e.toLowerCase()))});
  const mask = (s) => s.replace(KEY, ${JSON.stringify(MASK.key)}).replace(TOKEN, ${JSON.stringify(MASK.token)})
    .replace(EMAIL, (m) => (ALLOWED.has(m.toLowerCase()) ? m : ${JSON.stringify(MASK.email)}));
  const test = (s) => { KEY.lastIndex = 0; EMAIL.lastIndex = 0; TOKEN.lastIndex = 0;
    return KEY.test(s) || TOKEN.test(s) || [...s.matchAll(EMAIL)].some((m) => !ALLOWED.has(m[0].toLowerCase()) && m[0] !== ${JSON.stringify(MASK.email)}); };
  const fixNode = (n) => { if (n.nodeType === 3 && n.nodeValue && test(n.nodeValue)) n.nodeValue = mask(n.nodeValue); };
  const fixInput = (el) => {
    if (!el || !('value' in el) || typeof el.value !== 'string') return;
    const t = (el.getAttribute('type') || '').toLowerCase();
    if (t === 'email' || t === 'password' || /mail/i.test(el.name || '') || /mail/i.test(el.autocomplete || '') || test(el.value)) {
      el.style.setProperty('-webkit-text-security', 'disc', 'important');
    }
  };
  const walk = (root) => {
    if (!root) return;
    if (root.nodeType === 3) return fixNode(root);
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) fixNode(n);
    if (root.querySelectorAll) root.querySelectorAll('input, textarea').forEach(fixInput);
    if (root.matches && root.matches('input, textarea')) fixInput(root);
  };
  const start = () => {
    walk(document.documentElement);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') fixNode(r.target);
        else if (r.type === 'attributes') fixInput(r.target);
        else r.addedNodes.forEach(walk);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['value', 'type'] });
    document.addEventListener('input', (e) => fixInput(e.target), true);
  };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
})();`;
}

const SECRET_KEY = /secret|token|password|passwd|signing|private|credential|apikey|api_key|preview/i;

/**
 * Redacts a configuration object for publishing: values under secret-looking
 * keys become "[redacted]" (a `${env:NAME}` placeholder stays, it names no
 * value; a URL under a `…Url` key stays), and emails, keys and tokens in
 * any string are masked. Pure; returns a new object.
 */
export function redactConfig(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => redactConfig(v, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactConfig(v, k)]));
  if (typeof value !== 'string') return value;
  if (/^\$\{env:[A-Z0-9_]+\}$/.test(value)) return value;
  if (SECRET_KEY.test(key) && !(/Urls?$/.test(key) && /^https?:\/\//.test(value))) return '[redacted]';
  return maskText(value);
}

/** Stills only: no animation, transition, caret or smooth scrolling. Videos keep motion. */
export const STILL_CSS = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}
html{scroll-behavior:auto!important}`;

// ── Image budgets ────────────────────────────────────────────────────────

export const WEBP_MAX_DIMENSION = 16383;

/** Byte budgets: fold crops are the grid thumbnails, full pages open on click. */
export const BUDGETS = { fold: 150_000, full: 400_000 };

/**
 * The encode ladder for one image: target width (css width for a full page,
 * device pixels for a fold crop), then quality steps, then smaller widths,
 * until the file fits the budget. A full page is never narrower than 3/4 of
 * its css width (it must stay readable) nor taller than WebP allows.
 */
export function encodeLadder({ width, height, crop, maxBytes = BUDGETS[crop] ?? BUDGETS.fold }) {
  const base = crop === 'full' ? width / 2 : width; // full pages at 1x, fold crops at 2x
  const steps = [];
  for (const scale of crop === 'full' ? [1, 0.75] : [1, 0.75, 0.5]) {
    let w = Math.round(base * scale);
    let h = Math.round((height * w) / width);
    if (h > WEBP_MAX_DIMENSION) {
      w = Math.floor((w * WEBP_MAX_DIMENSION) / h);
      h = WEBP_MAX_DIMENSION;
    }
    for (const quality of [80, 70, 60, 50, 40]) steps.push({ width: w, height: h, quality, maxBytes });
  }
  return steps;
}

// ── Manifest and idempotent uploads ──────────────────────────────────────

/** Loads a manifest object or an empty one. */
export function emptyManifest() {
  return { $comment: 'Written by pnpm capture (scripts/capture). One entry per captured file: key, content hash, BuildBase asset id and URL, and the docs page that shows it. Re-runs replace entries by key.', images: {}, videos: {} };
}

/**
 * Decides what an upload run does. `local` is the list of captured files
 * ({ key, sha256, file }), `manifest.images` the last known state, `remote`
 * the assets found in BuildBase under the capture prefix. Returns actions:
 *   skip   same key and hash as the manifest, and the asset still exists
 *   reuse  an asset with this key and hash already exists (lost manifest)
 *   upload no asset holds this content yet
 *   delete an older asset of the same key (replaced), or a stray duplicate
 * so a re-run never duplicates and a changed image replaces the old one.
 */
export function planUploads(local, manifest, remote) {
  const remoteById = new Map(remote.map((a) => [a._id, a]));
  const remoteByKey = new Map();
  for (const a of remote) {
    const parsed = parseAssetName(a.name);
    if (!parsed) continue;
    if (!remoteByKey.has(parsed.key)) remoteByKey.set(parsed.key, []);
    remoteByKey.get(parsed.key).push({ ...a, hash8: parsed.hash8 });
  }
  const actions = [];
  const keep = new Set();
  for (const item of local) {
    const known = manifest.images?.[item.key];
    const candidates = remoteByKey.get(item.key) ?? [];
    if (known && known.sha256 === item.sha256 && remoteById.has(known.assetId)) {
      actions.push({ type: 'skip', key: item.key, assetId: known.assetId });
      keep.add(known.assetId);
    } else {
      const same = candidates.find((a) => a.hash8 === item.sha256.slice(0, 8));
      if (same) {
        actions.push({ type: 'reuse', key: item.key, assetId: same._id, asset: same });
        keep.add(same._id);
      } else {
        actions.push({ type: 'upload', key: item.key, file: item.file, sha256: item.sha256, name: assetName(item.key, item.sha256) });
      }
    }
    for (const a of candidates) if (!keep.has(a._id)) actions.push({ type: 'delete', key: item.key, assetId: a._id, reason: 'replaced' });
  }
  // Keep only one delete per asset, and never one for an asset we keep.
  const seen = new Set();
  return actions.filter((a) => {
    if (a.type !== 'delete') return true;
    if (keep.has(a.assetId) || seen.has(a.assetId)) return false;
    seen.add(a.assetId);
    return true;
  });
}

/** Applies upload results to the manifest (pure: returns a new object). */
export function applyUploadResults(manifest, results) {
  const next = structuredClone(manifest);
  next.images ??= {};
  for (const r of results) {
    if (r.type === 'delete') continue;
    const prev = next.images[r.key] ?? {};
    next.images[r.key] = { ...prev, ...r.entry };
    delete next.images[r.key].pending;
    delete next.images[r.key].uploadedSha256;
  }
  return next;
}

const VOLATILE = new Set(['file', 'overBudget']);

/**
 * Merges what a run captured into the manifest (pure). An entry keeps its
 * asset id and URL; when the content changed it is marked `pending` until
 * the next `--upload`, and the docs keep showing the last uploaded image.
 */
export function mergeCaptured(manifest, images, videos = []) {
  const next = structuredClone(manifest);
  next.images ??= {};
  next.videos ??= {};
  for (const img of images) {
    const prev = next.images[img.key] ?? {};
    const meta = Object.fromEntries(Object.entries(img).filter(([k, v]) => !VOLATILE.has(k) && k !== 'key' && v !== undefined));
    const changed = prev.sha256 !== img.sha256;
    next.images[img.key] = { ...prev, ...meta, pending: changed || !prev.assetId ? true : undefined };
    if (!next.images[img.key].pending) delete next.images[img.key].pending;
    if (changed && prev.sha256) next.images[img.key].uploadedSha256 = prev.uploadedSha256 ?? prev.sha256;
  }
  for (const v of videos) next.videos[v.slug] = { ...(next.videos[v.slug] ?? {}), ...v };
  return next;
}

/** Sorts object keys so the committed manifest diff stays small and stable. */
export function stableJson(value) {
  const sort = (v) =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** `1536000` → `1.5 MB`, `86000` → `84 KB`. */
export function formatBytes(n) {
  if (n >= 1_000_000) return `${(n / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
