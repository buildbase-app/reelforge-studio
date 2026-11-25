/**
 * Spike (render-at-scale research, docs/research/RENDER_SCALE.md §5): do one `api` and
 * N `worker` processes on ONE PostgreSQL database take ONE licence activation?
 *
 * Each "instance" is a separate OS process (this file with ROLE=instance) with its own
 * database connection and its own LicenceManager, all started at the same moment, as an
 * orchestrator would start 1 api + N workers. The licence server is the repository's mock
 * of the BuildBase licence API (e2e/mock-licence/server.mjs), activationLimit 1.
 *
 *   DB_URL=postgresql://... N=4 node --import tsx research/spikes/render-scale/licence-instance.ts
 *
 * With DB_URL2 set, one more process ("region2-api") runs on a second, separate database
 * against the same mock licence server, as a second deployment (region) would.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BuildBaseLicenceClient, LicenceManager } from '@renderweld/core';
import { Database, prepareDatabase } from '@renderweld/db';

const ORG = '6b01478bb42d2c444e99fcd8';
const KEY = 'SPIKE-AAAAA-BBBBB-CCCCC-DDDDD';
const env = process.env;

if (env.ROLE === 'instance') {
  const db = await Database.open({ url: env.DB_URL! });
  const repos = db.repositories();
  await new Promise((r) => setTimeout(r, Math.max(0, Number(env.START_AT) - Date.now())));
  const m = new LicenceManager({
    repo: repos.licence,
    api: new BuildBaseLicenceClient({ serverUrl: env.LICENCE_URL!, orgId: ORG }),
    key: () => ({ value: KEY, source: 'env' }),
    mode: 'required',
    graceDays: 14,
    licenceServer: { url: env.LICENCE_URL!, orgId: ORG },
    timers: false,
    sealSecret: 'spike-secret-key-0123456789abcdef0123456789',
  });
  await m.init();
  const r = await m.check('start');
  console.log(JSON.stringify({ name: env.NAME, instanceId: m.instanceId, status: r.status, activations: r.activations }));
  await db.close();
  process.exit(0);
}

// ---- orchestrator ----
const { startMockLicenceServer } = await import(new URL('../../../e2e/mock-licence/server.mjs', import.meta.url).href);
const mock = await startMockLicenceServer({ orgId: ORG, keys: [{ key: KEY, activationLimit: 1 }] });
const n = Number(env.N ?? 4);
for (const url of [env.DB_URL!, ...(env.DB_URL2 ? [env.DB_URL2] : [])]) {
  await prepareDatabase({ url, dataDir: '/tmp/reelforge-spike-none' }).then((p: { db: Database }) => p.db.close());
}
const startAt = Date.now() + 1500;
const names = ['api', ...Array.from({ length: n - 1 }, (_, i) => `worker-${i + 1}`), ...(env.DB_URL2 ? ['region2-api'] : [])];
const outs = await Promise.all(
  names.map(
    (name) =>
      new Promise<string>((done) => {
        const c = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
          env: { ...env, ...(name === 'region2-api' ? { DB_URL: env.DB_URL2 } : {}), ROLE: 'instance', NAME: name, START_AT: String(startAt + (name === 'region2-api' ? 3000 : 0)), LICENCE_URL: mock.url },
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        c.on('exit', () => done(out.trim()));
      })
  )
);
for (const o of outs) console.log(o);
const st = await (await fetch(`${mock.url}/_admin/state`)).json();
const reqs = st.requests as Array<{ op: string; instance: string | null }>;
console.log(
  JSON.stringify(
    {
      processes: n,
      distinctInstanceIds: new Set(outs.map((o) => JSON.parse(o).instanceId)).size,
      activationsHeldByKey: st.keys[KEY].activations,
      instancesHoldingActivation: st.keys[KEY].instances,
      licenceServerCalls: reqs.reduce((a: Record<string, number>, r) => ((a[r.op] = (a[r.op] ?? 0) + 1), a), {}),
    },
    null,
    2
  )
);
await mock.close();
