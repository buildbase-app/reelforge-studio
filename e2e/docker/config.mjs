// Configuration over MCP (issue #24), from a separate container like an agent:
//   PHASE=before  read the config, change a runtime setting, store a secret, be refused for a start-up-only key
//   PHASE=after   (after a new container on the same volume) the runtime values survived
//   EDITION=release  the image is a release build: the licence settings are fixed (source "build", D-039)
//   SANDBOX=1        Chromium's sandbox is expected on for html, hyperframes and motion-canvas (D-041)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const URL_ = process.env.URL, KEY = process.env.KEY, PHASE = process.env.PHASE ?? 'before';
const EDITION = process.env.EDITION ?? 'dev', SANDBOX = process.env.SANDBOX === '1';
const PLAIN_V01 = process.env.PLAIN_V01 ?? '', LICENCE = 'LIC-E2E-' + 'x'.repeat(12);
const t = new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } });
const c = new Client({ name: 'e2e-config', version: '1' }); await c.connect(t);
let fail = 0;
const check = (name, ok, extra = '') => { if (!ok) fail++; console.log(`${ok ? '✔' : '✘'} ${name}${extra ? `: ${extra}` : ''}`); };
const raw = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); return { isError: r.isError, text: r.content.map((x) => x.text ?? '').join('') }; };
const call = async (name, args) => { const r = await raw(name, args); if (r.isError) throw new Error(`${name}: ${r.text.slice(0, 600)}`); return JSON.parse(r.text); };
const get = async () => { const r = await raw('get_config'); if (PLAIN_V01 && r.text.includes(PLAIN_V01)) { fail++; console.log('✘ get_config leaked a secret'); } return JSON.parse(r.text); };
const entry = (cfg, key) => cfg.settings.find((s) => s.key === key);

let cfg = await get();
const show = (k) => { const e = entry(cfg, k); return `${JSON.stringify(e.value)} (${e.source}${e.origin ? `: ${e.origin}` : ''})`; };
if (PHASE === 'before') {
  check('get_config lists every setting with value and source', cfg.settings.length > 25 && cfg.settings.every((s) => 'value' in s && s.source), `${cfg.settings.length} settings, config file ${cfg.configFile}`);
  check('secret key is set (REELFORGE_SECRET_KEY_FILE)', cfg.secretKey === 'set');
  check('limits.maxJsonBytes comes from the config file', entry(cfg, 'limits.maxJsonBytes').source === 'file', show('limits.maxJsonBytes'));
  check('server.allowedHosts comes from the environment', entry(cfg, 'server.allowedHosts').source === 'env', show('server.allowedHosts'));
  check('limits.rateLimitPerMinute starts at its default', entry(cfg, 'limits.rateLimitPerMinute').source === 'default', show('limits.rateLimitPerMinute'));
  check('database.url is a secret: only "set"', entry(cfg, 'database.url').value === 'set', show('database.url'));
  const el = entry(cfg, 'providers.elevenlabs.apiKey');
  check('v0.1 plaintext provider key was encrypted at rest on start', el.value === 'set' && el.source === 'runtime' && el.atRest === 'aes-256-gcm', JSON.stringify({ value: el.value, source: el.source, atRest: el.atRest }));
  const up = await call('update_config', { settings: { 'limits.rateLimitPerMinute': 600, 'licence.key': LICENCE } });
  check('update_config changes the rate limit; its source becomes runtime', up.settings[0].value === 600 && up.settings[0].source === 'runtime', JSON.stringify(up.changes));
  check('update_config stores the licence key (secret) without echoing it', !JSON.stringify(up).includes(LICENCE) && up.settings[1].atRest === 'aes-256-gcm');
  const refused = await raw('update_config', { settings: { 'server.port': 9999 } });
  const err = refused.isError ? JSON.parse(refused.text).error : {};
  check('a start-up-only key is refused, naming where to set it', refused.isError && err.code === 'startup_only_setting' && /REELFORGE_PORT/.test(err.message) && /REELFORGE_CONFIG/.test(err.message), err.message);
  cfg = await get();
  check('get_config shows the change', entry(cfg, 'limits.rateLimitPerMinute').value === 600, show('limits.rateLimitPerMinute'));

  const caps = await call('get_capabilities');
  check(`get_config and get_capabilities report the ${EDITION} edition`, cfg.edition === EDITION && caps.server.edition === EDITION, `${cfg.edition} / ${caps.server.edition}`);
  if (EDITION === 'release') {
    for (const k of ['licence.mode', 'licence.serverUrl', 'licence.orgId']) check(`release build: ${k} is fixed by the build`, entry(cfg, k).source === 'build', show(k));
    check('release build: licence.mode is "required"', entry(cfg, 'licence.mode').value === 'required');
    const locked = await raw('update_config', { settings: { 'licence.mode': 'off', 'licence.serverUrl': 'http://fake-licence.example' } });
    const le = locked.isError ? JSON.parse(locked.text).error : {};
    check('release build: update_config refuses licence.mode / serverUrl (build_locked_setting)', locked.isError && le.code === 'build_locked_setting' && le.details?.issues?.length === 2 && /fixed by this release build/.test(le.message), le.message?.slice(0, 160));
    check('release build: nothing changed', entry(await get(), 'licence.mode').value === 'required');
  } else {
    check('dev build: the licence server comes from the environment', entry(cfg, 'licence.serverUrl').source === 'env', show('licence.serverUrl'));
  }
  const sb = caps.security?.chromiumSandbox ?? {};
  if (SANDBOX) {
    check('Chromium sandbox on for html, hyperframes, motion-canvas; off for remotion (it forces --no-sandbox)', sb.html === true && sb.hyperframes === true && sb['motion-canvas'] === true && sb.remotion === false, JSON.stringify(sb));
    check('get_capabilities warns that Remotion runs without the sandbox', /remotion/.test(caps.security?.warning ?? '') && !/seccomp profile/.test(caps.security.warning), caps.security?.warning);
  } else {
    check('Chromium sandbox off everywhere; get_capabilities says how to turn it on', Object.values(sb).every((v) => v === false) && /deployment\/seccomp\/chrome\.json/.test(caps.security?.warning ?? ''), JSON.stringify(sb));
  }
} else {
  check('after a restart the rate limit is still the runtime value', entry(cfg, 'limits.rateLimitPerMinute').value === 600 && entry(cfg, 'limits.rateLimitPerMinute').source === 'runtime', show('limits.rateLimitPerMinute'));
  check('after a restart the licence key is still set (decrypted with the same key)', entry(cfg, 'licence.key').value === 'set' && !entry(cfg, 'licence.key').error, show('licence.key'));
  check('after a restart the file and env sources are unchanged', entry(cfg, 'limits.maxJsonBytes').source === 'file' && entry(cfg, 'server.allowedHosts').source === 'env');
  const caps = await call('get_capabilities');
  check('ElevenLabs is configured from the encrypted key', caps.providers.find((p) => p.id === 'elevenlabs')?.configured === true);
}
await c.close();
process.exit(fail ? 1 : 0);
