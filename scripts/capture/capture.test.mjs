// Unit tests of the capture pipeline's pure parts: naming, masking, budgets,
// the manifest and idempotent uploads, redaction and the generated pages.
// Run: pnpm test:capture (node --test, no browser, no network).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MASK,
  applyUploadResults,
  assetName,
  emptyManifest,
  encodeLadder,
  findSecrets,
  maskText,
  maskingInitScript,
  mergeCaptured,
  parseArgs,
  parseAssetName,
  planUploads,
  redactConfig,
  routeSlug,
  shotKey,
  siteLabel,
  stableJson,
  WEBP_MAX_DIMENSION,
} from './lib.mjs';
import { syncAssets } from './assets.mjs';
import { renderStorePage, renderWalkthroughsPage } from './docs.mjs';
import { buildFixture, summarizeResult } from './fixture-from-transcript.mjs';
import { mergeBlueprints, renderConsolePage } from './steps/console.mjs';
import { cleanOutput, terminalPage } from './terminal.mjs';

const KEY = 'AB12C-DE34F-GH56J-KL78M-NP90Q';
const sha = (c) => c.repeat(64);

describe('arguments', () => {
  it('parses every option', () => {
    const a = parseArgs(['--site', 'https://x.test/', '--site=https://y.test', '--only', 'pages,studio', '--upload', '--dry-run', '--widths', '390', '--themes=dark', '--routes', '/,/pricing']);
    assert.deepEqual(a.sites, ['https://x.test', 'https://y.test']);
    assert.deepEqual(a.only, ['pages', 'studio']);
    assert.equal(a.upload, true);
    assert.equal(a.dryRun, true);
    assert.deepEqual(a.widths, [390]);
    assert.deepEqual(a.themes, ['dark']);
    assert.deepEqual(a.routes, ['/', '/pricing']);
  });
  it('defaults to every step and refuses unknown ones', () => {
    assert.deepEqual(parseArgs([]).only, ['pages', 'flows', 'videos', 'studio', 'console']);
    assert.throws(() => parseArgs(['--only', 'everything']), /--only takes/);
    assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
    assert.throws(() => parseArgs(['--site']), /needs a value/);
  });
});

describe('deterministic names', () => {
  it('slugs routes and labels sites', () => {
    assert.equal(routeSlug('/'), 'home');
    assert.equal(routeSlug('/docs/start/quick-start'), 'docs-start-quick-start');
    assert.equal(routeSlug('/order?id=123'), 'order');
    assert.equal(siteLabel('https://reelforge-dev.buildbase.app'), 'dev');
    assert.equal(siteLabel('https://reelforge.buildbase.app'), 'prod');
    assert.equal(siteLabel('http://127.0.0.1:4000'), '127-0-0-1-4000');
  });
  it('builds the same key for the same state and round-trips asset names', () => {
    const k = shotKey({ group: 'store', site: 'dev', slug: 'pricing', width: 1440, theme: 'dark', crop: 'fold' });
    assert.equal(k, 'store--dev--pricing--1440--dark--fold');
    assert.equal(k, shotKey({ crop: 'fold', theme: 'dark', width: 1440, slug: 'pricing', site: 'dev', group: 'store' }));
    const name = assetName(k, sha('a'));
    assert.equal(name, 'rf-capture--store--dev--pricing--1440--dark--fold--aaaaaaaa.webp');
    assert.deepEqual(parseAssetName(name), { key: k, hash8: 'aaaaaaaa' });
    assert.equal(parseAssetName('logo.png'), null);
  });
});

