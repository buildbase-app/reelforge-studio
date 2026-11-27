// Outbound events (#66) from a separate container, as an agent over MCP:
//   PHASE=setup    email providers configured over update_config (secrets encrypted), one endpoint per channel:
//                  a signed webhook, Slack, Discord, Teams, and email over SMTP (Mailpit), Resend, Postmark,
//                  SendGrid and SES (HTTP stubs in the receiver container); a render, a key created and revoked
//                  and a config change produce the events; the receiver verifies every signature with the official
//                  standardwebhooks library; Mailpit's API shows the email; retries, dead letter, 4xx, replay,
//                  test_webhook, a wrong provider key; no secret in any answer.
//   PHASE=pending  (receiver stopped) a test event stays pending with a failed attempt
//   PHASE=resume   (after a server restart, receiver back) the same delivery is delivered, same webhook-id
// Writes /out/webhooks.json for run.sh (secrets to look for in the server log, ids).
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const URL_ = process.env.URL, KEY = process.env.KEY, PHASE = process.env.PHASE ?? 'setup';
const RX = process.env.RX_URL ?? 'http://receiver:8080', MAILPIT = process.env.MAILPIT_URL ?? 'http://mailpit:8025';
const STATE = process.env.STATE_FILE ?? '/out/webhooks.json';
let fail = 0;
const check = (name, ok, extra = '') => { if (!ok) fail++; console.log(`${ok ? '✔' : '✘'} ${name}${extra ? `: ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 60_000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(1500); } return null; }
const c = new Client({ name: 'e2e-webhooks', version: '1' });
await c.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
// The default rate limit (300/min per key) applies to this agent too: wait and retry when it answers rate_limited.
const raw = async (name, args = {}) => {
  for (let i = 0; ; i++) {
    let r;
    try { r = await c.callTool({ name, arguments: args }); } catch (e) { if (i < 20 && /429|rate/i.test(String(e?.message ?? e))) { await sleep(3000); continue; } throw e; }
    const t = r.content.map((x) => x.text ?? '').join('');
    const v = r.isError ? { error: JSON.parse(t).error, _text: t } : { ...JSON.parse(t), _text: t };
    if (v.error?.code !== 'rate_limited' || i >= 20) return v;
    await sleep(3000);
  }
};
const received = async () => (await fetch(`${RX}/_received`)).json();
const counts = async (id) => (await raw('get_webhook', { webhookId: id })).deliveries;

