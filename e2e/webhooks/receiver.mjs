// Docker e2e receiver for outbound events (#66). One small HTTP server, network alias "receiver":
//   POST /hook/<name>          a webhook receiver: verifies the Standard Webhooks signature with the official
//                              standardwebhooks library (secret registered with POST /_secret {path, secret})
//   POST /slack/... /discord/... /teams/...   chat incoming webhooks (shape checked by the client)
//   POST /resend/emails, /postmark/email, /sendgrid/v3/mail/send, /ses/v2/email/outbound-emails
//                              HTTP stubs of the email APIs: they check the credential header
//                              (Resend/SendGrid bearer, Postmark token, SES SigV4 access key id) and answer
//                              like the real service (200 / 202, 401 for a wrong credential)
//   POST /status/<code>        always answers <code> (retries, dead letter, 4xx)
//   GET  /_received            everything received, as JSON
// No dependencies besides standardwebhooks (installed next to the e2e client). SECRETS_FILE keeps the registered
// secrets across a restart of this container.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Webhook } from 'standardwebhooks';

const PORT = Number(process.env.PORT ?? 8080);
const expect = { resend: process.env.RESEND_KEY, postmark: process.env.POSTMARK_TOKEN, sendgrid: process.env.SENDGRID_KEY, ses: process.env.SES_KEY_ID };
// Registered secrets survive a receiver restart (the e2e stops it to test retries) when SECRETS_FILE is set.
const SECRETS_FILE = process.env.SECRETS_FILE;
const secrets = new Map(SECRETS_FILE && existsSync(SECRETS_FILE) ? Object.entries(JSON.parse(readFileSync(SECRETS_FILE, 'utf8'))) : []);
const received = [];

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const path = (req.url ?? '/').split('?')[0];
    const json = (status, v) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (req.method === 'GET' && path === '/_received') return json(200, received);
    if (req.method === 'POST' && path === '/_secret') {
      const { path: p, secret } = JSON.parse(body);
      secrets.set(p, secret);
      if (SECRETS_FILE) writeFileSync(SECRETS_FILE, JSON.stringify(Object.fromEntries(secrets)), { mode: 0o600 });
      return json(200, { ok: true });
    }
    const entry = { at: new Date().toISOString(), path, headers: req.headers, body };
    received.push(entry);
    if (path.startsWith('/hook/')) {
      const secret = secrets.get(path);
      try {
        if (!secret) throw new Error('no secret registered for this path');
        entry.verified = new Webhook(secret).verify(body, req.headers);
        entry.signature = 'valid';
        return json(200, { ok: true });
      } catch (e) {
        entry.signature = `invalid: ${e.message}`;
        return json(400, { error: 'bad signature' });
      }
    }
    if (path.startsWith('/status/')) return res.writeHead(Number(path.slice(8)) || 500).end();
    if (path.startsWith('/slack/')) return res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    if (path.startsWith('/discord/')) return res.writeHead(204).end();
    if (path.startsWith('/teams/')) return res.writeHead(202).end();
    if (path === '/resend/emails') {
      if (req.headers.authorization !== `Bearer ${expect.resend}`) return (entry.auth = 'bad'), json(401, { name: 'validation_error', message: 'API key is invalid' });
      return (entry.auth = 'ok'), json(200, { id: `re_${received.length}` });
    }
    if (path === '/postmark/email') {
      if (req.headers['x-postmark-server-token'] !== expect.postmark) return (entry.auth = 'bad'), json(401, { ErrorCode: 10, Message: 'Request does not contain a valid Server token.' });
      return (entry.auth = 'ok'), json(200, { ErrorCode: 0, Message: 'OK', MessageID: `pm-${received.length}` });
    }
    if (path === '/sendgrid/v3/mail/send') {
      if (req.headers.authorization !== `Bearer ${expect.sendgrid}`) return (entry.auth = 'bad'), json(401, { errors: [{ message: 'The provided authorization grant is invalid, expired, or revoked' }] });
      return (entry.auth = 'ok'), res.writeHead(202).end();
    }
    if (path === '/ses/v2/email/outbound-emails') {
      const auth = String(req.headers.authorization ?? '');
      if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${expect.ses}/`)) return (entry.auth = 'bad'), json(403, { message: 'The security token included in the request is invalid.' });
      return (entry.auth = 'ok'), json(200, { MessageId: `ses-${received.length}` });
    }
    json(404, { error: 'no route' });
  });
}).listen(PORT, () => console.log(`webhook receiver on ${PORT}`));
