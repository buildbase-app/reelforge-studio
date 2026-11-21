// Licence activation over MCP (issue #25), from a separate container like an agent, against the
// mock licence server container (alias "licence"; never the real licence server in the e2e).
//   PHASE=start    no key: unlicensed, renders refused; activate_licence; render works
//   PHASE=grace    (licence server stopped) re-check: grace with a warning; renders still work
//   PHASE=revoke   (licence server back) revoked after the next check: renders refused, reading and
//                  downloads work; limit_reached; deactivate frees the slot; a working key again
//   PHASE=restart  (new container on the same volume) same instance id, no second activation slot
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const URL_ = process.env.URL, KEY = process.env.KEY, PHASE = process.env.PHASE;
const ADMIN = process.env.LICENCE_ADMIN ?? 'http://licence:8080';
const [KEY_A, KEY_B, KEY_C] = JSON.parse(process.env.LICENCE_KEYS);
const t = new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } });
const c = new Client({ name: 'e2e-licence', version: '1' }); await c.connect(t);
let fail = 0;
const check = (name, ok, extra = '') => { if (!ok) fail++; console.log(`${ok ? '✔' : '✘'} ${name}${extra ? `: ${extra}` : ''}`); };
const raw = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content.map((x) => x.text ?? '').join('');
  for (const k of [KEY_A, KEY_B, KEY_C]) if (text.includes(k)) { fail++; console.log(`✘ ${name} returned a full licence key`); }
  return { isError: Boolean(r.isError), body: JSON.parse(text) };
};
const call = async (name, args) => { const r = await raw(name, args); if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.body).slice(0, 600)}`); return r.body; };
const admin = async (method, path, body) => (await fetch(`${ADMIN}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
const brief = (l) => JSON.stringify({ status: l.status, reason: l.reason, key: l.key, activations: l.activations, graceUntil: l.graceUntil ?? undefined });
const PROJECT = 'licence-e2e';
const renderOnce = async () => {
  const job = (await call('render_project', { projectId: PROJECT })).job;
  let j;
  for (;;) { j = await call('get_job', { jobId: job.id, waitSeconds: 45 }); if (['succeeded', 'failed', 'cancelled'].includes(j.status)) break; }
  return j;
};

