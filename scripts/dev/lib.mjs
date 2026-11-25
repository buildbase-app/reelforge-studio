// Helpers shared by `pnpm dev:setup` (setup.mjs) and `pnpm dev:all` (dev-all.mjs).
// Node built-ins only: setup runs before `pnpm install`. Unit tests: dev.test.ts.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statfsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export const STUDIO_PORT = 4321;
export const SITE_PORT = 3000;
export const MOCK_LICENCE_PORT = 4399;
/** The release image ships FFmpeg 5.1 (Debian bookworm); the pipeline needs at least that. */
export const MIN_FFMPEG = [5, 1];
/** Encoders and filters the render pipeline uses (media-pipeline: assemble, audio, captions). */
export const FFMPEG_ENCODERS = ['libx264', 'aac'];
export const FFMPEG_FILTERS = ['alimiter', 'ebur128', 'loudnorm', 'ass'];
/** A fresh install (node_modules, Prisma clients, Chrome Headless Shell) takes about 1.5 GB; renders need room too. */
export const MIN_FREE_BYTES = 3 * 1024 ** 3;

// ---------- versions ----------

/** "v22.11.0" or "22" -> [22, 11, 0]; null when there is no number. */
export function parseVersion(text) {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(text ?? ''));
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

/** -1, 0 or 1, comparing as many parts as both have (missing parts are 0). */
export function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The version in the first line of `ffmpeg -version`:
 *   "ffmpeg version 6.1.1-3ubuntu5 ..."             -> [6, 1, 1]
 *   "ffmpeg version n7.0.2 ..." (static builds)       -> [7, 0, 2]
 *   "ffmpeg version 7.1-essentials_build-www.gyan.dev" -> [7, 1, 0]
 *   "ffmpeg version N-118000-g1234abcd ..." (git)     -> null (a snapshot: newer than any release)
 */
export function parseFfmpegVersion(output) {
  const m = /^(?:ffmpeg|ffprobe) version (\S+)/m.exec(String(output ?? ''));
  if (!m) return null;
  const v = m[1];
  if (/^N-/.test(v) || /^git-/.test(v)) return null;
  const n = /^n?(\d+)\.(\d+)(?:\.(\d+))?/.exec(v);
  return n ? [Number(n[1]), Number(n[2]), Number(n[3] ?? 0)] : null;
}

/** Names in `ffmpeg -encoders` / `ffmpeg -filters` output that are missing from `wanted`. */
export function missingFfmpegFeatures(listing, wanted) {
  const names = new Set();
  for (const line of String(listing ?? '').split('\n')) {
    // " V....D libx264  libx264 H.264 ..." and " ... alimiter  A->A  Audio lookahead limiter."
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 2) names.add(cols[1]);
  }
  return wanted.filter((w) => !names.has(w));
}

/** Node's major version must meet .nvmrc ("22") and package.json engines (">=22"). */
export function nodeMeets(nodeVersion, nvmrc) {
  const have = parseVersion(nodeVersion);
  const want = parseVersion(nvmrc);
  if (!have || !want) return true;
  return have[0] >= want[0];
}

// ---------- secrets ----------

/** RENDERWELD_SECRET_KEY: 32 random bytes, base64 (as `openssl rand -base64 32`): 44 characters. */
export function generateSecretKey() {
  return randomBytes(32).toString('base64');
}

/** RENDERWELD_BOOTSTRAP_KEY: rf_ + 32 random bytes, base64url: 43 random characters (the server wants 32 or more). */
export function generateApiKey() {
  return `rf_${randomBytes(32).toString('base64url')}`;
}

/** A database or storage password for the local containers: hex, so it never needs escaping in a URL. */
export function generatePassword() {
  return randomBytes(18).toString('hex');
}

// ---------- .env.local ----------

/** Parse a dotenv file (Node's own parser: the same rules as `node --env-file`). */
export function parseEnvText(text) {
  return parseEnv(String(text ?? ''));
}