if (PHASE === 'setup') {
  const creds = { resend: process.env.RESEND_KEY, postmark: process.env.POSTMARK_TOKEN, sendgrid: process.env.SENDGRID_KEY, sesId: process.env.SES_KEY_ID, sesSecret: process.env.SES_SECRET };
  const secrets = [...Object.values(creds)];
  // ---- providers over update_config ---------------------------------------------------------
  const cfg = await raw('update_config', { settings: {
    'notifications.email.from': 'RenderWeld E2E <studio@example.com>',
    'notifications.email.resend.apiKey': creds.resend, 'notifications.email.postmark.serverToken': creds.postmark, 'notifications.email.sendgrid.apiKey': creds.sendgrid,
    'notifications.email.ses.region': 'eu-west-1', 'notifications.email.ses.accessKeyId': creds.sesId, 'notifications.email.ses.secretAccessKey': creds.sesSecret,
    'webhooks.retryBaseSeconds': 1, 'webhooks.maxAttempts': 3, 'webhooks.timeoutSeconds': 5,
  } });
  check('NTF-11 email provider credentials stored over update_config (encrypted, never echoed)', !cfg.error && !secrets.some((s) => cfg._text.includes(s)), cfg.error?.message ?? `${cfg.changes?.length} settings`);
  const startup = await raw('update_config', { settings: { 'webhooks.allowPrivateNetworks': false } });
  check('WHK-03 webhooks.allowPrivateNetworks cannot be changed over the API (start-up only)', startup.error?.code === 'startup_only_setting', startup.error?.code);
  const conf = await raw('get_config', { prefix: 'notifications.email.resend' });
  check('get_config shows the Resend key only as set, source runtime, encrypted', JSON.stringify(conf).includes('"set"') && !conf._text.includes(creds.resend));

  // ---- one endpoint per channel -------------------------------------------------------------
  const make = async (args) => { const r = await raw('create_webhook', args); if (r.error) throw new Error(`create_webhook ${args.name}: ${r.error.message}`); return r; };
  const hook = await make({ name: 'e2e signed webhook', url: `${RX}/hook/main`, events: ['job.*', 'render.ready', 'key.created', 'key.revoked', 'config.changed'] });
  secrets.push(hook.secret);
  await fetch(`${RX}/_secret`, { method: 'POST', body: JSON.stringify({ path: '/hook/main', secret: hook.secret }) });
  check('WHK-20 create_webhook returns the whsec_ signing secret once; list_webhooks never shows it', /^whsec_/.test(hook.secret) && !(await raw('list_webhooks'))._text.includes(hook.secret));
  const chats = {};
  for (const [type, path] of [['slack', '/slack/services/T0E2E/B0E2E/chatToken1'], ['discord', '/discord/api/webhooks/1/chatToken2'], ['teams', '/teams/workflows/chatToken3']]) {
    chats[type] = await make({ name: `e2e ${type}`, type, url: `${RX}${path}`, events: ['render.ready', 'job.failed'] });
  }
  check('chat endpoints have no signing secret and masked URLs', Object.values(chats).every((x) => !x.secret && !x.webhook.url.includes('chatToken')), Object.values(chats).map((x) => x.webhook.url).join(' '));
  const mails = {};
  for (const provider of ['smtp', 'resend', 'postmark', 'sendgrid', 'ses']) {
    mails[provider] = await make({ name: `e2e mail ${provider}`, type: 'email', email: { provider, to: [`ops+${provider}@example.com`] }, events: ['render.ready'] });
  }
  const notConfigured = (await raw('list_webhooks')).webhooks.filter((w) => !w.provider.configured);
  check('every provider reports itself configured', notConfigured.length === 0, notConfigured.map((w) => `${w.name}: ${w.provider.missing}`).join('; '));
  const dead500 = await make({ name: 'e2e 500', url: `${RX}/status/500`, events: ['key.created'] });
  const dead400 = await make({ name: 'e2e 400', url: `${RX}/status/400`, events: ['key.created'] });

  // ---- events from real calls -----------------------------------------------------------------
  const project = { schemaVersion: '0.2', projectId: 'e2e-webhooks', title: 'Webhooks e2e', output: { width: 1080, height: 1920, fps: 30, format: 'mp4' }, scenes: [{ id: 'one', engine: 'html', html: '<h1 class="t">events</h1>', css: '.t{color:#fff;font-size:120px}', durationSeconds: 1 }] };
  const created = await raw('create_project', { manifest: project });
  check('a small html project for the render events', !created.error, created.error?.message);
  const rendered = await raw('render_project', { projectId: 'e2e-webhooks' });
  if (!rendered.job) { console.log(`✘ render_project: ${rendered._text.slice(0, 500)}`); process.exit(1); }
  const job = rendered.job;
  let st = job; for (let i = 0; i < 20 && !['succeeded', 'failed', 'cancelled'].includes(st?.status); i++) st = await raw('get_job', { jobId: job.id, waitSeconds: 45 });
  check('render finished', st?.status === 'succeeded', st?.status);
  await raw('update_config', { settings: { 'webhooks.timeoutSeconds': 6 } }); // config.changed
  const key = await raw('create_key', { name: 'e2e evented key', scopes: ['read'] });
  secrets.push(key.key);
  await raw('revoke_key', { keyId: key.record.id });

  // ---- WHK-04: signed webhook, verified by the receiver with the official library ---------------
  const want = ['job.queued', 'job.started', 'job.succeeded', 'render.ready', 'key.created', 'key.revoked', 'config.changed'];
  const main = await until(async () => { const r = (await received()).filter((x) => x.path === '/hook/main'); const t = new Set(r.map((x) => JSON.parse(x.body).type)); return want.every((w) => t.has(w)) ? r : null; }, 90_000);
  const mainTypes = [...new Set((main ?? []).map((x) => JSON.parse(x.body).type))];
  check('WHK-04 the signed webhook received job.queued/started/succeeded, render.ready, key.created/revoked, config.changed', !!main, mainTypes.join(', '));
  check('WHK-01 every message verified with the official standardwebhooks library (HMAC-SHA256, webhook-id/-timestamp/-signature)', !!main && main.every((x) => x.signature === 'valid'), `${main?.length} messages`);
  const ready = main?.map((x) => JSON.parse(x.body)).find((e) => e.type === 'render.ready');
  check('render.ready carries renderId, projectId, jobId and no signed download link', ready?.data?.projectId === 'e2e-webhooks' && /^run_/.test(ready?.data?.renderId ?? '') && ready?.data?.jobId === job.id && !JSON.stringify(ready).includes('downloadUrl'), ready?.data?.renderId);
  const kc = main?.map((x) => JSON.parse(x.body)).find((e) => e.type === 'key.created');
  check('key.created has the key id and name, never the key', kc?.data?.keyId === key.record.id && !JSON.stringify(main.map((x) => x.body)).includes(key.key));

  // ---- NTF: chat and email ----------------------------------------------------------------------
  const all = await until(async () => { const r = await received(); const p = (s) => r.some((x) => x.path.startsWith(s)); return ['/slack/', '/discord/', '/teams/', '/resend/', '/postmark/', '/sendgrid/', '/ses/'].every(p) ? r : null; }, 60_000) ?? await received();
  const body = (prefix) => { const x = all.find((y) => y.path.startsWith(prefix)); return x ? JSON.parse(x.body || '{}') : null; };
  check('NTF-01 Slack incoming webhook: {text, blocks}', /ready/.test(body('/slack/')?.text ?? ''), body('/slack/')?.text);
  check('NTF-02 Discord webhook: {content}, mentions off', /render.ready/.test(body('/discord/')?.content ?? '') && JSON.stringify(body('/discord/')?.allowed_mentions) === '{"parse":[]}');
  check('NTF-03 Teams: Adaptive Card message', body('/teams/')?.attachments?.[0]?.contentType === 'application/vnd.microsoft.card.adaptive');
  for (const [p, n, id] of [['/resend/', 'Resend', 'NTF-05'], ['/postmark/', 'Postmark', 'NTF-06'], ['/sendgrid/', 'SendGrid', 'NTF-07'], ['/ses/', 'Amazon SES (SigV4)', 'NTF-08']]) {
    const hits = all.filter((x) => x.path.startsWith(p));
    check(`${id} ${n} stub received the email with the right credential header`, hits.length >= 1 && hits.every((x) => x.auth === 'ok'), `${hits.length} request(s)`);
  }
  const mail = await until(async () => { const r = await (await fetch(`${MAILPIT}/api/v1/messages`)).json(); return r.messages?.find((m) => m.To?.some((t) => t.Address === 'ops+smtp@example.com')) ?? null; }, 60_000);
  check('NTF-04 SMTP: Mailpit caught the email (read over its HTTP API)', !!mail && /ready/.test(mail.Subject), mail ? `${mail.Subject} -> ${mail.To[0].Address}` : 'none');
  if (mail) {
    const full = await (await fetch(`${MAILPIT}/api/v1/message/${mail.ID}`)).json();
    check('the email is plain text with the event details and a stable Message-ID', /e2e-webhooks/.test(full.Text) && /msg_[a-z0-9]+@renderweld\.local/.test(full.MessageID ?? ''), full.MessageID);
  }
  const mailDone = await until(async () => { for (const m of Object.values(mails)) if ((await counts(m.webhook.id)).succeeded < 1) return false; return true; }, 60_000);
  check('every email channel shows a succeeded delivery', !!mailDone);

  // ---- retries, dead letter, 4xx, replay ----------------------------------------------------------
  const d500 = await until(async () => (await counts(dead500.webhook.id)).dead === 1, 60_000);
  const log500 = (await raw('list_webhook_deliveries', { webhookId: dead500.webhook.id, status: 'dead' })).deliveries?.[0];
  check('WHK-05/07 a 500 is retried with backoff and becomes dead after webhooks.maxAttempts (3)', !!d500 && log500?.attempts === 3 && log500.attemptLog.every((a) => a.status === 500), log500?.attemptLog?.map((a) => a.at.slice(17, 23)).join(' '));
  const log400 = await until(async () => (await raw('list_webhook_deliveries', { webhookId: dead400.webhook.id })).deliveries?.find((d) => d.status === 'dead'), 30_000);
  check('WHK-06 a 400 is not retried (dead after one attempt)', log400?.attempts === 1 && log400?.lastStatus === 400);
  const rep = await raw('replay_webhook_delivery', { webhookId: dead500.webhook.id, deliveryId: log500?.id });
  check('replay_webhook_delivery queues it again with the same webhook-id', rep.delivery?.messageId === log500?.messageId && rep.delivery?.replayOf === log500?.id);
  const t = await raw('test_webhook', { webhookId: hook.webhook.id, waitSeconds: 20 });
  check('test_webhook with waitSeconds reports the first attempt', t.delivery?.status === 'succeeded' && t.delivery?.lastStatus === 200, t.delivery?.status);
  // A wrong provider credential: 401, not retried, the error names the setting, never the value.
  await raw('update_config', { settings: { 'notifications.email.resend.apiKey': 're_wrong_key_e2e_0000000000' } });
  secrets.push('re_wrong_key_e2e_0000000000');
  const bad = await raw('test_webhook', { webhookId: mails.resend.webhook.id, waitSeconds: 20 });
  check('NTF-09 a wrong Resend key: dead after one attempt, "check notifications.email.resend.apiKey", no key in the log', bad.delivery?.status === 'dead' && bad.delivery?.lastStatus === 401 && /check notifications\.email\.resend\.apiKey/.test(bad.delivery?.lastError ?? '') && !bad._text.includes('re_wrong_key'), bad.delivery?.lastError);
  await raw('update_config', { settings: { 'notifications.email.resend.apiKey': creds.resend, 'webhooks.maxAttempts': 20, 'webhooks.retryMaxDelaySeconds': 10 } });

  // ---- no secrets in any answer ------------------------------------------------------------------
  const dump = [(await raw('list_webhooks'))._text, (await raw('list_webhook_deliveries', { webhookId: hook.webhook.id, includePayload: true }))._text, (await raw('list_audit_events', { action: 'webhook*', limit: 1000 }))._text].join('\n');
  check('WHK-12 no signing secret, chat token or provider key in list_webhooks, the delivery log or the audit trail', !secrets.some((s) => dump.includes(s.startsWith('whsec_') ? s.slice(6) : s)) && !dump.includes('chatToken'));
  writeFileSync(STATE, JSON.stringify({ hookId: hook.webhook.id, secrets: [...secrets, 'chatToken1', 'chatToken2', 'chatToken3'] }));
}

