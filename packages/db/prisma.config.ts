/**
 * Prisma tooling config (generate, migrate diff). The app never reads it: it
 * picks the provider from DATABASE_URL at runtime (src/database.ts). A plain
 * object, so the CLI can run with `pnpm dlx` without being installed here.
 *
 *   PRISMA_PROVIDER=sqlite|postgresql|mysql  which generated schema to use
 *   PRISMA_TOOLING_URL                       only for commands that connect
 */
const provider = process.env.PRISMA_PROVIDER ?? 'sqlite';
const placeholder: Record<string, string> = {
  sqlite: 'file:./tooling.db',
  postgresql: 'postgresql://tooling:tooling@127.0.0.1:5432/tooling',
  mysql: 'mysql://tooling:tooling@127.0.0.1:3306/tooling',
};

export default {
  schema: `prisma/${provider}/schema.prisma`,
  datasource: { url: process.env.PRISMA_TOOLING_URL ?? placeholder[provider]! },
};