/** dotenv quoting: single quotes keep backslashes (Windows paths) as they are. */
const quote = (v) => (/^[A-Za-z0-9_./:@+=,-]*$/.test(v) ? v : v.includes("'") ? `"${v}"` : `'${v}'`);

/**
 * The settings `pnpm dev:setup` writes, as ordered [comment | [name, value]] entries.
 * opts: { chromiumPath, port, database: 'sqlite'|'postgres'|'mysql', minio, stt: { command, model, modelDir } }
 */
export function envEntries(opts = {}) {
  const port = opts.port ?? STUDIO_PORT;
  const e = [
    '# Server (docs/CONFIG.md lists every setting; RENDERWELD_* is the new name of REELFORGE_*)',
    ['RENDERWELD_HOST', '127.0.0.1'],
    ['RENDERWELD_PORT', String(port)],
    ['RENDERWELD_DATA_DIR', './.data'],
    ['RENDERWELD_LOGS_EXPORTER', 'pretty'],
    ['RENDERWELD_DASHBOARD_ENABLED', 'true'],
    '# Licence: off is for noncommercial development only (LICENSING.md). `pnpm dev:all --mock-licence`',
    '# runs the local mock licence server instead and turns the licence on.',
    ['RENDERWELD_LICENCE_MODE', 'off'],
    '# Secrets, generated for this checkout. The bootstrap key is the first admin API key.',
    ['RENDERWELD_SECRET_KEY', opts.secretKey ?? generateSecretKey()],
    ['RENDERWELD_BOOTSTRAP_KEY', opts.bootstrapKey ?? generateApiKey()],
  ];
  e.push('# Chrome Headless Shell (Remotion, Motion Canvas, HTML and HyperFrames render with it)');
  if (opts.chromiumPath) e.push(['RENDERWELD_CHROMIUM_PATH', opts.chromiumPath]);
  else e.push('# RENDERWELD_CHROMIUM_PATH=/path/to/chrome-headless-shell   (not found: see docs/DEVELOPMENT.md#chromium)');
  e.push(...databaseEntries(opts.database ?? 'sqlite', opts.passwords ?? {}));
  if (opts.minio) e.push(...minioEntries(opts.passwords ?? {}));
  if (opts.stt) e.push(...sttEntries(opts.stt));
  return e;
}

/** Database settings: SQLite needs none (file:<dataDir>/reelforge.db). */
export function databaseEntries(kind, passwords = {}) {
  if (kind === 'postgres') {
    const pw = passwords.postgres ?? generatePassword();
    return [
      '# PostgreSQL in Docker (scripts/dev/compose.yml, service postgres)',
      ['RENDERWELD_DEV_POSTGRES_PASSWORD', pw],
      ['RENDERWELD_DATABASE_URL', `postgresql://renderweld:${pw}@127.0.0.1:5432/renderweld`],
      ['TEST_POSTGRES_URL', `postgresql://renderweld:${pw}@127.0.0.1:5432/renderweld`],
    ];
  }
  if (kind === 'mysql') {
    const pw = passwords.mysql ?? generatePassword();
    const root = passwords.mysqlRoot ?? generatePassword();
    return [
      '# MySQL in Docker (scripts/dev/compose.yml, service mysql). Tests need CREATE DATABASE, so they use root.',
      ['RENDERWELD_DEV_MYSQL_PASSWORD', pw],
      ['RENDERWELD_DEV_MYSQL_ROOT_PASSWORD', root],
      ['RENDERWELD_DATABASE_URL', `mysql://renderweld:${pw}@127.0.0.1:3306/renderweld?allowPublicKeyRetrieval=true`],
      ['TEST_MYSQL_URL', `mysql://root:${root}@127.0.0.1:3306/mysql?allowPublicKeyRetrieval=true`],
    ];
  }
  return ['# Database: SQLite in the data directory (no setting needed). `pnpm dev:setup --postgres` or `--mysql` adds one.'];
}

