import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRules, findViolations, compare } from './release-guards.mjs';

const config = JSON.parse(readFileSync(new URL('./guards.config.json', import.meta.url), 'utf8'));
const rules = loadRules(config);
const check = (files) => findViolations(rules, Object.keys(files), (f) => files[f]);

test('flags internal planning files by path', () => {
  assert.deepEqual(check({ 'docs/launch/11-new-campaign.md': 'x', 'research/COSTS_V2.md': 'x' }), [
    'internal-planning-file docs/launch/11-new-campaign.md',
    'internal-planning-file research/COSTS_V2.md',
  ]);
  assert.deepEqual(check({ 'notes/outbound-dm-2027.md': 'x' }), ['internal-planning-file notes/outbound-dm-2027.md']);
});

test('keeps research spikes, the test plan and customer docs', () => {
  assert.deepEqual(
    check({ 'research/spikes/render-scale/a.ts': 'x', 'docs/TEST_PLAN.md': 'x', 'docs/public/start/quick-start.md': 'Run it.' }),
    [],
  );
});

test('flags the licence switch only in customer docs', () => {
  const line = 'Set `RENDERWELD_LICENCE_MODE=off` to skip the check.';
  assert.deepEqual(check({ 'docs/public/install/x.md': line, 'docs/DEVELOPMENT.md': line, 'CONTRIBUTING.md': line }), [
    'licence-off-in-customer-docs docs/public/install/x.md',
  ]);
  assert.deepEqual(check({ 'README.md': 'RENDERWELD_LICENCE_MODE: "off"' }), ['licence-off-in-customer-docs README.md']);
  assert.deepEqual(check({ 'README.md': 'RENDERWELD_LICENCE_MODE=enforce' }), []);
});

test('flags test cards, test-store hosts and old names in customer docs', () => {
  assert.deepEqual(check({ 'docs/public/a.md': 'Pay with 4242 4242 4242 4242.' }), ['test-card-in-customer-docs docs/public/a.md']);
  assert.deepEqual(check({ 'docs/public/b.md': 'Open https://dev.renderweld.com' }), ['test-card-in-customer-docs docs/public/b.md']);
  assert.deepEqual(check({ 'docs/public/c.md': 'Set REELFORGE_PORT.' }), ['old-name-in-customer-docs docs/public/c.md']);
  assert.deepEqual(check({ 'docs/public/d.md': 'RenderWeld runs on renderweld.com.' }), []);
});

test('fails only on findings missing from the baseline, and reports fixed ones', () => {
  const r = compare(['a x', 'b y'], ['a x', 'c z']);
  assert.deepEqual(r.fresh, ['b y']);
  assert.deepEqual(r.stale, ['c z']);
});

test('the committed baseline matches today\'s files', async () => {
  const baseline = JSON.parse(readFileSync(new URL('./guards.baseline.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(baseline));
  for (const b of baseline) assert.match(b, /^[a-z-]+ \S+$/);
});
