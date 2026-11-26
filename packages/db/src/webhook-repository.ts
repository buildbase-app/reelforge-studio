import { conflict, type DeliveryStatus, type WebhookAttemptRecord, type WebhookDeliveryRecord, type WebhookEndpointRecord, type WebhookRepository } from '@renderweld/core';
import type { PrismaClient } from './generated/sqlite/client';

const iso = (d: Date) => d.toISOString();
const TX = { maxWait: 10_000, timeout: 30_000 };
const isUnique = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

type EndpointRow = Awaited<ReturnType<PrismaClient['webhookEndpoint']['findFirstOrThrow']>>;
type DeliveryRow = Awaited<ReturnType<PrismaClient['webhookDelivery']['findFirstOrThrow']>>;
type AttemptRow = Awaited<ReturnType<PrismaClient['webhookAttempt']['findFirstOrThrow']>>;

function toEndpoint(r: EndpointRow): WebhookEndpointRecord {
  return {
    id: r.id,
    name: r.name,
    ...(r.description !== null ? { description: r.description } : {}),
    type: r.type as WebhookEndpointRecord['type'],
    ...(r.url !== null ? { url: { value: r.url, scheme: r.urlScheme ?? 'plain' } } : {}),
    ...(r.urlDisplay !== null ? { urlDisplay: r.urlDisplay } : {}),
    ...(r.email !== null ? { email: JSON.parse(r.email) } : {}),
    events: JSON.parse(r.events),
    enabled: r.enabled,
    ...(r.disabledReason !== null ? { disabledReason: r.disabledReason } : {}),
    ...(r.secret !== null ? { secret: { value: r.secret, scheme: r.secretScheme ?? 'plain' } } : {}),
    ...(r.prevSecret !== null ? { prevSecret: { value: r.prevSecret, scheme: r.prevSecretScheme ?? 'plain' } } : {}),
    ...(r.prevSecretExpiresAt !== null ? { prevSecretExpiresAt: iso(r.prevSecretExpiresAt) } : {}),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    ...(r.createdBy !== null ? { createdBy: r.createdBy } : {}),
  };
}

