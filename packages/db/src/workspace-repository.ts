import type { WorkspaceLimits, WorkspaceRecord, WorkspaceRepository, WorkspaceStatus } from '@reelforge/core';
import type { PrismaClient } from './generated/sqlite/client';

/** Prisma unique-constraint violation (P2002). */
const isUnique = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

type Row = {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
  updatedAt: Date | null;
  suspendedAt: Date | null;
  deletedAt: Date | null;
  purgeAfter: Date | null;
  limits: string | null;
};

function toWorkspace(r: Row): WorkspaceRecord {
  const opt = (k: string, d: Date | null) => (d ? { [k]: d.toISOString() } : {});
  return {
    id: r.id,
    name: r.name,
    status: r.status as WorkspaceStatus,
    createdAt: r.createdAt.toISOString(),
    ...opt('updatedAt', r.updatedAt),
    ...opt('suspendedAt', r.suspendedAt),
    ...opt('deletedAt', r.deletedAt),
    ...opt('purgeAfter', r.purgeAfter),
    ...(r.limits ? { limits: JSON.parse(r.limits) as WorkspaceLimits } : {}),
  };
}

const date = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v));

/**
 * The install's workspaces (#304): instance-level, so every bound bundle shares it. A purge deletes the Workspace
 * row; every table's foreign key cascades, so the workspace's projects, versions, jobs and their events, keys,
 * themes, assets, audit entries, idempotency keys, webhooks and deliveries go with it in one statement.
 */
export function createPrismaWorkspaceRepository(prisma: PrismaClient): WorkspaceRepository {
  return {
    async list() {
      return (await prisma.workspace.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(toWorkspace);
    },
    async get(id) {
      const r = await prisma.workspace.findUnique({ where: { id } });
      return r ? toWorkspace(r) : null;
    },
    async create(w) {
      try {
        await prisma.workspace.create({
          data: { id: w.id, name: w.name, status: w.status, createdAt: new Date(w.createdAt), updatedAt: date(w.updatedAt) ?? null, limits: w.limits ? JSON.stringify(w.limits) : null },
        });
        return true;
      } catch (e) {
        if (isUnique(e)) return false;
        throw e;
      }
    },
    async update(id, patch) {
      const data = {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.suspendedAt !== undefined ? { suspendedAt: date(patch.suspendedAt) } : {}),
        ...(patch.deletedAt !== undefined ? { deletedAt: date(patch.deletedAt) } : {}),
        ...(patch.purgeAfter !== undefined ? { purgeAfter: date(patch.purgeAfter) } : {}),
        ...(patch.limits !== undefined ? { limits: patch.limits === null ? null : JSON.stringify(patch.limits) } : {}),
        updatedAt: new Date(patch.updatedAt),
      };
      const r = await prisma.workspace.updateMany({ where: { id }, data });
      if (!r.count) return null;
      return toWorkspace((await prisma.workspace.findUniqueOrThrow({ where: { id } })) as Row);
    },
    async purge(id) {
      return (await prisma.workspace.deleteMany({ where: { id } })).count > 0;
    },
  };
}