export function minioEntries(passwords = {}) {
  const pw = passwords.minio ?? generatePassword();
  return [
    '# S3-compatible storage: MinIO in Docker (scripts/dev/compose.yml, service minio; console http://127.0.0.1:9001)',
    ['RENDERWELD_DEV_MINIO_PASSWORD', pw],
    ['RENDERWELD_STORAGE_DRIVER', 's3'],
    ['RENDERWELD_S3_ENDPOINT', 'http://127.0.0.1:9000'],
    ['RENDERWELD_S3_BUCKET', 'renderweld-dev'],
    ['RENDERWELD_S3_REGION', 'us-east-1'],
    ['RENDERWELD_S3_FORCE_PATH_STYLE', 'true'],
    ['RENDERWELD_S3_ACCESS_KEY_ID', 'renderweld'],
    ['RENDERWELD_S3_SECRET_ACCESS_KEY', pw],
  ];
}

export function sttEntries({ command, model, modelDir }) {
  return [
    '# Speech-to-text (faster-whisper in .data/stt, deployment/stt/README.md)',
    ['RENDERWELD_STT_COMMAND', command],
    ['RENDERWELD_STT_MODEL', model],
    ['RENDERWELD_STT_MODEL_DIR', modelDir],
    ['RENDERWELD_STT_DEVICE', 'cpu'],
    ['RENDERWELD_STT_COMPUTE_TYPE', 'int8'],
  ];
}

const HEADER = (date) => [
  `# Written by \`pnpm dev:setup\` on ${date}. Local development only; never commit it (.gitignore: .env.*).`,
  '# `pnpm dev:all` loads it; values in your shell win over this file. Replace it with `pnpm dev:setup --force`.',
  '',
];

/**
 * What to write to .env.local.
 *   no file           -> the whole file
 *   file, force       -> the whole file (the caller keeps a backup)
 *   file, no force    -> the file unchanged, plus only the settings it lacks, appended
 *                        (e.g. a later `--postgres`); a setting it has is never changed.
 * Returns { action: 'create'|'replace'|'append'|'keep', content, added, conflicts }:
 * `conflicts` names settings the file has with another value than asked (left as they are).
 */
export function planEnvFile(existing, entries, { force = false, date = new Date().toISOString().slice(0, 10) } = {}) {
  const render = (list) => list.map((x) => (typeof x === 'string' ? x : `${x[0]}=${quote(x[1])}`)).join('\n');
  const pairs = entries.filter((x) => typeof x !== 'string');
  if (existing == null || force) {
    return { action: existing == null ? 'create' : 'replace', content: `${[...HEADER(date), render(entries)].join('\n')}\n`, added: pairs.map(([k]) => k), conflicts: [] };
  }
  const have = parseEnvText(existing);
  // Settings tied to one choice: asking for postgres when the file already has a database keeps the file's.
  const missing = [];
  const conflicts = [];
  for (const [k, v] of pairs) {
    if (!(k in have)) missing.push([k, v]);
    else if (have[k] !== v && WATCHED.has(k)) conflicts.push(k);
  }
  if (!missing.length) return { action: 'keep', content: existing, added: [], conflicts };
  // Keep the comments that head the missing groups.
  const block = [];
  let pendingComment = null;
  for (const x of entries) {
    if (typeof x === 'string') pendingComment = x;
    else if (missing.some(([k]) => k === x[0])) {
      if (pendingComment) block.push(pendingComment);
      pendingComment = null;
      block.push(x);
    }
  }
  const sep = existing.endsWith('\n') ? '' : '\n';
  return { action: 'append', content: `${existing}${sep}\n# Added by \`pnpm dev:setup\` on ${date}\n${render(block)}\n`, added: missing.map(([k]) => k), conflicts };
}

/** Settings whose differing value is worth a warning (the generated secrets differ every run by design). */
const WATCHED = new Set(['RENDERWELD_DATABASE_URL', 'RENDERWELD_STORAGE_DRIVER', 'RENDERWELD_PORT', 'RENDERWELD_CHROMIUM_PATH']);

