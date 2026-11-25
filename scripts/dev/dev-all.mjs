#!/usr/bin/env node
// Everything for local development in one terminal (docs/DEVELOPMENT.md):
//   [api]     the REST + MCP server, restarted on code changes (tsx watch), dashboard on
//   [dash]    the dashboard, built once and rebuilt when apps/dashboard/src changes
//   [licence] the mock licence server (e2e/mock-licence), with --mock-licence
//   [worker]  separate render workers, with --workers N (PostgreSQL or MySQL)
// Settings come from .env.local (`pnpm dev:setup`); your shell's values win. Ctrl-C stops all.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MOCK_LICENCE_PORT, STUDIO_PORT, envValue, generateApiKey, mergeEnv, nextFreePort, parseEnvText, portFree } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HELP = `pnpm dev:all [options]   (docs/DEVELOPMENT.md)

  --port N            studio port (default: RENDERWELD_PORT in .env.local, else ${STUDIO_PORT})
  --mock-licence      run the mock licence server and turn the licence on (mode required)
  --workers N         N render workers beside an api-only server (needs PostgreSQL or MySQL)
  --no-watch          no reload: run the server once and build the dashboard once
  --env-file PATH     settings file (default .env.local)
  -h, --help          this text`;

let opts;
try {
  ({ values: opts } = parseArgs({
    options: {
      port: { type: 'string' },
      'mock-licence': { type: 'boolean' },
      workers: { type: 'string', default: '0' },
      'no-watch': { type: 'boolean' },
      'env-file': { type: 'string', default: '.env.local' },
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

const envFile = join(ROOT, opts['env-file']);
if (!existsSync(envFile)) {
  console.error(`${opts['env-file']} not found: run \`pnpm dev:setup\` first (docs/DEVELOPMENT.md).`);
  process.exit(1);
}
const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!existsSync(tsxCli)) {
  console.error('Dependencies are not installed: run `pnpm dev:setup` (or `pnpm install`).');
  process.exit(1);
}

const { env, notes } = mergeEnv(parseEnvText(readFileSync(envFile, 'utf8')), process.env);
for (const n of notes) console.log(`note: ${n}`);
const setEnv = (name, value) => {
  env[`RENDERWELD_${name}`] = value;
  delete env[`REELFORGE_${name}`];
};
if (opts.port) setEnv('PORT', opts.port);
const port = Number(envValue(env, 'PORT') ?? STUDIO_PORT);
const host = envValue(env, 'HOST') ?? '127.0.0.1';
const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
const workers = Number(opts.workers);
if (!Number.isInteger(workers) || workers < 0) {
  console.error(`--workers ${opts.workers}: not a number`);
  process.exit(2);
}
const dbUrl = envValue(env, 'DATABASE_URL') ?? env.DATABASE_URL ?? '';
if (workers > 0 && !/^(postgres|postgresql|mysql|mariadb):/.test(dbUrl)) {
  console.error('--workers needs PostgreSQL or MySQL (the queue is shared through the database): `pnpm dev:setup --postgres` first.');
  process.exit(2);
}

// ---------- ports ----------
async function needPort(p, what, flag) {
  if (await portFree(p, host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1')) return;
  let running = false;
  try {
    running = (await fetch(`http://127.0.0.1:${p}/healthz`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {}
  const alt = await nextFreePort(p + 1);
  console.error(running ? `A studio already answers on port ${p} (another \`pnpm dev:all\`?). Stop it, or use \`${flag} ${alt}\`.` : `Port ${p} (${what}) is in use. Stop what uses it (\`lsof -i :${p}\`), or use \`${flag} ${alt}\`.`);
  process.exit(1);
}
await needPort(port, 'studio', 'pnpm dev:all --port');

// ---------- processes ----------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const COLORS = { api: 36, dash: 35, licence: 33, worker: 34, dev: 32 };
const tag = (name) => {
  const label = `[${name}]`.padEnd(11);
  return tty ? `\x1b[${COLORS[name.replace(/\d+$/, '')] ?? 37}m${label}\x1b[0m` : label;
};
const log = (name, line) => process.stdout.write(`${tag(name)} ${line}\n`);
const children = new Set();
let stopping = false;

function prefix(name, stream) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) log(name, l);
  });
  stream.on('end', () => buf && log(name, buf));
}

/** Start a child in its own process group (so Ctrl-C reaches it once, through us). */
function start(name, args, extraEnv = {}, { critical = true } = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...env, ...extraEnv, FORCE_COLOR: tty ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  children.add(child);
  prefix(name, child.stdout);
  prefix(name, child.stderr);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (stopping) return;
    log(name, `exited (${signal ?? code})`);
    if (critical) shutdown(code || 1);
  });
  return child;
}

