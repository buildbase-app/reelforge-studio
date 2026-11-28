#!/usr/bin/env node
// One-command local setup (docs/DEVELOPMENT.md). Safe to run again: it checks, installs what is
// missing and never replaces .env.local without --force.
//
//   pnpm dev:setup                  # check, install, generate, build the dashboard, write .env.local
//   pnpm dev:setup --postgres       # also PostgreSQL in Docker (or --mysql); --minio for S3 storage
//   pnpm dev:setup --stt            # also faster-whisper for speech-to-text (Python 3.9+)
//   pnpm dev:setup --check          # only check the prerequisites
//
// `pnpm setup` is pnpm's own command (it edits your shell profile): use `pnpm dev:setup`
// or `pnpm run setup`. Node built-ins only, so it runs before `pnpm install`.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  FFMPEG_ENCODERS,
  FFMPEG_FILTERS,
  MIN_FFMPEG,
  MIN_FREE_BYTES,
  STUDIO_PORT,
  compareVersions,
  envEntries,
  findChromium,
  freeBytes,
  gb,
  missingFfmpegFeatures,
  nextFreePort,
  nodeMeets,
  parseEnvText,
  parseFfmpegVersion,
  parseVersion,
  planEnvFile,
  portFree,
} from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_FILE = join(ROOT, '.env.local');
const COMPOSE = ['compose', '-p', 'renderweld-dev', '-f', 'scripts/dev/compose.yml', '--env-file', '.env.local'];

const HELP = `pnpm dev:setup [options]   (docs/DEVELOPMENT.md)

  --force         replace .env.local (the old one is kept as .env.local.bak) and new secrets
  --postgres      PostgreSQL 17 in Docker; writes RENDERWELD_DATABASE_URL and TEST_POSTGRES_URL
  --mysql         MySQL 8.4 in Docker; writes RENDERWELD_DATABASE_URL and TEST_MYSQL_URL
  --minio         MinIO in Docker as S3-compatible storage (RENDERWELD_STORAGE_DRIVER=s3)
  --stt           faster-whisper in .data/stt for speech-to-text captions (--stt-model, default tiny)
  --port N        the studio port written to .env.local (default ${STUDIO_PORT})
  --offline       install from the pnpm store only; never download Chrome Headless Shell
  --skip-install  skip pnpm install, Prisma generate and the dashboard build
  --no-chromium   do not download Chrome Headless Shell when none is found
  --check         check the prerequisites and stop
  -h, --help      this text`;

