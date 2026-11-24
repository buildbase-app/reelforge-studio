/**
 * Outbound events (#66, D-070..D-074): records and the repository contract.
 * Kept in their own file so the persistence bundle in repositories.ts only
 * needs one line for them.
 */

/** Where an endpoint delivers: a signed webhook, a chat incoming webhook, or email. */
export const CHANNEL_TYPES = ['webhook', 'slack', 'discord', 'teams', 'email'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const EMAIL_PROVIDERS = ['smtp', 'resend', 'postmark', 'ses', 'sendgrid'] as const;
export type EmailProviderId = (typeof EMAIL_PROVIDERS)[number];

/** A value encrypted with the config cipher (REELFORGE_SECRET_KEY), or plain where nothing is secret. */
export interface SealedValue {
  value: string;
  scheme: string;
}

export interface WebhookEndpointRecord {
  /** `whk_...` */
  id: string;
  name: string;
  description?: string;
  type: ChannelType;
  /** Target URL, sealed (chat webhook URLs carry their token in the path). Absent for email. */
  url?: SealedValue;
  /** The URL with its secret parts masked, for lists (`https://hooks.slack.com/services/T0…/…`). */
  urlDisplay?: string;
  /** Email channels: provider and recipients. */
  email?: { provider: EmailProviderId; to: string[] };
  /** Event types or patterns (`job.*`, `*`). */
  events: string[];
  enabled: boolean;
  /** Why it was turned off by the server (410 Gone), if it was. */
  disabledReason?: string;
  /** Standard Webhooks signing secret (`whsec_...`), sealed. Webhook channels only. */
  secret?: SealedValue;
  /** The secret before the last rotation; signatures with both are sent until `prevSecretExpiresAt`. */
  prevSecret?: SealedValue;
  prevSecretExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  /** API key id (or "cli") that created it. */
  createdBy?: string;
}

/** Fields that can change; null clears an optional one. */
export interface WebhookEndpointPatch {
  name?: string;
  description?: string | null;
  url?: SealedValue;
  urlDisplay?: string;
  email?: { provider: EmailProviderId; to: string[] };
  events?: string[];
  enabled?: boolean;
  disabledReason?: string | null;
  secret?: SealedValue;
  prevSecret?: SealedValue | null;
  prevSecretExpiresAt?: string | null;
  updatedAt: string;
}

export const DELIVERY_STATUSES = ['pending', 'delivering', 'succeeded', 'dead'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** The event as sent (Standard Webhooks payload: type, timestamp, data; plus our id). */
export interface EventEnvelope {
  /** `evt_...` */
  id: string;
  type: string;
  /** ISO-8601, when the event happened. */
  timestamp: string;
  data: Record<string, unknown>;
}

/** One message to one endpoint: the outbox row and its current state. */
export interface WebhookDeliveryRecord {
  /** `dlv_...` (sortable by creation time). */
  id: string;
  /** Set on deliveries claimed across workspaces (#304): the worker sends each in its own workspace. */
  workspaceId?: string;
  endpointId: string;
  /** Sent as `webhook-id`: the same on every retry and replay (receivers deduplicate on it). */
  messageId: string;
  eventId: string;
  eventType: string;
  payload: EventEnvelope;
  status: DeliveryStatus;
  /** Attempts made so far. */
  attempts: number;
  /** When the next attempt is due (pending). */
  nextAttemptAt: string;
  /** While `delivering`: the worker's lease; after it the delivery is picked up again (crash recovery). */
  lockedUntil?: string;
  lastStatus?: number;
  lastError?: string;
  deliveredAt?: string;
  /** The delivery this one replays. */
  replayOf?: string;
  createdAt: string;
  updatedAt: string;
}

/** Changes after an attempt (null clears). */
export interface WebhookDeliveryPatch {
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt?: string;
  lockedUntil?: null;
  lastStatus?: number | null;
  lastError?: string | null;
  deliveredAt?: string;
  updatedAt: string;
}

export type AttemptOutcome = 'success' | 'retry' | 'failed';

/** One attempt: the append-only delivery log. */
export interface WebhookAttemptRecord {
  id: string;
  deliveryId: string;
  endpointId: string;
  /** 1-based. */
  attempt: number;
  at: string;
  durationMs: number;
  /** HTTP status (or SMTP reply code) when there was an answer. */
  status?: number;
  /** Short, redacted reason when it did not succeed. */
  error?: string;
  outcome: AttemptOutcome;
}

export interface DeliveryFilter {
  endpointId?: string;
  status?: DeliveryStatus;
  eventType?: string;
  /** Page cursor: deliveries with an id lower than this (older). */
  before?: string;
  /** Default 50. */
  limit?: number;
}

/**
 * Endpoints, the outbox and the delivery log. Implementations: memory
 * (createMemoryRepositories) and Prisma (@reelforge/db), checked by
 * packages/db/test/webhooks-contract.test.ts.
 */
export interface WebhookRepository {
  /** Oldest first. */
  listEndpoints(): Promise<WebhookEndpointRecord[]>;
  getEndpoint(id: string): Promise<WebhookEndpointRecord | null>;
  insertEndpoint(record: WebhookEndpointRecord): Promise<void>;
  updateEndpoint(id: string, patch: WebhookEndpointPatch): Promise<WebhookEndpointRecord | null>;
  deleteEndpoint(id: string): Promise<boolean>;

  /** Insert outbox rows (one transaction). */
  enqueue(deliveries: WebhookDeliveryRecord[]): Promise<void>;
  getDelivery(id: string): Promise<WebhookDeliveryRecord | null>;
  /** Newest first. */
  listDeliveries(filter?: DeliveryFilter): Promise<WebhookDeliveryRecord[]>;
  /**
   * Take up to `limit` deliveries that are due (pending with nextAttemptAt <= now,
   * or delivering with an expired lease) and mark them delivering until
   * `leaseUntil`. Safe with several workers on one database: a row is claimed
   * by exactly one of them.
   */
  claim(now: string, leaseUntil: string, limit: number): Promise<WebhookDeliveryRecord[]>;
  /** Append the attempt and update the delivery, atomically. */
  recordAttempt(attempt: WebhookAttemptRecord, patch: WebhookDeliveryPatch): Promise<void>;
  /** Hand claimed deliveries back (graceful shutdown): delivering -> pending, due now. */
  release(ids: string[], at: string): Promise<void>;
  /** Oldest first. */
  listAttempts(deliveryId: string): Promise<WebhookAttemptRecord[]>;
  /** Pending deliveries of an endpoint become dead with this reason (endpoint deleted or disabled). Returns how many. */
  abandonPending(endpointId: string, reason: string, at: string): Promise<number>;
  /** Retention: delete finished (succeeded, dead) deliveries last updated before `cutoff`, with their attempts. */
  deleteFinishedBefore(cutoff: string): Promise<number>;
  /** Deliveries per status (all endpoints, or one). */
  countByStatus(endpointId?: string): Promise<Record<DeliveryStatus, number>>;
}
