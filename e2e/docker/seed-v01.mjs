// Writes a v0.1 data directory (the filesystem layout before the database) into
// /data, so the e2e can check the one-time import: a project with two versions,
// a theme, and the admin key the rest of the e2e uses (stored as a salted hash).
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const key = process.env.KEY;
const sample = JSON.parse(readFileSync(process.env.SAMPLE ?? 'sample-reel.json', 'utf8'));
const createdAt = '2026-11-01T09:00:00.000Z', updatedAt = '2026-11-01T09:30:00.000Z';
const v1 = { ...sample, projectId: 'legacy-v01', title: 'Made by v0.1' };
const v2 = { ...v1, title: 'Made by v0.1, edited' };
const p = '/data/projects/legacy-v01';
mkdirSync(`${p}/versions`, { recursive: true });
mkdirSync(`${p}/assets`, { recursive: true });
writeFileSync(`${p}/versions/000001.json`, JSON.stringify(v1));
writeFileSync(`${p}/versions/000002.json`, JSON.stringify(v2));
writeFileSync(`${p}/project.json`, JSON.stringify(v2));
writeFileSync(`${p}/meta.json`, JSON.stringify({ id: 'legacy-v01', version: 2, createdAt, updatedAt }));
const salt = randomBytes(16).toString('hex');
writeFileSync('/data/keys.json', JSON.stringify([{ id: 'key_v01admin', name: 'v01-admin', scopes: ['admin'], prefix: key.slice(0, 7), salt, hash: createHash('sha256').update(salt).update(key).digest('hex'), createdAt }]));
mkdirSync('/data/themes', { recursive: true });
writeFileSync('/data/themes/legacy-theme.json', JSON.stringify({ id: 'legacy-theme', name: 'Legacy', tokens: {} }));
// v0.1 kept provider keys in plain text (secrets.json); the server must encrypt them once RENDERWELD_SECRET_KEY is set.
if (process.env.PLAIN_V01) writeFileSync('/data/secrets.json', JSON.stringify({ ELEVENLABS_API_KEY: process.env.PLAIN_V01 }), { mode: 0o600 });
console.log('✔ seeded a v0.1 data directory (project legacy-v01 with 2 versions, theme, admin key, plaintext provider key)');