describe('masking', () => {
  it('masks licence keys, emails and tokens, keeping allowed addresses', () => {
    const text = `key ${KEY} for docs-buyer-x1+test@reelforge.dev, api rf_${'a'.repeat(20)}-${'c'.repeat(22)}, Bearer abcdefghijklmnopqrstuvwx, /v1/renders/r/output?expires=1&sig=8XGmGz0qiKdhe8KCgZ2NzSdMfzeggcgg, sk_test_${'b'.repeat(20)}, ok noreply@anthropic.com`;
    const out = maskText(text);
    assert.ok(out.includes(MASK.key));
    assert.ok(!out.includes(KEY));
    assert.ok(!out.includes('+test@'));
    assert.ok(out.includes(MASK.email));
    assert.ok(!/rf_a{10}/.test(out) && !out.includes('ccccccccc'), 'a base64url key is masked whole');
    assert.ok(!out.includes('abcdefghijklmnopqrstuvwx'));
    assert.ok(!out.includes('8XGmGz0q'));
    assert.ok(!out.includes('sk_test_b'));
    assert.ok(out.includes('noreply@anthropic.com'));
    assert.deepEqual(findSecrets(out), []);
  });
  it('finds what is left without echoing it', () => {
    const found = findSecrets(`${KEY} a@b.co`);
    assert.deepEqual(found.map((f) => f.kind).sort(), ['email', 'licence-key']);
    assert.ok(found.every((f) => !f.hint.includes(KEY) && f.hint.length < 12));
    assert.deepEqual(findSecrets('placeholder rf_... and pnpm@10.28.0 and @reelforge/core'), []);
  });
  it('produces an init script that parses and carries the patterns', () => {
    const src = maskingInitScript({ allowEmails: ['hello@example.org'] });
    assert.doesNotThrow(() => new Function(src));
    assert.ok(src.includes('hello@example.org'));
    assert.ok(src.includes('-webkit-text-security'));
  });
});

describe('image budgets', () => {
  it('keeps full pages at 1x css width and never taller than WebP allows', () => {
    const tall = encodeLadder({ width: 780, height: 40000, crop: 'full' });
    assert.ok(tall.every((s) => s.height <= WEBP_MAX_DIMENSION));
    const page = encodeLadder({ width: 2880, height: 5000, crop: 'full' });
    assert.equal(page[0].width, 1440);
    assert.ok(page.every((s) => s.width >= 1080));
    assert.equal(page[0].maxBytes, 400_000);
  });
  it('keeps fold crops at 2x first, within 150 KB', () => {
    const fold = encodeLadder({ width: 2880, height: 1800, crop: 'fold' });
    assert.deepEqual([fold[0].width, fold[0].height, fold[0].quality, fold[0].maxBytes], [2880, 1800, 80, 150_000]);
    assert.ok(fold.at(-1).width < 2880);
  });
});