/**
 * The environment for the dev processes: the file's settings, then the shell's (the shell wins).
 * A shell value under an old REELFORGE_* name replaces the file's RENDERWELD_* twin instead of
 * clashing with it (the server refuses to start when both names hold different values).
 * Returns { env, notes }.
 */
export function mergeEnv(fileVars, shellEnv) {
  const env = { ...fileVars, ...shellEnv };
  const notes = [];
  for (const k of Object.keys(fileVars)) {
    if (!k.startsWith('RENDERWELD_')) continue;
    const old = `REELFORGE_${k.slice('RENDERWELD_'.length)}`;
    if (old in shellEnv && !(k in shellEnv)) {
      if (shellEnv[old] !== fileVars[k]) notes.push(`${old} from your shell replaces ${k} from .env.local`);
      env[k] = shellEnv[old];
      delete env[old];
    }
  }
  return { env, notes };
}

/** A value from an environment under its new or old name. */
export function envValue(env, name) {
  return env[`RENDERWELD_${name}`] ?? env[`REELFORGE_${name}`];
}

// ---------- Chrome Headless Shell ----------

/** Folders where Playwright keeps its browsers, by platform (PLAYWRIGHT_BROWSERS_PATH first). */
export function playwrightDirs({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const dirs = [];
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0') dirs.push(env.PLAYWRIGHT_BROWSERS_PATH);
  if (platform === 'darwin') dirs.push(join(home, 'Library', 'Caches', 'ms-playwright'));
  else if (platform === 'win32') dirs.push(join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright'));
  else dirs.push(join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'ms-playwright'));
  return dirs;
}

/** The executable inside a chromium_headless_shell-<rev> folder, by platform. */
export function headlessShellExe(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return join('chrome-headless-shell-win64', 'chrome-headless-shell.exe');
  if (platform === 'darwin') return join(arch === 'arm64' ? 'chrome-headless-shell-mac-arm64' : 'chrome-headless-shell-mac-x64', 'chrome-headless-shell');
  return join(arch === 'arm64' ? 'chrome-headless-shell-linux-arm64' : 'chrome-headless-shell-linux64', 'chrome-headless-shell');
}

/**
 * Find a Chrome Headless Shell: the configured path (RENDERWELD_ / REELFORGE_CHROMIUM_PATH),
 * then Playwright's installs (newest revision first), then Remotion's (`npx remotion browser ensure`).
 * Returns { path, source } or null.
 */
export function findChromium({ env = process.env, platform = process.platform, arch = process.arch, home = homedir(), repoDir = process.cwd(), exists = existsSync, list = safeList } = {}) {
  const configured = envValue(env, 'CHROMIUM_PATH');
  if (configured) return exists(configured) ? { path: configured, source: 'environment' } : { path: null, source: 'environment', missing: configured };
  const exe = headlessShellExe(platform, arch);
  for (const dir of playwrightDirs({ env, platform, home })) {
    const revs = list(dir)
      .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const r of revs) {
      const p = join(dir, r, exe);
      if (exists(p)) return { path: p, source: 'playwright' };
    }
  }
  // Remotion's own download: node_modules/.remotion/chrome-headless-shell/<platform>/chrome-headless-shell-<platform>/
  const remotion = join(repoDir, 'node_modules', '.remotion', 'chrome-headless-shell');
  for (const plat of list(remotion)) {
    for (const sub of list(join(remotion, plat))) {
      const p = join(remotion, plat, sub, platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
      if (exists(p)) return { path: p, source: 'remotion' };
    }
  }
  return null;
}

function safeList(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------- machine ----------

/** Free bytes on the file system that holds `dir`, or null when unknown. */
export function freeBytes(dir) {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** Whether nothing listens on host:port (we can bind it). */
export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** The first free port from `start` (up to 50 tried), for a suggestion. */
export async function nextFreePort(start, host = '127.0.0.1') {
  for (let p = start; p < start + 50; p++) if (await portFree(p, host)) return p;
  return null;
}

export const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
