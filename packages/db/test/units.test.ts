import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, PROVIDERS, checksum, defaultDatabaseUrl, parseDatabaseUrl, redactDatabaseUrl, renderSchema, resolveDatabaseUrl, splitStatements } from '../src/index';

const root = new URL('..', import.meta.url).pathname;

describe('DATABASE_URL', () => {
  it('picks the database from the scheme', () => {
    expect(parseDatabaseUrl('file:/data/reelforge.db')).toEqual({ kind: 'sqlite', file: '/data/reelforge.db' });
    expect(parseDatabaseUrl('file:///data/x.db')).toEqual({ kind: 'sqlite', file: '/data/x.db' });
    expect(parseDatabaseUrl('file:./rel.db').file).toBe(join(process.cwd(), 'rel.db'));
    expect(parseDatabaseUrl('postgresql://u:p@db:5432/rf?schema=studio&connection_limit=5&sslmode=require')).toEqual({
      kind: 'postgresql',
      driverUrl: 'postgresql://u:p@db:5432/rf?sslmode=require',
      schema: 'studio',
      connectionLimit: 5,
    });
    expect(parseDatabaseUrl('postgres://u@db/rf').kind).toBe('postgresql');
    expect(parseDatabaseUrl('mysql://u:p@db:3306/rf').kind).toBe('mysql');
    expect(parseDatabaseUrl('mariadb://u:p@db:3306/rf').kind).toBe('mysql');
  });

  it('explains what is not supported', () => {
    expect(() => parseDatabaseUrl('mongodb://db/rf')).toThrow(/MongoDB is not supported yet: Prisma 7/);
    expect(() => parseDatabaseUrl('sqlserver://db')).toThrow(/not supported/);
    expect(() => parseDatabaseUrl('mysql://u:p@db:3306')).toThrow(/database name/);
    expect(() => parseDatabaseUrl('postgresql://db/rf?schema=a;drop')).toThrow(/identifier/);
    expect(() => parseDatabaseUrl('postgresql://db/rf?connection_limit=0')).toThrow(/positive/);
  });

  it('defaults to SQLite on the data volume and reads DATABASE_URL_FILE', () => {
    expect(resolveDatabaseUrl({}, '/data')).toBe('file:/data/reelforge.db');
    expect(defaultDatabaseUrl('/srv/rf')).toBe('file:/srv/rf/reelforge.db');
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgresql://a/b' }, '/data')).toBe('postgresql://a/b');
    const dir = mkdtempSync(join(tmpdir(), 'rf-url-'));
    try {
      writeFileSync(join(dir, 'url'), 'mysql://u:secret@db/rf\n');
      expect(resolveDatabaseUrl({ DATABASE_URL_FILE: join(dir, 'url') }, '/data')).toBe('mysql://u:secret@db/rf');
      expect(() => resolveDatabaseUrl({ DATABASE_URL_FILE: join(dir, 'missing') }, '/data')).toThrow(/DATABASE_URL_FILE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never shows the password', () => {
    expect(redactDatabaseUrl('postgresql://u:hunter2@db/rf')).toBe('postgresql://u:***@db/rf');
    expect(redactDatabaseUrl('mysql://u@db/rf?password=x')).not.toContain('=x');
    expect(redactDatabaseUrl('file:/data/reelforge.db')).toBe('file:/data/reelforge.db');
  });
});

describe('migration scripts', () => {
  it('splits statements on ; outside quotes and comments', () => {
    expect(splitStatements(`-- c;\nCREATE TABLE "a;b" (x TEXT DEFAULT 'it''s; fine');\n/* ; */ INSERT INTO t VALUES (\`q;\`);\n\n`)).toEqual([
      `CREATE TABLE "a;b" (x TEXT DEFAULT 'it''s; fine')`,
      'INSERT INTO t VALUES (`q;`)',
    ]);
  });

  it('checksums ignore line-ending style', () => {
    expect(checksum('a;\r\nb;')).toBe(checksum('a;\nb;'));
  });
});

describe('generated files are up to date (else: pnpm --filter @reelforge/db generate / migration)', () => {
  it('per-provider schemas match prisma/base.prisma', () => {
    const base = readFileSync(join(root, 'prisma/base.prisma'), 'utf8');
    for (const p of PROVIDERS) expect(readFileSync(join(root, 'prisma', p, 'schema.prisma'), 'utf8')).toBe(renderSchema(base, p));
  });

  it('every provider has the same migrations, embedded in src/generated/migrations.ts', () => {
    const ids = PROVIDERS.map((p) => readdirSync(join(root, 'migrations', p)).filter((d) => /^\d{4}_/.test(d)).sort());
    for (const list of ids) expect(list).toEqual(ids[0]);
    for (const p of PROVIDERS) {
      expect(MIGRATIONS[p]!.map((m) => m.id)).toEqual(ids[0]);
      for (const m of MIGRATIONS[p]!) expect(m.sql).toBe(readFileSync(join(root, 'migrations', p, m.id, 'migration.sql'), 'utf8'));
    }
  });
});
