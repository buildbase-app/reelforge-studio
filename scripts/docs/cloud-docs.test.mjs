// Checks the deployment and provider docs against the code, so they cannot
// drift (issues #288, #290). Run: pnpm test:docs (node --test, no dependencies).
//
// - every REELFORGE_* variable and every dotted setting key the pages name
//   exists in docs/CONFIG.md (which `pnpm docs:config --check` keeps equal to
//   packages/core/src/config/schema.ts);
// - every JSON block (IAM policies, role definitions, task definitions) parses;
// - every relative link points at a file (and heading) that exists;
// - docs/PROVIDERS.md names every option of the driver settings, every engine,
//   media provider, render backend, notification channel and email provider in
//   the code;
// - runtime settings are reachable over REST and MCP: GET/PATCH /v1/config map
//   to get_config/update_config, and CONFIG.md marks every setting's scope.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

/** The pages this test owns. */
const PAGES = [
  ...readdirSync(join(root, 'docs/cloud'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/cloud/${f}`),
  'docs/PROVIDERS.md',
  'docs/HOW_IT_WORKS.md',
  'docs/ISOLATION.md',
];

/** REELFORGE_* names that are not settings: build arguments, compose variables, CLI input, test switches. */
const NOT_SETTINGS = new Set([
  'REELFORGE_CONFIG',
  'REELFORGE_EDITION',
  'REELFORGE_IMAGE',
  'REELFORGE_DOMAIN',
  'REELFORGE_LICENCE_KEY_INPUT',
  'REELFORGE_REQUIRE_BROWSER',
  'REELFORGE_TEST_DB',
]);

/** Dotted names that look like settings but are events or manifest fields. */
const NOT_KEYS = new Set(['render.ready', 'render.backend', 'audit.entry', 'licence.state_changed', 'webhooks.mjs']);

/** Settings from docs/CONFIG.md: key -> { scope, type, envs }. */
function configTable() {
  const settings = new Map();
  for (const line of read('docs/CONFIG.md').split('\n')) {
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    const key = cells[1]?.match(/^`([a-zA-Z0-9.]+)`$/)?.[1];
    if (!key) continue;
    const envs = [...cells[2].matchAll(/`([A-Z0-9_]+)`/g)].map((m) => m[1]);
    settings.set(key, { type: cells[3], scope: cells[5], envs });
  }
  return settings;
}

/** GitHub's heading anchors of a Markdown file. */
function anchors(markdown) {
  const out = new Set();
  for (const [, h] of markdown.matchAll(/^#{1,6} (.+)$/gm)) {
    out.add(h.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-'));
  }
  return out;
}

const SETTINGS = configTable();
const ENVS = new Set([...SETTINGS.values()].flatMap((s) => s.envs));
const GROUPS = new Set([...SETTINGS.keys()].map((k) => k.split('.')[0]));

describe('cloud and provider docs match the code', () => {
  it('reads docs/CONFIG.md', () => {
    assert.ok(SETTINGS.size > 100, `only ${SETTINGS.size} settings parsed from docs/CONFIG.md`);
    for (const [key, s] of SETTINGS) assert.match(s.scope, /^(startup|runtime)$/, `${key} has no scope in docs/CONFIG.md`);
  });

  for (const page of PAGES) {
    const text = read(page);

    it(`${page}: every REELFORGE_* variable is a setting`, () => {
      const unknown = new Set();
      for (const [name] of text.matchAll(/\bREELFORGE_[A-Z0-9_]*[A-Z0-9]\b/g)) {
        const base = name.replace(/_FILE$/, '');
        if (!ENVS.has(base) && !NOT_SETTINGS.has(name)) unknown.add(name);
      }
      assert.deepEqual([...unknown], [], `not in docs/CONFIG.md (typo, or a setting that does not exist): ${[...unknown].join(', ')}`);
    });

    it(`${page}: every setting key exists`, () => {
      const unknown = new Set();
      for (const [, token] of text.matchAll(/`([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9*]+)+)`/g)) {
        const group = token.split('.')[0];
        if (!GROUPS.has(group) || NOT_KEYS.has(token) || /\.(md|ya?ml|json|ts|mjs|com|io|net|app|dev|org)$/.test(token)) continue;
        const ok = token.endsWith('.*')
          ? [...SETTINGS.keys()].some((k) => k.startsWith(token.slice(0, -1)))
          : SETTINGS.has(token) || [...SETTINGS.keys()].some((k) => k.startsWith(`${token}.`));
        if (!ok) unknown.add(token);
      }
      assert.deepEqual([...unknown], [], `not a setting or group in docs/CONFIG.md: ${[...unknown].join(', ')}`);
    });

    it(`${page}: every JSON block parses`, () => {
      for (const [, body] of text.matchAll(/```json\n([\s\S]*?)```/g)) {
        // A block of several one-line JSON objects (tool calls) is checked line by line.
        const docs = body.trim().startsWith('{ "tool"') ? body.trim().split('\n') : [body];
        for (const d of docs) assert.doesNotThrow(() => JSON.parse(d), `invalid JSON in ${page}:\n${d.slice(0, 200)}`);
      }
    });

    it(`${page}: relative links and their anchors resolve`, () => {
      const missing = [];
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [path, anchor] = target.split('#');
        const file = path ? normalize(join(dirname(page), path)) : page;
        if (!existsSync(join(root, file))) missing.push(target);
        else if (anchor && file.endsWith('.md') && !anchors(read(file)).has(anchor)) missing.push(target);
      }
      assert.deepEqual(missing, [], `broken links in ${page}`);
    });
  }

  it('docs/PROVIDERS.md names every driver option, plugin, channel and email provider', () => {
    const providers = read('docs/PROVIDERS.md');
    const named = (id) => providers.includes(`\`${id}\``);
    const missing = [];
    const enumKeys = [
      'server.role',
      'queue.driver',
      'queue.dispatch',
      'limits.rateLimitStore',
      'storage.driver',
      'storage.downloads',
      'render.fanOut',
      'observability.logs.exporter',
      'observability.metrics.exporter',
      'observability.tracing.exporter',
      'observability.otlp.protocol',
    ];
    for (const key of enumKeys) {
      const s = SETTINGS.get(key);
      assert.ok(s, `${key} is not in docs/CONFIG.md`);
      for (const [, opt] of s.type.matchAll(/`([^`]+)`/g)) if (!named(opt)) missing.push(`${key}: ${opt}`);
    }
    const listed = (path, name) => {
      const m = read(path).match(new RegExp(`export const ${name} = \\[([^\\]]+)\\]`));
      assert.ok(m, `${name} not found in ${path}`);
      return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };
    for (const id of listed('packages/project-schema/src/templates.ts', 'ENGINES')) if (!named(id)) missing.push(`engine: ${id}`);
    for (const id of listed('packages/core/src/webhooks/types.ts', 'CHANNEL_TYPES')) if (!named(id)) missing.push(`channel: ${id}`);
    for (const id of listed('packages/core/src/webhooks/types.ts', 'EMAIL_PROVIDERS')) if (!named(id)) missing.push(`email provider: ${id}`);
    for (const dir of ['packages/core/src/providers', 'packages/core/src/backends']) {
      for (const f of readdirSync(join(root, dir)).filter((x) => x.endsWith('.ts'))) {
        const id = read(`${dir}/${f}`).match(/readonly id = '([^']+)'/)?.[1];
        if (id && !named(id)) missing.push(`${dir}: ${id}`);
      }
    }
    assert.deepEqual(missing, [], 'add these to docs/PROVIDERS.md (how to select it, settings, status)');
  });

  it('runtime settings are settable over REST and MCP', () => {
    const routes = read('apps/server/src/routes.ts');
    assert.match(routes, /method: 'GET', path: '\/v1\/config', scope: 'owner', tool: 'get_config'/);
    assert.match(routes, /method: 'PATCH', path: '\/v1\/config', scope: 'owner', tool: 'update_config'/);
    const mcp = read('apps/server/src/mcp.ts');
    assert.match(mcp, /name: 'get_config'/);
    assert.match(mcp, /name: 'update_config'/);
    const runtime = [...SETTINGS.values()].filter((s) => s.scope === 'runtime').length;
    assert.ok(runtime > 0, 'no runtime settings in docs/CONFIG.md');
  });
});