function toDelivery(r: DeliveryRow): WebhookDeliveryRecord {
  return {
    id: r.id,
    endpointId: r.endpointId,
    messageId: r.messageId,
    eventId: r.eventId,
    eventType: r.eventType,
    ...(r.dedupeKey !== null ? { dedupeKey: r.dedupeKey } : {}),
    payload: JSON.parse(r.payload),
    status: r.status as DeliveryStatus,
    attempts: r.attempts,
    nextAttemptAt: iso(r.nextAttemptAt),
    ...(r.lockedUntil !== null ? { lockedUntil: iso(r.lockedUntil) } : {}),
    ...(r.lastStatus !== null ? { lastStatus: r.lastStatus } : {}),
    ...(r.lastError !== null ? { lastError: r.lastError } : {}),
    ...(r.deliveredAt !== null ? { deliveredAt: iso(r.deliveredAt) } : {}),
    ...(r.replayOf !== null ? { replayOf: r.replayOf } : {}),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

function toAttempt(r: AttemptRow): WebhookAttemptRecord {
  return {
    id: r.id,
    deliveryId: r.deliveryId,
    endpointId: r.endpointId,
    attempt: r.attempt,
    at: iso(r.at),
    durationMs: r.durationMs,
    ...(r.status !== null ? { status: r.status } : {}),
    ...(r.error !== null ? { error: r.error } : {}),
    outcome: r.outcome as WebhookAttemptRecord['outcome'],
  };
}

/** Endpoints, outbox and delivery log on any Prisma database (#66). */
export function createPrismaWebhookRepository(prisma: PrismaClient, workspaceId: string): WebhookRepository {
  const ws = { workspaceId };
  return {
    async listEndpoints() {
      return (await prisma.webhookEndpoint.findMany({ where: ws, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(toEndpoint);
    },
    async getEndpoint(id) {
      const r = await prisma.webhookEndpoint.findFirst({ where: { ...ws, id } });
      return r ? toEndpoint(r) : null;
    },
    async insertEndpoint(e) {
      try {
        await prisma.webhookEndpoint.create({
          data: {
            ...ws,
            id: e.id,
            name: e.name,
            description: e.description ?? null,
            type: e.type,
            url: e.url?.value ?? null,
            urlScheme: e.url?.scheme ?? null,
            urlDisplay: e.urlDisplay ?? null,
            email: e.email ? JSON.stringify(e.email) : null,
            events: JSON.stringify(e.events),
            enabled: e.enabled,
            disabledReason: e.disabledReason ?? null,
            secret: e.secret?.value ?? null,
            secretScheme: e.secret?.scheme ?? null,
            prevSecret: e.prevSecret?.value ?? null,
            prevSecretScheme: e.prevSecret?.scheme ?? null,
            prevSecretExpiresAt: e.prevSecretExpiresAt ? new Date(e.prevSecretExpiresAt) : null,
            createdAt: new Date(e.createdAt),
            updatedAt: new Date(e.updatedAt),
            createdBy: e.createdBy ?? null,
          },
        });
      } catch (err) {
        if (isUnique(err)) throw conflict(`webhook ${e.id} exists`);
        throw err;
      }
    },
    async updateEndpoint(id, p) {
      const data: Record<string, unknown> = { updatedAt: new Date(p.updatedAt) };
      if (p.name !== undefined) data.name = p.name;
      if (p.description !== undefined) data.description = p.description;
      if (p.url !== undefined) (data.url = p.url.value), (data.urlScheme = p.url.scheme);
      if (p.urlDisplay !== undefined) data.urlDisplay = p.urlDisplay;
      if (p.email !== undefined) data.email = JSON.stringify(p.email);
      if (p.events !== undefined) data.events = JSON.stringify(p.events);
      if (p.enabled !== undefined) data.enabled = p.enabled;
      if (p.disabledReason !== undefined) data.disabledReason = p.disabledReason;
      if (p.secret !== undefined) (data.secret = p.secret.value), (data.secretScheme = p.secret.scheme);
      if (p.prevSecret !== undefined) (data.prevSecret = p.prevSecret?.value ?? null), (data.prevSecretScheme = p.prevSecret?.scheme ?? null);
      if (p.prevSecretExpiresAt !== undefined) data.prevSecretExpiresAt = p.prevSecretExpiresAt ? new Date(p.prevSecretExpiresAt) : null;
      const n = await prisma.webhookEndpoint.updateMany({ where: { ...ws, id }, data });
      if (!n.count) return null;
      return toEndpoint(await prisma.webhookEndpoint.findFirstOrThrow({ where: { ...ws, id } }));
    },
    async deleteEndpoint(id) {
      return (await prisma.webhookEndpoint.deleteMany({ where: { ...ws, id } })).count > 0;
    },

    async enqueue(rows) {
      if (!rows.length) return;
      try {
        await prisma.webhookDelivery.createMany({
          data: rows.map((d) => ({
            ...ws,
            id: d.id,
            endpointId: d.endpointId,
            messageId: d.messageId,
            eventId: d.eventId,
            eventType: d.eventType,
            dedupeKey: d.dedupeKey ?? null,
            payload: JSON.stringify(d.payload),
            status: d.status,
            attempts: d.attempts,
            nextAttemptAt: new Date(d.nextAttemptAt),
            lockedUntil: d.lockedUntil ? new Date(d.lockedUntil) : null,
            replayOf: d.replayOf ?? null,
            createdAt: new Date(d.createdAt),
            updatedAt: new Date(d.updatedAt),
          })),
        });
      } catch (err) {
        if (isUnique(err)) throw conflict('a delivery with this id exists');
        throw err;
      }
    },
    async getDelivery(id) {
      const r = await prisma.webhookDelivery.findFirst({ where: { ...ws, id } });
      return r ? toDelivery(r) : null;
    },
    async listDeliveries(f = {}) {
      const rows = await prisma.webhookDelivery.findMany({
        where: {
          ...ws,
          ...(f.endpointId ? { endpointId: f.endpointId } : {}),
          ...(f.status ? { status: f.status } : {}),
          ...(f.eventType ? { eventType: f.eventType } : {}),
          ...(f.eventId ? { eventId: f.eventId } : {}),
          ...(f.dedupeKey ? { dedupeKey: f.dedupeKey } : {}),
          ...(f.before ? { id: { lt: f.before } } : {}),
        },
        orderBy: { id: 'desc' },
        take: f.limit ?? 50,
      });
      return rows.map(toDelivery);
    },
    async claim(now, leaseUntil, limit) {
      const at = new Date(now);
      const candidates = await prisma.webhookDelivery.findMany({
        where: { ...ws, OR: [{ status: 'pending', nextAttemptAt: { lte: at } }, { status: 'delivering', lockedUntil: { lt: at } }] },
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
        take: limit,
      });
      const claimed: WebhookDeliveryRecord[] = [];
      for (const c of candidates) {
        // Optimistic claim: only the worker whose conditional update changes the row owns it.
        const n = await prisma.webhookDelivery.updateMany({
          where: { ...ws, id: c.id, status: c.status, ...(c.status === 'delivering' ? { lockedUntil: c.lockedUntil } : {}) },
          data: { status: 'delivering', lockedUntil: new Date(leaseUntil), updatedAt: at },
        });
        if (n.count === 1) claimed.push({ ...toDelivery(c), status: 'delivering', lockedUntil: leaseUntil, updatedAt: now });
      }
      return claimed;
    },
    async recordAttempt(a, p, lease) {
      return prisma.$transaction(
        async (tx) => {
          // The delivery first, fenced by the claim's lease when given: a worker that lost its lease writes nothing.
          const n = await tx.webhookDelivery.updateMany({
            where: { ...ws, id: a.deliveryId, ...(lease !== undefined ? { status: 'delivering', lockedUntil: new Date(lease) } : {}) },
            data: {
              status: p.status,
              attempts: p.attempts,
              updatedAt: new Date(p.updatedAt),
              ...(p.nextAttemptAt ? { nextAttemptAt: new Date(p.nextAttemptAt) } : {}),
              ...(p.lockedUntil === null ? { lockedUntil: null } : {}),
              ...(p.lastStatus !== undefined ? { lastStatus: p.lastStatus } : {}),
              ...(p.lastError !== undefined ? { lastError: p.lastError } : {}),
              ...(p.deliveredAt ? { deliveredAt: new Date(p.deliveredAt) } : {}),
            },
          });
          if (n.count !== 1) return false;
          await tx.webhookAttempt.create({
            data: {
              ...ws,
              id: a.id,
              deliveryId: a.deliveryId,
              endpointId: a.endpointId,
              attempt: a.attempt,
              at: new Date(a.at),
              durationMs: a.durationMs,
              status: a.status ?? null,
              error: a.error ?? null,
              outcome: a.outcome,
            },
          });
          return true;
        },
        TX
      );
    },
    async reschedule(id, at) {
      return (await prisma.webhookDelivery.updateMany({ where: { ...ws, id, status: 'pending' }, data: { nextAttemptAt: new Date(at), updatedAt: new Date(at) } })).count === 1;
    },
    async release(ids, at) {
      if (!ids.length) return;
      await prisma.webhookDelivery.updateMany({ where: { ...ws, id: { in: ids }, status: 'delivering' }, data: { status: 'pending', lockedUntil: null, nextAttemptAt: new Date(at), updatedAt: new Date(at) } });
    },
    async listAttempts(deliveryId) {
      return (await prisma.webhookAttempt.findMany({ where: { ...ws, deliveryId }, orderBy: [{ attempt: 'asc' }, { id: 'asc' }] })).map(toAttempt);
    },
    async abandonPending(endpointId, reason, at) {
      return (await prisma.webhookDelivery.updateMany({ where: { ...ws, endpointId, status: 'pending' }, data: { status: 'dead', lastError: reason, updatedAt: new Date(at) } })).count;
    },
    async deleteFinishedBefore(cutoff) {
      const where = { ...ws, status: { in: ['succeeded', 'dead'] }, updatedAt: { lt: new Date(cutoff) } };
      let total = 0;
      // In pages, so a large backlog never becomes one huge statement.
      for (;;) {
        const ids = (await prisma.webhookDelivery.findMany({ where, select: { id: true }, take: 500 })).map((r) => r.id);
        if (!ids.length) return total;
        await prisma.$transaction(
          async (tx) => {
            await tx.webhookAttempt.deleteMany({ where: { ...ws, deliveryId: { in: ids } } });
            total += (await tx.webhookDelivery.deleteMany({ where: { ...ws, id: { in: ids } } })).count;
          },
          TX
        );
      }
    },
    async countByStatus(endpointId) {
      const out: Record<DeliveryStatus, number> = { pending: 0, delivering: 0, succeeded: 0, dead: 0 };
      const rows = await prisma.webhookDelivery.groupBy({ by: ['status'], where: { ...ws, ...(endpointId ? { endpointId } : {}) }, _count: { _all: true } });
      for (const r of rows) if (r.status in out) out[r.status as DeliveryStatus] = r._count._all;
      return out;
    },
  };
}