if (PHASE === 'pending') {
  const s = JSON.parse(readFileSync(STATE, 'utf8'));
  const t = await raw('test_webhook', { webhookId: s.hookId });
  // Retries start after about 1 s, so a single read can catch the row `delivering` its next attempt: wait for a read
  // that shows it pending again after a failed attempt (it never matches once dead or succeeded).
  let last;
  const d = await until(async () => {
    last = (await raw('list_webhook_deliveries', { webhookId: s.hookId })).deliveries.find((x) => x.id === t.delivery.id);
    return last && last.attempts >= 1 && last.status === 'pending' && !last.lastStatus && !!last.lastError ? last : null;
  }, 30_000);
  check('WHK-09 receiver down: the delivery stays pending with a failed attempt (no answer)', d?.status === 'pending' && !d.lastStatus && !!d.lastError, d?.lastError ?? (last && `${last.status}, ${last.attempts} attempt(s): ${last.lastError}`));
  writeFileSync(STATE, JSON.stringify({ ...s, pending: t.delivery.id, messageId: t.delivery.messageId }));
}

if (PHASE === 'resume') {
  const s = JSON.parse(readFileSync(STATE, 'utf8'));
  const d = await until(async () => (await raw('list_webhook_deliveries', { webhookId: s.hookId })).deliveries.find((x) => x.id === s.pending && x.status === 'succeeded'), 120_000);
  check('WHK-10 after a server restart the pending delivery was sent (outbox survives restarts)', !!d, d ? `${d.attempts} attempts` : 'still not delivered');
  const r = (await received()).filter((x) => x.headers['webhook-id'] === s.messageId);
  check('the receiver got it once with the same webhook-id, signature valid', r.length === 1 && r[0].signature === 'valid', `${r.length}`);
}
await c.close();
if (fail) { console.log(`${fail} webhook check(s) failed`); process.exit(1); }