describe('manifest and idempotent uploads', () => {
  const local = [
    { key: 'store--dev--home--390--light--fold', sha256: sha('1'), file: '/x/a.webp' },
    { key: 'store--dev--home--390--light--full', sha256: sha('2'), file: '/x/b.webp' },
  ];
  it('uploads everything on the first run', () => {
    const plan = planUploads(local, emptyManifest(), []);
    assert.deepEqual(plan.map((a) => a.type), ['upload', 'upload']);
    assert.equal(plan[0].name, assetName(local[0].key, sha('1')));
  });
  it('skips unchanged images, replaces changed ones and deletes the old asset', () => {
    const manifest = { images: { [local[0].key]: { sha256: sha('1'), assetId: 'A' }, [local[1].key]: { sha256: sha('9'), assetId: 'B' } } };
    const remote = [
      { _id: 'A', name: assetName(local[0].key, sha('1')) },
      { _id: 'B', name: assetName(local[1].key, sha('9')) },
    ];
    const plan = planUploads(local, manifest, remote);
    assert.deepEqual(plan.map((a) => `${a.type}:${a.assetId ?? a.key}`), ['skip:A', `upload:${local[1].key}`, 'delete:B']);
  });
  it('reuses an asset found by hash when the manifest was lost, and removes duplicates', () => {
    const remote = [
      { _id: 'A1', name: assetName(local[0].key, sha('1')) },
      { _id: 'A2', name: assetName(local[0].key, sha('1')) },
      { _id: 'X', name: 'someone-else.png' },
    ];
    const plan = planUploads([local[0]], emptyManifest(), remote);
    assert.deepEqual(plan.map((a) => `${a.type}:${a.assetId}`), ['reuse:A1', 'delete:A2']);
  });
  it('re-uploads when the manifest points at an asset that is gone', () => {
    const plan = planUploads([local[0]], { images: { [local[0].key]: { sha256: sha('1'), assetId: 'gone' } } }, []);
    assert.deepEqual(plan.map((a) => a.type), ['upload']);
  });
  it('marks changed captures pending and clears that once uploaded', () => {
    let m = mergeCaptured(emptyManifest(), [{ key: 'k', sha256: sha('1'), file: 'out/x.webp', title: 'Home', overBudget: false }]);
    assert.equal(m.images.k.pending, true);
    assert.equal(m.images.k.file, undefined);
    m = applyUploadResults(m, [{ type: 'upload', key: 'k', entry: { assetId: 'A', url: 'https://cdn/x', sha256: sha('1') } }]);
    assert.equal(m.images.k.pending, undefined);
    assert.equal(mergeCaptured(m, [{ key: 'k', sha256: sha('1') }]).images.k.pending, undefined);
    const changed = mergeCaptured(m, [{ key: 'k', sha256: sha('2') }]);
    assert.equal(changed.images.k.pending, true);
    assert.equal(changed.images.k.url, 'https://cdn/x');
    assert.equal(changed.images.k.uploadedSha256, sha('1'));
  });
  it('syncs against a fake asset API: second run writes nothing', async () => {
    const assets = [];
    let n = 0;
    const calls = [];
    const api = {
      listCaptureAssets: async () => structuredClone(assets),
      upload: async (file, name) => {
        calls.push(`upload ${name}`);
        const a = { _id: `id${++n}`, name, bucket: { url: `https://cdn/${name}` } };
        assets.push(a);
        return a;
      },
      delete: async (id) => {
        calls.push(`delete ${id}`);
        assets.splice(assets.findIndex((a) => a._id === id), 1);
      },
    };
    const log = () => {};
    let { manifest } = await syncAssets({ api, local, manifest: emptyManifest(), log });
    assert.equal(calls.length, 2);
    assert.equal(manifest.images[local[0].key].url, `https://cdn/${assetName(local[0].key, sha('1'))}`);
    ({ manifest } = await syncAssets({ api, local, manifest, log }));
    assert.equal(calls.length, 2, 'a re-run uploads nothing');
    const changed = [{ ...local[0], sha256: sha('3') }, local[1]];
    ({ manifest } = await syncAssets({ api, local: changed, manifest, log }));
    assert.deepEqual(calls.slice(2), [`upload ${assetName(local[0].key, sha('3'))}`, 'delete id1']);
    assert.equal(assets.length, 2, 'replaced, not duplicated');
    const dry = await syncAssets({ api, local: changed, manifest, dryRun: true, log });
    assert.ok(dry.actions.every((a) => a.type === 'skip'));
  });
  it('writes stable JSON', () => {
    assert.equal(stableJson({ b: 1, a: { d: 2, c: 3 } }), '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n');
  });
});

describe('console configuration as code', () => {
  const bp = mergeBlueprints([
    { webhooks: { store: { name: 'Store', url: 'https://s.test/api/webhooks/buildbase', events: ['*'], secret: 'whsec_abcdefghijklmnop' } } },
    { billing: { stripe: { publishableKey: 'pk_test_123456789', secretKey: '${env:STRIPE_TEST_SECRET_KEY}', webhookSecret: 'whsec_live_value_here' } }, auth: { clients: { dev: { title: 'dev', applicationTokenUrl: 'https://s.test/api/auth/token', clientSecret: 'shh-very-secret', redirectUrls: ['https://s.test'] } } } },
  ]);
  it('redacts secrets but keeps placeholders and URLs', () => {
    const r = redactConfig(bp);
    assert.equal(r.webhooks.store.secret, '[redacted]');
    assert.equal(r.billing.stripe.secretKey, '${env:STRIPE_TEST_SECRET_KEY}');
    assert.equal(r.billing.stripe.webhookSecret, '[redacted]');
    assert.equal(r.auth.clients.dev.clientSecret, '[redacted]');
    assert.equal(r.auth.clients.dev.applicationTokenUrl, 'https://s.test/api/auth/token');
    assert.equal(redactConfig({ owner: 'founder@example.org' }).owner, MASK.email);
  });
  it('renders a page without any secret', () => {
    const md = renderConsolePage({ blueprint: redactConfig(bp), live: {}, date: '2026-11-22' });
    assert.ok(md.startsWith('---\ntitle: "BuildBase console setup"'));
    assert.ok(md.includes('https://s.test/api/webhooks/buildbase'));
    for (const s of ['whsec_abc', 'whsec_live', 'shh-very-secret', 'pk_test_123456789']) assert.ok(!md.includes(s), s);
  });
});