function stop(child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  log('dev', 'stopping...');
  watcher?.close();
  for (const c of children) stop(c, 'SIGTERM');
  const deadline = setTimeout(() => {
    for (const c of children) stop(c, 'SIGKILL');
    process.exit(code);
  }, 10000);
  deadline.unref();
  const check = setInterval(() => {
    if (children.size === 0) {
      clearInterval(check);
      log('dev', 'stopped');
      process.exit(code);
    }
  }, 100);
}
process.on('SIGINT', () => (stopping ? process.exit(130) : shutdown(0)));
process.on('SIGTERM', () => shutdown(0));

// [dash]: build now (the server serves apps/dashboard/dist and reads it per request), then on change.
let watcher = null;
function buildDashboard() {
  const t = Date.now();
  const r = spawnSync(process.execPath, [tsxCli, 'apps/dashboard/build.ts'], { cwd: ROOT, encoding: 'utf8', env });
  if (r.status === 0) log('dash', `built in ${Date.now() - t} ms${opts['no-watch'] ? '' : '; rebuilding on changes in apps/dashboard/src (reload the page)'}`);
  else for (const l of `${r.stdout}${r.stderr}`.trim().split('\n').slice(-15)) log('dash', l);
  return r.status === 0;
}
const dashboardOn = !/^(false|0|no|off)$/i.test(envValue(env, 'DASHBOARD_ENABLED') ?? 'false');
if (dashboardOn) {
  buildDashboard();
  if (!opts['no-watch']) {
    let timer = null;
    try {
      watcher = watch(join(ROOT, 'apps', 'dashboard', 'src'), { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(buildDashboard, 200);
      });
    } catch (e) {
      log('dash', `cannot watch apps/dashboard/src (${e.message}); rebuild with \`pnpm --filter @renderweld/dashboard build\``);
    }
  }
}

// [licence]: the BuildBase licence API mock, with one key that activates without a limit.
const mockPort = Number(process.env.MOCK_LICENCE_PORT ?? MOCK_LICENCE_PORT);
if (opts['mock-licence']) {
  await needPort(mockPort, 'mock licence server', 'MOCK_LICENCE_PORT=');
  const key = env.RENDERWELD_DEV_LICENCE_KEY ?? `dev-${generateApiKey().slice(3, 27)}`;
  start('licence', ['e2e/mock-licence/server.mjs'], { PORT: String(mockPort), SEED_KEYS: JSON.stringify([{ key, activationLimit: null }]) });
  setEnv('LICENCE_MODE', 'required');
  setEnv('LICENCE_SERVER_URL', `http://127.0.0.1:${mockPort}`);
  setEnv('LICENCE_KEY', key);
  delete env.RENDERWELD_LICENSE_MODE;
  delete env.REELFORGE_LICENSE_MODE;
}

// [api] and [worker]s.
const serverArgs = opts['no-watch'] ? [tsxCli, 'apps/server/src/main.ts'] : [tsxCli, 'watch', '--clear-screen=false', 'apps/server/src/main.ts'];
if (workers > 0) {
  const shared = envValue(env, 'STORAGE_DRIVER') && envValue(env, 'STORAGE_DRIVER') !== 'local' ? {} : { RENDERWELD_STORAGE_LOCAL_SHARED: 'true' };
  Object.assign(env, shared);
  setEnv('ROLE', 'api');
  for (let i = 1; i <= workers; i++) {
    const wport = port + i;
    await needPort(wport, `worker ${i} health port`, 'pnpm dev:all --port');
    start(`worker${i}`, serverArgs, { RENDERWELD_ROLE: 'worker', RENDERWELD_PORT: String(wport) });
  }
}
start('api', serverArgs);

// ---------- ready ----------
const key = envValue(env, 'BOOTSTRAP_KEY');
for (let i = 0; i < 240 && !stopping; i++) {
  try {
    const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) {
      const lines = [
        '',
        `RenderWeld Studio is up (${(await r.json()).version ?? 'dev'})`,
        `  REST       ${base}/v1`,
        `  MCP        ${base}/mcp`,
        `  Health     ${base}/healthz   ${base}/readyz`,
        dashboardOn ? `  Dashboard  ${base}/dashboard/  (sign in with the admin key)` : '  Dashboard  off (RENDERWELD_DASHBOARD_ENABLED=false)',
        opts['mock-licence'] ? `  Licence    mock server http://127.0.0.1:${mockPort}, key ${envValue(env, 'LICENCE_KEY')}` : `  Licence    ${envValue(env, 'LICENCE_MODE') ?? 'required'}`,
        key ? `  Admin key  ${key}` : '  Admin key  none in .env.local: `pnpm renderweld keys create --name me`',
        '',
        'Connect Claude Code:',
        `  claude mcp add --transport http renderweld ${base}/mcp --header "Authorization: Bearer ${key ?? 'rf_...'}"`,
        '',
        'Ctrl-C stops everything.',
        '',
      ];
      for (const l of lines) log('dev', l);
      break;
    }
  } catch {}
  await new Promise((res) => setTimeout(res, 500));
}
