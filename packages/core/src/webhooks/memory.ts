import { conflict } from '../errors';
import type { DeliveryStatus, WebhookAttemptRecord, WebhookDeliveryRecord, WebhookEndpointRecord, WebhookRepository } from './types';

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory WebhookRepository (tests, ephemeral use). Same contract as the Prisma one. */
export function createMemoryWebhookRepository(): WebhookRepository {
  const endpoints = new Map<string, WebhookEndpointRecord>();
  const deliveries = new Map<string, WebhookDeliveryRecord>();
  const attempts: WebhookAttemptRecord[] = [];
  return {
    async listEndpoints() {
      return [...endpoints.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(clone);
    },
    async getEndpoint(id) {
      const e = endpoints.get(id);
      return e ? clone(e) : null;
    },
    async insertEndpoint(r) {
      if (endpoints.has(r.id)) throw conflict(`webhook ${r.id} exists`);
      endpoints.set(r.id, clone(r));
    },
    async updateEndpoint(id, patch) {
      const e = endpoints.get(id);
      if (!e) return null;
      const next: WebhookEndpointRecord = { ...e };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (v === null) delete (next as unknown as Record<string, unknown>)[k];
        else (next as unknown as Record<string, unknown>)[k] = clone(v);
      }
      endpoints.set(id, next);
      return clone(next);
    },
    async deleteEndpoint(id) {
      return endpoints.delete(id);
    },
    async enqueue(rows) {
      for (const r of rows) if (deliveries.has(r.id)) throw conflict(`delivery ${r.id} exists`);
      for (const r of rows) deliveries.set(r.id, clone(r));
    },
    async getDelivery(id) {
      const d = deliveries.get(id);
      return d ? clone(d) : null;
    },
    async listDeliveries(f = {}) {
      return [...deliveries.values()]
        .filter((d) => (!f.endpointId || d.endpointId === f.endpointId) && (!f.status || d.status === f.status) && (!f.eventType || d.eventType === f.eventType) && (!f.before || d.id < f.before))
        .sort((a, b) => b.id.localeCompare(a.id))
        .slice(0, f.limit ?? 50)
        .map(clone);
    },
    async claim(now, leaseUntil, limit) {
      const due = [...deliveries.values()]
        .filter((d) => (d.status === 'pending' && d.nextAttemptAt <= now) || (d.status === 'delivering' && (d.lockedUntil ?? '') < now))
        .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt) || a.id.localeCompare(b.id))
        .slice(0, limit);
      for (const d of due) {
        d.status = 'delivering';
        d.lockedUntil = leaseUntil;
        d.updatedAt = now;
      }
      return due.map(clone);
    },
    async recordAttempt(a, patch) {
      const d = deliveries.get(a.deliveryId);
      if (!d) return;
      attempts.push(clone(a));
      d.status = patch.status;
      d.attempts = patch.attempts;
      d.updatedAt = patch.updatedAt;
      if (patch.nextAttemptAt) d.nextAttemptAt = patch.nextAttemptAt;
      if (patch.lockedUntil === null) delete d.lockedUntil;
      if (patch.lastStatus === null) delete d.lastStatus;
      else if (patch.lastStatus !== undefined) d.lastStatus = patch.lastStatus;
      if (patch.lastError === null) delete d.lastError;
      else if (patch.lastError !== undefined) d.lastError = patch.lastError;
      if (patch.deliveredAt) d.deliveredAt = patch.deliveredAt;
    },
    async release(ids, at) {
      for (const id of ids) {
        const d = deliveries.get(id);
        if (d && d.status === 'delivering') {
          d.status = 'pending';
          delete d.lockedUntil;
          d.nextAttemptAt = at;
          d.updatedAt = at;
        }
      }
    },
    async listAttempts(deliveryId) {
      return attempts.filter((a) => a.deliveryId === deliveryId).sort((a, b) => a.attempt - b.attempt || a.id.localeCompare(b.id)).map(clone);
    },
    async abandonPending(endpointId, reason, at) {
      let n = 0;
      for (const d of deliveries.values()) {
        if (d.endpointId === endpointId && d.status === 'pending') {
          d.status = 'dead';
          d.lastError = reason;
          d.updatedAt = at;
          n++;
        }
      }
      return n;
    },
    async deleteFinishedBefore(cutoff) {
      let n = 0;
      for (const [id, d] of deliveries) {
        if ((d.status === 'succeeded' || d.status === 'dead') && d.updatedAt < cutoff) {
          deliveries.delete(id);
          n++;
          for (let i = attempts.length - 1; i >= 0; i--) if (attempts[i]!.deliveryId === id) attempts.splice(i, 1);
        }
      }
      return n;
    },
    async countByStatus(endpointId) {
      const out: Record<DeliveryStatus, number> = { pending: 0, delivering: 0, succeeded: 0, dead: 0 };
      for (const d of deliveries.values()) if (!endpointId || d.endpointId === endpointId) out[d.status]++;
      return out;
    },
  };
}