describe('agent session fixture and terminal views', () => {
  it('summarizes tool results and masks signed links', () => {
    assert.match(summarizeResult('get_job', [{ type: 'text', text: JSON.stringify({ id: 'job_1', type: 'render', status: 'running', progress: { stage: 'assemble', fraction: 0.87 } }) }]), /running 87% \(assemble\)/);
    const lines = [
      JSON.stringify({ type: 'assistant', timestamp: '2026-11-21T10:00:00Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__reelforge__validate_project', input: { projectId: 'p' } }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-11-21T10:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: JSON.stringify({ ok: true, errors: [], warnings: [], summary: { scenes: 1, totalFrames: 30, durationSeconds: 1, engines: ['html'] } }) }] }] } }),
    ];
    const f = buildFixture(lines, { prompt: `use key ${KEY}`, llm: { reply: 'link ?expires=1&sig=abcdefghijklmnopqrstuv', model: 'm' }, probe: {} });
    assert.equal(f.tools[0].name, 'validate_project');
    assert.match(f.tools[0].result, /ok: true/);
    assert.equal(f.tools[0].seconds, 1);
    assert.ok(!f.prompt.includes(KEY));
    assert.ok(!f.reply.includes('abcdefghijklmnop'));
  });
  it('cleans terminal output and masks what it shows', () => {
    assert.equal(cleanOutput('\x1b[32mok\x1b[0m\nprogress 10%\rprogress 100%\n'), 'ok\nprogress 100%');
    const html = terminalPage({ title: 't', blocks: [{ cmd: 'echo $REELFORGE_KEY', output: `rf_${'z'.repeat(30)} <b>` }] });
    assert.ok(!html.includes('zzzzzzzzzz'));
    assert.ok(html.includes('&lt;b&gt;'));
  });
});

describe('generated docs pages', () => {
  const manifest = {
    images: {
      'store--dev--pricing--390--light--fold': { group: 'store', site: 'dev', slug: 'pricing', width: 390, theme: 'light', crop: 'fold', route: '/pricing', title: 'Pricing', url: 'https://cdn/p-390-l-fold.webp', capturedOn: '2026-11-22' },
      'store--dev--pricing--390--light--full': { group: 'store', site: 'dev', slug: 'pricing', width: 390, theme: 'light', crop: 'full', route: '/pricing', title: 'Pricing', url: 'https://cdn/p-390-l-full.webp' },
      'store--dev--docs--390--light--fold': { group: 'store', site: 'dev', slug: 'docs', width: 390, theme: 'light', crop: 'fold', route: '/docs', title: 'Docs', note: 'docs content not loaded (#93)', status: 200 },
      'walkthrough--agents--poster': { url: 'https://cdn/poster.webp' },
    },
    videos: {
      agents: { slug: 'agents', title: 'Connect', proves: 'It works.', steps: [{ text: 'Open /agents' }], files: { mp4: { name: 'agents.1234abcd.mp4', bytes: 900000 }, webm: { name: 'agents.1234abcd.webm', bytes: 700000 } }, width: 1280, height: 720, duration: 21.4, posterKey: 'walkthrough--agents--poster' },
    },
  };
  it('lays out every page with fold thumbnails linking to the full page, and lists empty states', () => {
    const md = renderStorePage(manifest);
    assert.ok(md.includes('[![Pricing, light, 390 px](https://cdn/p-390-l-fold.webp)](https://cdn/p-390-l-full.webp)'));
    assert.ok(md.includes('- `/docs`: docs content not loaded (#93)'));
    assert.ok(md.includes('Captured 2026-11-22'));
    assert.ok(md.indexOf('(`/pricing`)') < md.indexOf('(`/docs`)'), 'routes in the site order');
  });
  it('links each video with its poster, size and steps', () => {
    const md = renderWalkthroughsPage(manifest);
    assert.ok(md.includes('[![Connect: poster](https://cdn/poster.webp)](https://reelforge.buildbase.app/walkthroughs/agents.1234abcd.mp4)'));
    assert.ok(md.includes('1. Open /agents'));
    assert.ok(md.includes('Docs navigation: recorded once'));
  });
});