let opts;
try {
  ({ values: opts } = parseArgs({
    options: {
      force: { type: 'boolean' },
      postgres: { type: 'boolean' },
      mysql: { type: 'boolean' },
      minio: { type: 'boolean' },
      stt: { type: 'boolean' },
      'stt-model': { type: 'string', default: 'tiny' },
      port: { type: 'string' },
      offline: { type: 'boolean' },
      'skip-install': { type: 'boolean' },
      'no-chromium': { type: 'boolean' },
      check: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) {
  console.error(`${e.message}\n\n${HELP}`);
  process.exit(2);
}
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}
if (opts.postgres && opts.mysql) {
  console.error('Choose one database: --postgres or --mysql.');
  process.exit(2);
}
const port = opts.port ? Number(opts.port) : STUDIO_PORT;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`--port ${opts.port}: not a port number`);
  process.exit(2);
}

// ---------- output ----------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const ok = (s) => console.log(`${paint(32, 'ok  ')} ${s}`);
const warnings = [];
const warn = (s, fix) => {
  warnings.push(s);
  console.log(`${paint(33, 'warn')} ${s}${fix ? `\n     fix: ${fix}` : ''}`);
};
const errors = [];
const fail = (s, fix) => {
  errors.push(s);
  console.log(`${paint(31, 'FAIL')} ${s}${fix ? `\n     fix: ${fix}` : ''}`);
};
const step = (s) => console.log(`\n${paint(1, `== ${s}`)}`);

const run = (cmd, args, o = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', ...o });
/** Run with the output shown; exit on failure with a hint. */
function must(cmd, args, hint) {
  console.log(paint(2, `$ ${cmd} ${args.join(' ')}`));
  const r = run(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n${paint(31, 'FAIL')} \`${cmd} ${args.join(' ')}\` exited with ${r.status ?? r.error?.message}${hint ? `\n     fix: ${hint}` : ''}`);
    process.exit(1);
  }
}

// ---------- 1. prerequisites ----------
step('Prerequisites');

const nvmrc = existsSync(join(ROOT, '.nvmrc')) ? readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim() : '22';
if (nodeMeets(process.version, nvmrc)) ok(`Node ${process.version} (needs ${nvmrc}+)`);
else fail(`Node ${process.version} is older than ${nvmrc}`, `install Node ${nvmrc}: \`nvm install ${nvmrc}\` (or fnm, Volta, nodejs.org)`);

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const wantPnpm = /pnpm@([\d.]+)/.exec(pkg.packageManager ?? '')?.[1] ?? '10';
const pnpmV = run('pnpm', ['--version']);
if (pnpmV.status === 0) {
  const have = parseVersion(pnpmV.stdout);
  if (have && have[0] === parseVersion(wantPnpm)[0]) ok(`pnpm ${pnpmV.stdout.trim()} (the repo pins ${wantPnpm})`);
  else warn(`pnpm ${pnpmV.stdout.trim()}; the repo pins ${wantPnpm}`, '`corepack enable` then run the command again (corepack uses the pinned version)');
} else {
  fail('pnpm was not found', '`corepack enable` (ships with Node), or `npm install -g pnpm@' + wantPnpm + '`');
}

const ffmpegBin = process.env.RENDERWELD_FFMPEG_PATH || process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobeBin = process.env.RENDERWELD_FFPROBE_PATH || process.env.FFPROBE_PATH || 'ffprobe';
const ffmpegFix =
  process.platform === 'darwin' ? '`brew install ffmpeg`' : process.platform === 'win32' ? 'use WSL2 (docs/DEVELOPMENT.md#windows), or `winget install Gyan.FFmpeg`' : '`sudo apt install ffmpeg` (Debian/Ubuntu), `sudo dnf install ffmpeg` (Fedora with RPM Fusion)';
const ff = run(ffmpegBin, ['-hide_banner', '-version']);
if (ff.status !== 0) {
  fail(`FFmpeg was not found (tried "${ffmpegBin}")`, `${ffmpegFix}; or set FFMPEG_PATH to its full path`);
} else {
  const v = parseFfmpegVersion(ff.stdout);
  if (!v) ok(`FFmpeg (a snapshot build: ${ff.stdout.split('\n')[0].slice(0, 60)})`);
  else if (compareVersions(v, MIN_FFMPEG) < 0) warn(`FFmpeg ${v.join('.')} is older than ${MIN_FFMPEG.join('.')} (the release image ships 5.1; 6.1 is tested)`, `${ffmpegFix}; or set FFMPEG_PATH to a newer static build`);
  else ok(`FFmpeg ${v.join('.')} (needs ${MIN_FFMPEG.join('.')}+)`);
  const missing = [
    ...missingFfmpegFeatures(run(ffmpegBin, ['-hide_banner', '-encoders']).stdout, FFMPEG_ENCODERS),
    ...missingFfmpegFeatures(run(ffmpegBin, ['-hide_banner', '-filters']).stdout, FFMPEG_FILTERS),
  ];
  if (missing.length) warn(`FFmpeg lacks ${missing.join(', ')} (renders that need them fail)`, `install a full build: ${ffmpegFix}`);
}
if (run(ffprobeBin, ['-version']).status === 0) ok('ffprobe');
else fail(`ffprobe was not found (tried "${ffprobeBin}")`, `it ships with FFmpeg: ${ffmpegFix}; or set FFPROBE_PATH`);

const free = freeBytes(ROOT);
if (free === null) warn('could not read the free disk space');
else if (free < MIN_FREE_BYTES) warn(`${gb(free)} free on the disk of ${ROOT}; a fresh install needs about 1.5 GB and renders more`, 'free space (docs/DEVELOPMENT.md#low-disk), or `pnpm store prune`');
else ok(`${gb(free)} free on disk`);

const portsToCheck = [[port, 'studio API, MCP and dashboard']];
if (opts.postgres) portsToCheck.push([5432, 'PostgreSQL']);
if (opts.mysql) portsToCheck.push([3306, 'MySQL']);
if (opts.minio) portsToCheck.push([9000, 'MinIO'], [9001, 'MinIO console']);
for (const [p, what] of portsToCheck) {
  if (await portFree(p)) ok(`port ${p} is free (${what})`);
  else {
    const alt = await nextFreePort(p + 1);
    warn(`port ${p} is in use (${what})`, `stop what uses it (\`lsof -i :${p}\`), or ${p === port ? `\`pnpm dev:setup --port ${alt}\` / \`pnpm dev:all --port ${alt}\`` : 'see docs/DEVELOPMENT.md#ports'}`);
  }
}

const hasDocker = run('docker', ['info'], { stdio: 'ignore', timeout: 15000 }).status === 0;
if (opts.postgres || opts.mysql || opts.minio) {
  if (hasDocker) ok('Docker is running');
  else warn('Docker is not running: the database and storage containers are not started', 'start Docker, or run the commands printed at the end on any Docker host');
}

let chromium = findChromium({ repoDir: ROOT });
if (chromium?.path) ok(`Chrome Headless Shell: ${chromium.path} (${chromium.source})`);
else if (chromium?.missing) warn(`RENDERWELD_CHROMIUM_PATH points to ${chromium.missing}, which does not exist`, 'fix the path, or unset it and run this again to find or install one');
else console.log('     Chrome Headless Shell not found yet; it is installed after the packages');

if (errors.length) {
  console.log(`\n${paint(31, `${errors.length} prerequisite(s) missing.`)} Fix them and run \`pnpm dev:setup\` again (docs/DEVELOPMENT.md).`);
  process.exit(1);
}
if (opts.check) {
  console.log(`\nPrerequisites checked${warnings.length ? ` with ${warnings.length} warning(s)` : ''}.`);
  process.exit(0);
}

// ---------- 2. install and generate ----------
if (!opts['skip-install']) {
  step('Install');
  must('pnpm', ['install', '--frozen-lockfile', ...(opts.offline ? ['--offline'] : [])], opts.offline ? 'the pnpm store lacks a package: run once online, or copy a store (docs/DEVELOPMENT.md#offline)' : 'behind a proxy? docs/DEVELOPMENT.md#proxies');
  step('Generate the Prisma clients');
  // The generated clients are committed (packages/db/src/generated), so a failure here is not fatal.
  console.log(paint(2, '$ pnpm --filter @renderweld/db run generate'));
  const gen = run('pnpm', ['--filter', '@renderweld/db', 'run', 'generate'], { stdio: 'inherit' });
  if (gen.status !== 0) warn('Prisma generate failed; the committed clients in packages/db/src/generated are used', 'it runs `pnpm dlx prisma@7.10.1`, which needs the network once (docs/DEVELOPMENT.md#offline)');
  else {
    const changed = run('git', ['status', '--porcelain', '--', 'packages/db/src/generated']).stdout?.trim();
    if (changed) warn('Prisma generate changed committed files in packages/db/src/generated', 'if you did not edit the schema, `git checkout -- packages/db/src/generated`');
    else ok('Prisma clients match the committed ones');
  }
  step('Build the dashboard');
  must('pnpm', ['--filter', '@renderweld/dashboard', 'run', 'build']);
}

if (!chromium?.path && !chromium?.missing) {
  step('Chrome Headless Shell');
  if (opts.offline || opts['no-chromium']) {
    warn('no Chrome Headless Shell: renders fail until you install one', 'docs/DEVELOPMENT.md#chromium');
  } else {
    // The same command CI uses; Playwright's version comes from the lockfile.
    must('pnpm', ['--filter', '@renderweld/engine-motion-canvas', 'exec', 'playwright-core', 'install', 'chromium-headless-shell'], 'behind a proxy set HTTPS_PROXY, or PLAYWRIGHT_DOWNLOAD_HOST for a mirror (docs/DEVELOPMENT.md#chromium)');
    chromium = findChromium({ repoDir: ROOT });
    if (chromium?.path) ok(`Chrome Headless Shell: ${chromium.path}`);
    else warn('Chrome Headless Shell was installed but not found', 'set RENDERWELD_CHROMIUM_PATH in .env.local (docs/DEVELOPMENT.md#chromium)');
    if (process.platform === 'linux') console.log('     If it fails to start (missing libraries): `sudo pnpm --filter @renderweld/engine-motion-canvas exec playwright-core install-deps chromium-headless-shell`');
  }
}

// ---------- 3. optional speech-to-text ----------
let stt = null;
if (opts.stt) {
  step('Speech-to-text (faster-whisper)');
  const dir = join(ROOT, '.data', 'stt');
  const win = process.platform === 'win32';
  const py = join(dir, 'venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python3');
  const model = opts['stt-model'];
  const modelDir = join(dir, 'models');
  if (!existsSync(py)) {
    const python = ['python3', 'python'].find((p) => run(p, ['--version']).status === 0);
    if (!python) fail('Python 3 was not found (needed for --stt)', 'install Python 3.9 or newer, then run `pnpm dev:setup --stt` again');
    else must(python, ['-m', 'venv', join(dir, 'venv')], 'on Debian/Ubuntu: `sudo apt install python3-venv`');
  }
  if (existsSync(py)) {
    must(py, ['-m', 'pip', 'install', '--quiet', 'faster-whisper==1.2.1', 'av==18.0.0'], 'behind a proxy set HTTPS_PROXY (pip uses it)');
    must(py, ['-c', `from faster_whisper import download_model; download_model(${JSON.stringify(model)}, cache_dir=${JSON.stringify(modelDir)})`], 'if Hugging Face Xet storage is blocked: HF_HUB_DISABLE_XET=1');
    // The program the server runs, with this venv's Python (deployment/stt/README.md, "Without Docker").
    const command = join(dir, 'reelforge-whisper');
    const src = readFileSync(join(ROOT, 'deployment', 'stt', 'reelforge-whisper'), 'utf8').split('\n');
    src[0] = `#!${py} -I`;
    writeFileSync(command, src.join('\n'));
    chmodSync(command, 0o755);
    stt = { command, model, modelDir };
    ok(`speech-to-text: ${stt.command}, model ${model}`);
  }
}
if (errors.length) process.exit(1);

// ---------- 4. .env.local ----------
step('.env.local');
const database = opts.postgres ? 'postgres' : opts.mysql ? 'mysql' : 'sqlite';
const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : null;
const entries = envEntries({ chromiumPath: chromium?.path ?? undefined, port, database, minio: opts.minio, stt });
const plan = planEnvFile(existing, entries, { force: opts.force });
if (plan.action === 'replace') copyFileSync(ENV_FILE, `${ENV_FILE}.bak`);
if (plan.action !== 'keep') writeFileSync(ENV_FILE, plan.content, { mode: 0o600 });
mkdirSync(join(ROOT, '.data'), { recursive: true });
const vars = parseEnvText(plan.content);
if (plan.action === 'create' || plan.action === 'replace') {
  ok(`${plan.action === 'create' ? 'wrote' : 'replaced'} .env.local${plan.action === 'replace' ? ' (the old one is .env.local.bak)' : ''}`);
} else if (plan.action === 'append') {
  ok(`.env.local kept; added ${plan.added.join(', ')}`);
} else {
  ok('.env.local is already set up (kept as it is; `--force` replaces it)');
}
for (const k of plan.conflicts) warn(`.env.local keeps its own ${k}, not the one this run asked for`, `edit it by hand, or \`pnpm dev:setup --force${opts.postgres ? ' --postgres' : opts.mysql ? ' --mysql' : ''}\``);

// ---------- 5. optional containers ----------
const services = [opts.postgres && 'postgres', opts.mysql && 'mysql', opts.minio && 'minio'].filter(Boolean);
if (services.length) {
  step(`Containers: ${services.join(', ')}`);
  const cmd = `docker ${COMPOSE.join(' ')} up -d --wait ${services.join(' ')}`;
  if (hasDocker) {
    must('docker', [...COMPOSE, 'up', '-d', '--wait', ...services], 'see docs/DEVELOPMENT.md#databases (POSTGRES_IMAGE / MYSQL_IMAGE / MINIO_IMAGE pick a mirror)');
    if (opts.minio) createBucket(vars);
  } else {
    console.log(`Docker is not running. Start it and run:\n\n  ${cmd}\n`);
    if (opts.postgres) console.log(`Or use a PostgreSQL you already have:\n  createuser -P renderweld && createdb -O renderweld renderweld\n  then set RENDERWELD_DATABASE_URL and TEST_POSTGRES_URL in .env.local\n`);
    if (opts.mysql) console.log(`Or use a MySQL you already have:\n  CREATE DATABASE renderweld; CREATE USER 'renderweld'@'%' IDENTIFIED BY '<password>'; GRANT ALL ON renderweld.* TO 'renderweld'@'%';\n  then set RENDERWELD_DATABASE_URL and TEST_MYSQL_URL in .env.local\n`);
    if (opts.minio) console.log('MinIO: then create the bucket renderweld-dev (`pnpm dev:setup --minio` again does it once Docker runs).\n');
  }
}

function createBucket(v) {
  // With the AWS SDK the studio already depends on (installed above).
  const script = `
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(join(ROOT, 'packages', 'core', 'package.json'))});
    const { S3Client, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({ endpoint: process.env.E, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.I, secretAccessKey: process.env.S } });
    try { await s3.send(new HeadBucketCommand({ Bucket: process.env.B })); console.log('bucket exists'); }
    catch { await s3.send(new CreateBucketCommand({ Bucket: process.env.B })); console.log('bucket created'); }`;
  const env = { ...process.env, E: v.RENDERWELD_S3_ENDPOINT, I: v.RENDERWELD_S3_ACCESS_KEY_ID, S: v.RENDERWELD_S3_SECRET_ACCESS_KEY, B: v.RENDERWELD_S3_BUCKET };
  const r = run(process.execPath, ['--input-type=module', '-e', script], { env, shell: false });
  if (r.status === 0) ok(`MinIO bucket ${v.RENDERWELD_S3_BUCKET}: ${r.stdout.trim()}`);
  else warn(`could not create the MinIO bucket: ${(r.stderr || '').trim().split('\n').pop()}`, 'open http://127.0.0.1:9001 and create it, then run again');
}

// ---------- done ----------
step('Done');
if (plan.action === 'create' || plan.action === 'replace') {
  console.log(`Admin API key (shown once; it is also in .env.local as RENDERWELD_BOOTSTRAP_KEY):\n\n  ${paint(1, vars.RENDERWELD_BOOTSTRAP_KEY)}\n`);
}
console.log(`Next:\n  pnpm dev:all            # API, MCP and dashboard on http://127.0.0.1:${vars.RENDERWELD_PORT ?? port}\n  docs/DEVELOPMENT.md     # every other case`);
if (warnings.length) console.log(`\n${paint(33, `${warnings.length} warning(s)`)} above; the studio runs, but check them.`);
