#!/usr/bin/env node
// Builds renderweld.zip, the customer download: docker-compose.yml pointing at
// one released image, chrome.json (the seccomp profile) and .env.example.
//
//   node scripts/release/customer-bundle.mjs --image ghcr.io/OWNER/REPO --version 1.0.0 [--out dist]
//
// The release job runs it for each v* tag and attaches the zip to the release.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const FILES = ['docker-compose.yml', 'chrome.json', '.env.example'];

/** The compose file for one image reference; refuses anything but a plain image name and version. */
export function stampCompose(template, image, version) {
  if (!/^[a-z0-9][a-z0-9._/-]*[a-z0-9]$/.test(image)) throw new Error(`not an image name: ${image}`);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`not a version: ${version}`);
  if (!template.includes('@@IMAGE@@')) throw new Error('the compose template has no @@IMAGE@@');
  return template.replaceAll('@@IMAGE@@', `${image}:${version}`);
}

/** Writes the three files into dir. */
export function writeBundle(dir, image, version) {
  mkdirSync(dir, { recursive: true });
  const compose = readFileSync(join(root, 'deployment/customer/docker-compose.yml'), 'utf8');
  writeFileSync(join(dir, 'docker-compose.yml'), stampCompose(compose, image, version));
  copyFileSync(join(root, 'deployment/seccomp/chrome.json'), join(dir, 'chrome.json'));
  copyFileSync(join(root, 'deployment/customer/env.example'), join(dir, '.env.example'));
  return FILES.map((f) => join(dir, f));
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

function main() {
  const image = arg('image');
  const version = arg('version').replace(/^v/, '');
  const out = resolve(arg('out', 'dist'));
  const work = mkdtempSync(join(tmpdir(), 'renderweld-bundle-'));
  try {
    writeBundle(work, image, version);
    mkdirSync(out, { recursive: true });
    const zip = join(out, 'renderweld.zip');
    rmSync(zip, { force: true });
    execFileSync('zip', ['-q', '-X', zip, ...FILES], { cwd: work });
    console.log(`${zip}: ${FILES.join(', ')} for ${image}:${version}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