if (PHASE === 'start') {
  const caps = await call('get_capabilities');
  check('get_capabilities: licence unlicensed, renders not allowed', caps.licence?.status === 'unlicensed' && caps.licence.renderAllowed === false, JSON.stringify(caps.licence));
  const l0 = await call('get_licence');
  check('get_licence: unlicensed (mode required), no key', l0.status === 'unlicensed' && l0.mode === 'required' && l0.key === null, brief(l0));
  await call('create_project', {
    manifest: { schemaVersion: '0.2', projectId: PROJECT, title: 'Licence e2e', output: { width: 1080, height: 1920, fps: 30, format: 'mp4' }, scenes: [{ id: 'a', engine: 'html', template: 'html-title', durationFrames: 30, props: { headline: 'Licensed' } }] },
  });
  const refused = await raw('render_project', { projectId: PROJECT });
  check('render_project refused without a key: licence_required with a fix', refused.isError && refused.body.error.code === 'licence_required' && /activate_licence/.test(refused.body.error.message), refused.body.error?.message?.slice(0, 120));
  check('reading still works without a licence', (await call('list_projects')).projects.some((p) => p.id === PROJECT));
  const a = await call('activate_licence', { key: KEY_A });
  check('activate_licence: valid, 1/1 activations, key masked to the first group', a.status === 'valid' && a.activations?.used === 1 && a.activations?.limit === 1 && a.key === `${KEY_A.slice(0, 5)}-*****-*****-*****-*****`, brief(a));
  const state = await admin('GET', '/_admin/state');
  const reqs = state.requests;
  check('only the key and the instance id were sent, no credentials', reqs.length > 0 && reqs.every((r) => r.fields.every((f) => f === 'key' || f === 'instance') && !r.headers.includes('authorization') && !r.headers.includes('cookie')), JSON.stringify(reqs.map((r) => `${r.op}:${r.fields.join('+')}`)));
  check('the licence server holds this instance', state.keys[KEY_A].instances.join() === a.instanceId, a.instanceId);
  writeFileSync('/out/instance.txt', a.instanceId);
  const j = await renderOnce();
  check('render_project works with a valid licence', j.status === 'succeeded', j.status);
} else if (PHASE === 'grace') {
  const g = await call('activate_licence', {});
  check('licence server unreachable: grace, renders allowed, graceUntil 14 days after the last success', g.status === 'grace' && g.renderAllowed && Date.parse(g.graceUntil) - Date.parse(g.lastSuccessAt) === 14 * 86_400_000, `${brief(g)} lastError=${g.lastError?.message}`);
  const caps = await call('get_capabilities');
  check('get_capabilities shows the grace warning', caps.licence.status === 'grace' && /renders keep working until/.test(caps.licence.warning ?? ''), caps.licence.warning);
  const j = await renderOnce();
  check('render_project works during the grace period', j.status === 'succeeded', j.status);
} else if (PHASE === 'revoke') {
  const back = await call('activate_licence', {});
  check('licence server back: valid again', back.status === 'valid', brief(back));
  await admin('POST', `/_admin/keys/${KEY_A}/revoke`);
  const r = await call('activate_licence', {});
  check('revoked in the licence server: invalid after the next check', r.status === 'invalid' && r.reason === 'revoked' && !r.renderAllowed, brief(r));
  const refused = await raw('render_project', { projectId: PROJECT });
  const e = refused.body.error ?? {};
  check('render_project refused: licence_invalid with reason and fix', refused.isError && e.code === 'licence_invalid' && e.details?.licence?.reason === 'revoked' && Boolean(e.details?.licence?.fix), e.message?.slice(0, 140));
  const prev = await raw('preview_scene', { projectId: PROJECT });
  check('preview_scene refused too', prev.isError && prev.body.error.code === 'licence_invalid');
  const renders = (await call('list_renders', { projectId: PROJECT })).renders;
  check('existing renders are still listed', renders.length >= 2, `${renders.length} renders`);
  const out = await call('get_render_output', { renderId: renders[0].renderId });
  const res = await fetch(new URL(out.downloadUrl, URL_));
  check('existing renders still download (signed URL)', res.status === 200 && (await res.arrayBuffer()).byteLength > 1000, `HTTP ${res.status}`);
  // limit_reached: KEY_B is already active on another server.
  await admin('POST', '/_admin/keys', { key: KEY_B, activationLimit: 1, activations: ['rf-another-server'] });
  const lim = await call('activate_licence', { key: KEY_B });
  check('a key active elsewhere: limit_reached, with how to free it', lim.status === 'invalid' && lim.reason === 'limit_reached' && /deactivate_licence/.test(lim.fix), brief(lim));
  const ok = await call('activate_licence', { key: KEY_C });
  check('another key: valid', ok.status === 'valid', brief(ok));
  const d = await call('deactivate_licence');
  const st = await admin('GET', '/_admin/state');
  check('deactivate_licence frees the slot; renders refused here', d.status === 'invalid' && d.reason === 'deactivated' && st.keys[KEY_C].instances.length === 0, brief(d));
  const again = await call('activate_licence', {});
  check('activate_licence (no key) takes the slot again', again.status === 'valid' && (await admin('GET', '/_admin/state')).keys[KEY_C].instances.length === 1, brief(again));
} else if (PHASE === 'restart') {
  const before = readFileSync('/out/instance.txt', 'utf8');
  const l = await call('get_licence');
  check('a new container on the same volume keeps the instance id', l.instanceId === before, l.instanceId);
  const ok = await call('activate_licence', { key: KEY_C });
  const st = await admin('GET', '/_admin/state');
  check('activating the same key again takes no second slot', ok.status === 'valid' && st.keys[KEY_C].instances.length === 1 && st.keys[KEY_C].instances[0] === before, brief(ok));
  const j = await renderOnce();
  check('render_project works after the restart', j.status === 'succeeded', j.status);
} else {
  throw new Error(`unknown PHASE ${PHASE}`);
}
await c.close();
process.exit(fail ? 1 : 0);
