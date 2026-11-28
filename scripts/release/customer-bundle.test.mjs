import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stampCompose, writeBundle, FILES } from './customer-bundle.mjs';

test('writes the three customer files with the image pinned to one version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-test-'));
  try {
    const paths = writeBundle(dir, 'ghcr.io/buildbase-app/renderweld', '1.0.0');
    assert.deepEqual(paths.map((p) => p.slice(dir.length + 1)), FILES);
    const compose = readFileSync(join(dir, 'docker-compose.yml'), 'utf8');
    assert.match(compose, /^\s+image: ghcr\.io\/buildbase-app\/renderweld:1\.0\.0$/m);
    assert.doesNotMatch(compose, /@@|build:|LICEN[CS]E_MODE|EDITION/);
    // Listens on this machine only, with the hardening the docs describe.
    assert.match(compose, /"127\.0\.0\.1:\$\{RENDERWELD_PORT:-4321\}:4321"/);
    for (const s of ['read_only: true', 'cap_drop: [ALL]', 'no-new-privileges:true', 'seccomp=./chrome.json', 'RENDERWELD_LICENCE_KEY: ${RENDERWELD_LICENCE_KEY:-}'])
      assert.ok(compose.includes(s), s);
    const env = readFileSync(join(dir, '.env.example'), 'utf8');
    assert.match(env, /^RENDERWELD_LICENCE_KEY=$/m);
    assert.doesNotMatch(env, /^RENDERWELD_SECRET_KEY=|LICEN[CS]E_MODE|rf_[0-9a-f]{8}/m);
    JSON.parse(readFileSync(join(dir, 'chrome.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses anything but a plain image name and version', () => {
  const t = 'image: @@IMAGE@@';
  assert.equal(stampCompose(t, 'ghcr.io/a/b', '2.1.0-rc.1'), 'image: ghcr.io/a/b:2.1.0-rc.1');
  assert.throws(() => stampCompose(t, 'ghcr.io/a/b', 'latest'));
  assert.throws(() => stampCompose(t, 'ghcr.io/a/b; rm -rf /', '1.0.0'));
  assert.throws(() => stampCompose('image: x', 'ghcr.io/a/b', '1.0.0'));
});
