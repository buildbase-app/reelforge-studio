// A mock of the BuildBase licence API (the routes `LicensesApi` of @buildbase/sdk calls), for
// tests and the Docker e2e. CI never talks to the real licence server (issue #25).
//
//   POST /api/v1/licenses/:orgId/validate     { key, instance? }
//   POST /api/v1/licenses/:orgId/activate     { key, instance }
//   POST /api/v1/licenses/:orgId/deactivate   { key, instance }
//   -> 200 { valid, reason, key: { status, activations, activationLimit, expiresAt }, item, instance }
//
// Test controls (not part of BuildBase):
//   POST /_admin/keys                 { key, activationLimit?, status?, expiresAt?, activations?: [instance] }
//   POST /_admin/keys/:key/revoke     (status "revoked")
//   POST /_admin/mode                 { mode: "normal" | "rate_limited" | "error" | "drop" }
//   GET  /_admin/state                keys, activations, every request seen (field and header names only), and
//                                     counts per operation (licence at scale, D-098: one activate per deployment)
//
// Standalone:  PORT=8080 ORG_ID=<org> SEED_KEYS='[{"key":"...","activationLimit":1}]' node server.mjs
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const ITEM = { id: 'itm_mock_reelforge', title: 'ReelForge Studio (mock)' };

/** Start the mock. Resolves to { url, port, state, close(), addKey(), revoke(), setMode(), counts() }. */
export function startMockLicenceServer({ port = 0, host = '127.0.0.1', orgId = '6b01478bb42d2c444e99fcd8', keys = [] } = {}) {
  const store = new Map();
  const requests = [];
  let mode = 'normal';
  const addKey = (k) => {
    store.set(k.key, {
      status: k.status ?? 'active',
      activationLimit: k.activationLimit === undefined ? 1 : k.activationLimit,
      expiresAt: k.expiresAt ?? null,
      activations: new Map((k.activations ?? []).map((i) => [i, new Date().toISOString()])),
    });
  };
  for (const k of keys) addKey(k);
  const counts = () => {
    const c = { activate: 0, validate: 0, deactivate: 0 };
    for (const r of requests) c[r.op]++;
    return c;
  };
  const view = (rec) => ({ status: rec.status, activations: rec.activations.size, activationLimit: rec.activationLimit, expiresAt: rec.expiresAt });
  const instanceView = (rec, instance) => (instance && rec.activations.has(instance) ? { instance, activatedAt: rec.activations.get(instance) } : null);

  function answer(op, body) {
    const rec = store.get(body.key);
    if (!rec) return { valid: false, reason: 'not_found' };
    if (rec.expiresAt && Date.parse(rec.expiresAt) < Date.now() && rec.status === 'active') rec.status = 'expired';
    if (op === 'deactivate') {
      rec.activations.delete(body.instance);
      return { valid: rec.status === 'active', reason: rec.status === 'active' ? null : rec.status, key: view(rec), item: ITEM, instance: null };
    }
    if (rec.status !== 'active') return { valid: false, reason: rec.status, key: view(rec), item: ITEM, instance: instanceView(rec, body.instance) };
    if (op === 'activate') {
      if (!rec.activations.has(body.instance)) {
        if (rec.activationLimit !== null && rec.activations.size >= rec.activationLimit) {
          return { valid: false, reason: 'limit_reached', key: view(rec), item: ITEM, instance: null };
        }
        rec.activations.set(body.instance, new Date().toISOString());
      }
      return { valid: true, reason: null, key: view(rec), item: ITEM, instance: instanceView(rec, body.instance) };
    }
    // validate
    if (body.instance && rec.activationLimit !== null && !rec.activations.has(body.instance)) {
      return { valid: false, reason: 'not_activated', key: view(rec), item: ITEM, instance: null };
    }
    return { valid: true, reason: null, key: view(rec), item: ITEM, instance: instanceView(rec, body.instance) };
  }

  const send = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(obj));
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return send(res, 400, { code: 'BAD_JSON', message: 'body must be JSON' });
      }
      const url = new URL(req.url, 'http://mock');
      if (url.pathname.startsWith('/_admin/')) {
        if (req.method === 'GET' && url.pathname === '/_admin/state') {
          return send(res, 200, {
            mode,
            keys: Object.fromEntries([...store].map(([k, r]) => [k, { ...view(r), instances: [...r.activations.keys()] }])),
            requests,
            counts: counts(),
          });
        }
        if (req.method === 'POST' && url.pathname === '/_admin/keys') {
          addKey(body);
          return send(res, 201, { ok: true });
        }
        const revoke = /^\/_admin\/keys\/([^/]+)\/revoke$/.exec(url.pathname);
        if (req.method === 'POST' && revoke) {
          const rec = store.get(decodeURIComponent(revoke[1]));
          if (!rec) return send(res, 404, { code: 'NOT_FOUND' });
          rec.status = 'revoked';
          return send(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/_admin/mode') {
          mode = body.mode;
          return send(res, 200, { ok: true, mode });
        }
        return send(res, 404, { code: 'NOT_FOUND' });
      }
      const m = /^\/api\/v1\/licenses\/([^/]+)\/(validate|activate|deactivate)$/.exec(url.pathname);
      if (!m || req.method !== 'POST') return send(res, 404, { code: 'NOT_FOUND', message: `no route ${req.method} ${url.pathname}` });
      // What the client sent, without values: the privacy contract is "key and instance only".
      requests.push({ op: m[2], org: decodeURIComponent(m[1]), fields: Object.keys(body).sort(), headers: Object.keys(req.headers).sort(), instance: body.instance ?? null });
      if (mode === 'drop') return req.socket.destroy();
      if (mode === 'rate_limited') return send(res, 429, { code: 'LICENSE_CHECKS_LIMITED', message: 'Too many licence checks', retryAfterSeconds: 120 }, { 'retry-after': '120' });
      if (mode === 'error') return send(res, 503, { code: 'SERVICE_UNAVAILABLE', message: 'try again later' });
      if (decodeURIComponent(m[1]) !== orgId) return send(res, 404, { code: 'ORG_NOT_FOUND', message: 'unknown organisation' });
      if (typeof body.key !== 'string' || ((m[2] === 'activate' || m[2] === 'deactivate') && typeof body.instance !== 'string')) {
        return send(res, 400, { code: 'VALIDATION_ERROR', message: 'key (and instance) required' });
      }
      return send(res, 200, answer(m[2], body));
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const p = server.address().port;
      resolve({
        url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${p}`,
        port: p,
        orgId,
        requests,
        addKey,
        revoke: (key) => {
          store.get(key).status = 'revoked';
        },
        setMode: (m) => {
          mode = m;
        },
        activations: (key) => [...(store.get(key)?.activations.keys() ?? [])],
        counts,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const keys = process.env.SEED_KEYS ? JSON.parse(process.env.SEED_KEYS) : [];
  const s = await startMockLicenceServer({ port: Number(process.env.PORT ?? 8080), host: '0.0.0.0', orgId: process.env.ORG_ID, keys });
  console.log(`mock licence server on ${s.url} (org ${s.orgId}, ${keys.length} keys)`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => s.close().then(() => process.exit(0)));
}
