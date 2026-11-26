/** Turns prisma/base.prisma into one schema per provider (see the header of base.prisma). */
export const PROVIDERS = ['sqlite', 'postgresql', 'mysql'] as const;
export type Provider = (typeof PROVIDERS)[number];

const TYPES: Record<Provider, Record<'TEXT' | 'LONGTEXT' | 'ID', string>> = {
  sqlite: { TEXT: '', LONGTEXT: '', ID: '' },
  postgresql: { TEXT: '', LONGTEXT: '', ID: '' },
  mysql: { TEXT: '@db.Text', LONGTEXT: '@db.LongText', ID: '@db.VarChar(191)' },
};

export function renderSchema(base: string, provider: Provider): string {
  const body = base
    .replaceAll('@@PROVIDER@@', provider)
    .replace(/@@(TEXT|LONGTEXT|ID)@@/g, (_, t: 'TEXT' | 'LONGTEXT' | 'ID') => TYPES[provider][t])
    // Tidy the whitespace a removed placeholder leaves behind.
    .replace(/[ \t]+$/gm, '');
  const header = `// GENERATED from prisma/base.prisma for ${provider}. Do not edit; run \`pnpm --filter @renderweld/db schemas\`.\n`;
  return header + body.replace(/^(\/\/.*\n)+\n/, '');
}
