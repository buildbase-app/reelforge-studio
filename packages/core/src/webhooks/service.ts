import { createHash } from 'node:crypto';
import { SpanKind, type Counter, type Histogram, type Meter } from '@opentelemetry/api';
import { z } from 'zod';
import { redactSecrets } from '../audit';
import { SECRET_KEY_HELP } from '../config/crypto';
import type { RuntimeConfig } from '../config/runtime';
import { ApiError, badRequest, notFound } from '../errors';
import { newSequentialId } from '../fsutil';
import type { AuditEntryInput } from '../repositories';
import { currentWorkspaceId, runInWorkspace } from '../workspace';
import { NOOP_TELEMETRY, withSpan, type Telemetry } from '../telemetry';
import { EVENT_DESCRIPTIONS, EVENT_TYPES, eventMatches, validEventFilter } from './events';
import { checkTargetUrl, type OutboundPolicy } from './http';
import { BUILTIN_PROVIDERS, providerId, type EmailSettings, type NotificationProvider, type SendResult } from './providers';
import { SECRET_PREFIX, newSigningSecret } from './signature';
import {
  CHANNEL_TYPES,
  DELIVERY_STATUSES,
  EMAIL_PROVIDERS,
  type DeliveryStatus,
  type EventEnvelope,
  type SealedValue,
  type WebhookAttemptRecord,
  type WebhookDeliveryPatch,
  type WebhookDeliveryRecord,
  type WebhookEndpointPatch,
  type WebhookEndpointRecord,
  type WebhookRepository,
} from './types';

/**
 * Outbound events (#66, D-070..D-074): endpoints (signed webhooks, Slack,
 * Discord, Teams, email), the database outbox and the delivery worker.
 *
 * emit() never blocks or fails its caller: it inserts outbox rows in the
 * background. The worker claims due rows (several processes may share one
 * database; a row goes to one of them), sends one attempt, appends it to the
 * delivery log and schedules the next one with exponential backoff and
 * jitter, until it succeeds, fails for good (4xx) or runs out of attempts
 * (dead letter, replayable). Rows survive restarts; a crash mid-attempt
 * leaves a lease that expires and the row is sent again (same webhook-id).
 */

export interface WebhookActor {
  actorType: 'api_key' | 'cli' | 'system';
  actorId?: string;
}

export interface WebhookServiceOptions {
  repo: WebhookRepository;
  settings: RuntimeConfig;
  /** Extra notification providers (plugins), by id; they replace built-in ones with the same id. */
  providers?: NotificationProvider[];
  fetch?: typeof fetch;
  log?: (level: 'info' | 'warn' | 'error', line: string) => void;
  telemetry?: Telemetry;
  now?: () => number;
  publicUrl?: string;
  audit?: (entry: AuditEntryInput) => Promise<unknown>;
  /** How often the worker looks for due deliveries (ms). Default 1000. */
  pollMs?: number;
  /** Parallel sends per process. Default 4. */
  concurrency?: number;
}

export interface PublicWebhook {
  id: string;
  name: string;
  description?: string;
  type: (typeof CHANNEL_TYPES)[number];
  /** Masked: the host and first path segment only. */
  url?: string;
  email?: { provider: string; to: string[] };
  events: string[];
  enabled: boolean;
  disabledReason?: string;
  provider: { id: string; configured: boolean; missing?: string };
  signing?: { scheme: 'standard-webhooks-v1'; headers: string[]; rotating: boolean; previousSecretValidUntil?: string };
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

const eventsSchema = z
  .array(z.string().min(1).max(64))
  .min(1)
  .max(40)
  .refine((a) => a.every(validEventFilter), { message: `unknown event type; use ${EVENT_TYPES.filter((t) => t !== 'webhook.test').join(', ')}, a prefix such as "job.*", or "*"` });
const emailSchema = z.strictObject({ provider: z.enum(EMAIL_PROVIDERS).default('smtp'), to: z.array(z.email()).min(1).max(20) });
const secretSchema = z.string().regex(/^whsec_[A-Za-z0-9+/]{32,}={0,2}$/, 'a Standard Webhooks secret: whsec_ followed by base64 (24 to 64 bytes)');

const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  type: z.enum(CHANNEL_TYPES).default('webhook'),
  url: z.string().min(1).max(2048).optional(),
  email: emailSchema.optional(),
  events: eventsSchema,
  enabled: z.boolean().default(true),
  secret: secretSchema.optional(),
});
const updateSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  url: z.string().min(1).max(2048).optional(),
  email: emailSchema.optional(),
  events: eventsSchema.optional(),
  enabled: z.boolean().optional(),
  rotateSecret: z.boolean().optional(),
  graceHours: z.number().min(0).max(720).optional(),
});
const rotateSchema = z.strictObject({
  overlapHours: z.number().min(0).max(720).optional(),
  secret: secretSchema.optional(),
  endOverlap: z.boolean().optional(),
});
const resendSchema = z.strictObject({
  deliveryId: z.string().min(1).max(100).optional(),
  eventId: z.string().min(1).max(100).optional(),
  dedupeKey: z.string().min(1).max(200).optional(),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    throw new ApiError('bad_request', 400, `invalid webhook: ${r.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ')}`, {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

/**
 * The webhook-id of an event at an endpoint: derived from the endpoint and the event's dedupe key (its id when it
 * has none), so retries, replays, resends and a second emit of the same outcome all carry the same webhook-id (#306).
 */
export function messageIdFor(endpointId: string, key: string): string {
  return `msg_${createHash('sha256').update(`${endpointId}\n${key}`).digest('hex').slice(0, 32)}`;
}

/** `https://hooks.slack.com/services/…`: host and first path segment; tokens in the rest are hidden. */
export function maskUrl(raw: string): string {
  const u = new URL(raw);
  const segs = u.pathname.split('/').filter(Boolean);
  return `${u.protocol}//${u.host}${segs.length ? `/${segs[0]}` : ''}${segs.length > 1 || u.search ? '/…' : ''}`;
}

interface Instruments {
  deliveries: Counter;
  duration: Histogram;
  events: Counter;
}
const instrumentCache = new WeakMap<Meter, Instruments>();
function instruments(meter: Meter): Instruments {
  let i = instrumentCache.get(meter);
  if (!i) {
    i = {
      deliveries: meter.createCounter('reelforge.webhook.deliveries', { description: 'Delivery attempts of outbound events, by channel and outcome (success, retry, dead).' }),
      duration: meter.createHistogram('reelforge.webhook.delivery.duration', { unit: 's', description: 'Time one delivery attempt took, by channel.', advice: { explicitBucketBoundaries: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] } }),
      events: meter.createCounter('reelforge.webhook.events', { description: 'Outbound events emitted, by event type.' }),
    };
    instrumentCache.set(meter, i);
  }
  return i;
}

export class WebhookService {
  private readonly repo: WebhookRepository;
  private readonly providers = new Map<string, NotificationProvider>();
  private readonly now: () => number;
  private readonly telemetry: Telemetry;
  /** Endpoints per workspace (#304), re-read every 15 s or after a change. */
  private cache = new Map<string, { at: number; list: WebhookEndpointRecord[] }>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private wakePending = false;
  private stopping = false;
  private running = false;
  private inflight = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private released = new Set<string>();
  private pendingEmits = new Set<Promise<void>>();
  private lastWarn = new Map<string, number>();

  constructor(private readonly opts: WebhookServiceOptions) {
    this.repo = opts.repo;
    this.now = opts.now ?? Date.now;
    this.telemetry = opts.telemetry ?? NOOP_TELEMETRY;
    for (const p of [...BUILTIN_PROVIDERS, ...(opts.providers ?? [])]) this.providers.set(p.id, p);
  }

  // ---- configuration --------------------------------------------------------------

  private get cfg() {
    return this.opts.settings.current.config.webhooks;
  }

  get policy(): OutboundPolicy {
    return { allowHttp: this.cfg.allowHttp, allowPrivateNetworks: this.cfg.allowPrivateNetworks };
  }

  emailSettings(): EmailSettings {
    const e = this.opts.settings.current.config.notifications.email;
    return {
      from: e.from,
      smtp: { host: e.smtp.host, port: e.smtp.port, security: e.smtp.security, user: e.smtp.user, password: e.smtp.password },
      resend: { apiKey: e.resend.apiKey, baseUrl: e.resend.baseUrl },
      postmark: { serverToken: e.postmark.serverToken, baseUrl: e.postmark.baseUrl, messageStream: e.postmark.messageStream },
      sendgrid: { apiKey: e.sendgrid.apiKey, baseUrl: e.sendgrid.baseUrl },
      ses: { region: e.ses.region, accessKeyId: e.ses.accessKeyId, secretAccessKey: e.ses.secretAccessKey, sessionToken: e.ses.sessionToken, endpoint: e.ses.endpoint },
    };
  }

  /** Every credential value in the settings, to scrub from error texts. */
  private credentialValues(): string[] {
    const e = this.emailSettings();
    return [e.smtp.password, e.resend.apiKey, e.postmark.serverToken, e.sendgrid.apiKey, e.ses.secretAccessKey, e.ses.sessionToken, e.ses.accessKeyId].filter((v): v is string => !!v && v.length >= 4);
  }

  private seal(name: string, plaintext: string): SealedValue {
    const cipher = this.opts.settings.cipher;
    if (!cipher) throw new ApiError('secret_key_required', 409, `refusing to store webhook URLs and signing secrets without encryption: REELFORGE_SECRET_KEY is not set. ${SECRET_KEY_HELP}`);
    return { value: cipher.encrypt(name, plaintext), scheme: 'aes-256-gcm' };
  }

  private unseal(name: string, v: SealedValue): string {
    if (v.scheme === 'plain') return v.value;
    const cipher = this.opts.settings.cipher;
    if (!cipher) throw new Error(`cannot decrypt ${name}: REELFORGE_SECRET_KEY is not set`);
    return cipher.decrypt(name, v.value);
  }

  eventTypes() {
    return EVENT_TYPES.map((type) => ({ type, description: EVENT_DESCRIPTIONS[type] }));
  }

  providerList() {
    const email = this.emailSettings();
    return [...this.providers.values()].map((p) => ({ id: p.id, channel: p.channel, displayName: p.displayName, ...p.configured(email) }));
  }

  private toPublic(r: WebhookEndpointRecord): PublicWebhook {
    const p = this.providers.get(providerId(r));
    const conf = p ? p.configured(this.emailSettings()) : { ok: false, missing: `provider ${providerId(r)} is not installed` };
    const rotating = !!(r.prevSecret && r.prevSecretExpiresAt && Date.parse(r.prevSecretExpiresAt) > this.now());
    return {
      id: r.id,
      name: r.name,
      ...(r.description ? { description: r.description } : {}),
      type: r.type,
      ...(r.urlDisplay ? { url: r.urlDisplay } : {}),
      ...(r.email ? { email: r.email } : {}),
      events: r.events,
      enabled: r.enabled,
      ...(r.disabledReason ? { disabledReason: r.disabledReason } : {}),
      provider: { id: providerId(r), configured: conf.ok, ...(conf.missing ? { missing: conf.missing } : {}) },
      ...(r.type === 'webhook'
        ? { signing: { scheme: 'standard-webhooks-v1' as const, headers: ['webhook-id', 'webhook-timestamp', 'webhook-signature'], rotating, ...(rotating ? { previousSecretValidUntil: r.prevSecretExpiresAt } : {}) } }
        : {}),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ...(r.createdBy ? { createdBy: r.createdBy } : {}),
    };
  }

  private async endpoints(): Promise<WebhookEndpointRecord[]> {
    const ws = currentWorkspaceId();
    const hit = this.cache.get(ws);
    if (hit && this.now() - hit.at < 15_000) return hit.list;
    const list = await this.repo.listEndpoints();
    this.cache.set(ws, { at: this.now(), list });
    return list;
  }

  private invalidate() {
    this.cache.clear();
  }

  private async audit(actor: WebhookActor | undefined, action: string, targetId: string, data?: Record<string, unknown>) {
    await this.opts.audit?.({
      actorType: actor?.actorType ?? 'system',
      ...(actor?.actorId ? { actorId: actor.actorId } : {}),
      action,
      targetType: 'webhook',
      targetId,
      ...(data ? { data } : {}),
    });
  }

  // ---- endpoints ------------------------------------------------------------------

  async list(): Promise<{ webhooks: PublicWebhook[]; eventTypes: ReturnType<WebhookService['eventTypes']> }> {
    return { webhooks: (await this.repo.listEndpoints()).map((r) => this.toPublic(r)), eventTypes: this.eventTypes() };
  }

  async get(id: string): Promise<PublicWebhook & { deliveries: Record<DeliveryStatus, number> }> {
    const r = await this.repo.getEndpoint(id);
    if (!r) throw notFound('webhook', id);
    return { ...this.toPublic(r), deliveries: await this.repo.countByStatus(id) };
  }

  private target(type: string, url: string | undefined, email: unknown) {
    if (type === 'email') {
      if (url) throw badRequest('email channels take "email": { provider, to }, not a url');
      if (!email) throw badRequest('email channels need "email": { "provider": "smtp", "to": ["ops@example.com"] }');
      return { email: email as { provider: (typeof EMAIL_PROVIDERS)[number]; to: string[] } };
    }
    if (email) throw badRequest(`"email" is only for type "email"`);
    if (!url) throw badRequest(`type "${type}" needs a url`);
    checkTargetUrl(url, this.policy);
    return { url };
  }

  async create(input: unknown, actor?: WebhookActor): Promise<{ webhook: PublicWebhook; secret?: string; note?: string }> {
    const a = parse(createSchema, input);
    if (a.secret && a.type !== 'webhook') throw badRequest('only webhook endpoints have a signing secret');
    const t = this.target(a.type, a.url, a.email);
    const id = newSequentialId('whk');
    const at = new Date(this.now()).toISOString();
    const secret = a.type === 'webhook' ? (a.secret ?? newSigningSecret()) : undefined;
    const record: WebhookEndpointRecord = {
      id,
      name: a.name,
      ...(a.description ? { description: a.description } : {}),
      type: a.type,
      ...(t.url ? { url: this.seal(`webhook:${id}:url`, t.url), urlDisplay: maskUrl(t.url) } : {}),
      ...(t.email ? { email: t.email } : {}),
      events: [...new Set(a.events)],
      enabled: a.enabled,
      ...(secret ? { secret: this.seal(`webhook:${id}:secret`, secret) } : {}),
      createdAt: at,
      updatedAt: at,
      ...(actor?.actorId ? { createdBy: actor.actorId } : actor?.actorType === 'cli' ? { createdBy: 'cli' } : {}),
    };
    await this.repo.insertEndpoint(record);
    this.invalidate();
    await this.audit(actor, 'webhook.create', id, { name: a.name, type: a.type, events: record.events, ...(record.urlDisplay ? { url: record.urlDisplay } : {}), ...(t.email ? { emailProvider: t.email.provider, recipients: t.email.to.length } : {}) });
    return {
      webhook: this.toPublic(record),
      ...(secret && !a.secret ? { secret, note: 'store this signing secret now; it is not shown again. Verify the webhook-signature header with it (Standard Webhooks).' } : {}),
    };
  }

  async update(id: string, input: unknown, actor?: WebhookActor): Promise<{ webhook: PublicWebhook; secret?: string; note?: string }> {
    const a = parse(updateSchema, input);
    const current = await this.repo.getEndpoint(id);
    if (!current) throw notFound('webhook', id);
    const at = new Date(this.now()).toISOString();
    const patch: WebhookEndpointPatch = { updatedAt: at };
    const changed: string[] = [];
    if (a.name !== undefined) (patch.name = a.name), changed.push('name');
    if (a.description !== undefined) (patch.description = a.description), changed.push('description');
    if (a.events) (patch.events = [...new Set(a.events)]), changed.push('events');
    if (a.url !== undefined) {
      this.target(current.type, a.url, undefined);
      patch.url = this.seal(`webhook:${id}:url`, a.url);
      patch.urlDisplay = maskUrl(a.url);
      changed.push('url');
    }
    if (a.email !== undefined) {
      this.target(current.type, undefined, a.email);
      patch.email = a.email;
      changed.push('email');
    }
    if (a.enabled !== undefined) {
      patch.enabled = a.enabled;
      if (a.enabled) patch.disabledReason = null;
      changed.push('enabled');
    }
    let secret: string | undefined;
    if (a.rotateSecret) {
      secret = this.rotation(current, patch, a.graceHours);
      changed.push('secret');
    } else if (a.graceHours !== undefined) throw badRequest('graceHours only goes with rotateSecret: true');
    if (changed.length === 0) throw badRequest('nothing to change: send name, description, url, email, events, enabled or rotateSecret');
    const r = await this.repo.updateEndpoint(id, patch);
    if (!r) throw notFound('webhook', id);
    this.invalidate();
    await this.audit(actor, a.rotateSecret ? 'webhook.rotate_secret' : 'webhook.update', id, { changed, ...(patch.prevSecretExpiresAt ? { previousSecretValidUntil: patch.prevSecretExpiresAt } : {}) });
    return { webhook: this.toPublic(r), ...(secret ? { secret, note: 'store the new signing secret now; it is not shown again. Until webhook.signing.previousSecretValidUntil both secrets sign every message.' } : {}) };
  }

  /**
   * A new signing secret into `patch`; the current one keeps signing next to it for `overlapHours` (default
   * webhooks.secretRotationGraceHours), so the receiver has two valid secrets until it switched. A second rotation
   * during the overlap drops the oldest: never more than two.
   */
  private rotation(current: WebhookEndpointRecord, patch: WebhookEndpointPatch, overlapHours?: number, given?: string): string {
    if (current.type !== 'webhook') throw badRequest('only webhook endpoints have a signing secret');
    const id = current.id;
    const secret = given ?? newSigningSecret();
    const grace = overlapHours ?? this.cfg.secretRotationGraceHours;
    patch.secret = this.seal(`webhook:${id}:secret`, secret);
    if (grace > 0 && current.secret) {
      // The old secret, sealed again under its "previous" name, keeps signing next to the new one.
      patch.prevSecret = this.seal(`webhook:${id}:prev-secret`, this.unseal(`webhook:${id}:secret`, current.secret));
      patch.prevSecretExpiresAt = new Date(this.now() + grace * 3_600_000).toISOString();
    } else {
      patch.prevSecret = null;
      patch.prevSecretExpiresAt = null;
    }
    return secret;
  }

  /**
   * rotate_webhook_secret: a new secret (generated, or `secret` brought by the receiver) with an overlap window in
   * which messages carry both signatures; or `endOverlap: true` to stop signing with the previous secret now, once
   * the receiver has switched.
   */
  async rotateSecret(id: string, input: unknown, actor?: WebhookActor): Promise<{ webhook: PublicWebhook; secret?: string; note: string }> {
    const a = parse(rotateSchema, input);
    const current = await this.repo.getEndpoint(id);
    if (!current) throw notFound('webhook', id);
    if (current.type !== 'webhook') throw badRequest('only webhook endpoints have a signing secret');
    const at = new Date(this.now()).toISOString();
    const patch: WebhookEndpointPatch = { updatedAt: at };
    if (a.endOverlap) {
      if (a.secret || a.overlapHours !== undefined) throw badRequest('endOverlap ends the current overlap; it takes no secret or overlapHours');
      patch.prevSecret = null;
      patch.prevSecretExpiresAt = null;
      const r = await this.repo.updateEndpoint(id, patch);
      if (!r) throw notFound('webhook', id);
      this.invalidate();
      await this.audit(actor, 'webhook.rotate_secret', id, { endOverlap: true });
      return { webhook: this.toPublic(r), note: 'only the current secret signs from now on' };
    }
    const secret = this.rotation(current, patch, a.overlapHours, a.secret);
    const r = await this.repo.updateEndpoint(id, patch);
    if (!r) throw notFound('webhook', id);
    this.invalidate();
    await this.audit(actor, 'webhook.rotate_secret', id, { changed: ['secret'], ...(patch.prevSecretExpiresAt ? { previousSecretValidUntil: patch.prevSecretExpiresAt } : {}) });
    const overlap = patch.prevSecretExpiresAt ? `Until ${patch.prevSecretExpiresAt} every message carries signatures with the new and the previous secret; ` : 'Only the new secret signs from now on; ';
    return {
      webhook: this.toPublic(r),
      ...(a.secret ? {} : { secret }),
      note: `${a.secret ? 'the secret you sent is now the current one. ' : 'store the new signing secret now; it is not shown again. '}${overlap}a receiver accepts a message when any v1 signature matches one of its secrets (Standard Webhooks).`,
    };
  }

  async delete(id: string, actor?: WebhookActor): Promise<{ deleted: string; abandoned: number }> {
    const current = await this.repo.getEndpoint(id);
    if (!current) throw notFound('webhook', id);
    const abandoned = await this.repo.abandonPending(id, 'the endpoint was deleted', new Date(this.now()).toISOString());
    await this.repo.deleteEndpoint(id);
    this.invalidate();
    await this.audit(actor, 'webhook.delete', id, { name: current.name, abandoned });
    return { deleted: id, abandoned };
  }

  // ---- deliveries -----------------------------------------------------------------

  private delivery(endpointId: string, event: EventEnvelope, extra: Partial<WebhookDeliveryRecord> = {}): WebhookDeliveryRecord {
    const at = new Date(this.now()).toISOString();
    return {
      id: newSequentialId('dlv'),
      endpointId,
      messageId: messageIdFor(endpointId, event.dedupeKey ?? event.id),
      eventId: event.id,
      eventType: event.type,
      ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
      payload: event,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: at,
      createdAt: at,
      updatedAt: at,
      ...extra,
    };
  }

  private envelope(type: string, data: Record<string, unknown>, dedupeKey?: string): EventEnvelope {
    return { id: newSequentialId('evt'), type, timestamp: new Date(this.now()).toISOString(), data: redactSecrets(data), ...(dedupeKey ? { dedupeKey } : {}) };
  }

  /**
   * Queue an event for every enabled endpoint that subscribed to it. Returns at
   * once; the outbox insert runs in the background and a failure is logged,
   * never thrown at the caller (a job or request must not fail because of it).
   */
  emit(type: string, data: Record<string, unknown> | (() => Promise<Record<string, unknown>>), opts: { dedupeKey?: string } = {}): void {
    const p = (async () => {
      const matching = (await this.endpoints()).filter((e) => e.enabled && eventMatches(e.events, type));
      if (!matching.length) return;
      instruments(this.telemetry.meter).events.add(1, { 'reelforge.event_type': type });
      // A payload that costs reads (terminal render events: log excerpt, output size) is only built when someone listens.
      const event = this.envelope(type, typeof data === 'function' ? await data() : data, opts.dedupeKey);
      await this.repo.enqueue(matching.map((e) => this.delivery(e.id, event)));
      this.wake();
    })().catch((e) => this.warn('emit', `outbound event ${type} could not be queued: ${(e as Error).message}`));
    this.pendingEmits.add(p);
    void p.finally(() => this.pendingEmits.delete(p));
  }

  /** Wait for queued emits to reach the database (tests, the CLI before it exits). */
  async flush(): Promise<void> {
    while (this.pendingEmits.size) await Promise.all([...this.pendingEmits]);
  }

  /** Send a `webhook.test` event to one endpoint; with waitSeconds, wait for its first attempt. */
  async test(id: string, opts: { waitSeconds?: number } = {}, actor?: WebhookActor) {
    const ep = await this.repo.getEndpoint(id);
    if (!ep) throw notFound('webhook', id);
    const wait = Math.max(0, Math.min(30, Number(opts.waitSeconds ?? 0) || 0));
    const event = this.envelope('webhook.test', { webhookId: id, name: ep.name, message: 'This is a test event from ReelForge Studio.' });
    const d = this.delivery(id, event);
    await this.repo.enqueue([d]);
    await this.audit(actor, 'webhook.test', id, { deliveryId: d.id });
    this.wake();
    return { delivery: await this.waitForAttempt(d.id, wait), ...(this.running ? {} : { note: 'queued; the running server delivers it' }) };
  }

  private async waitForAttempt(deliveryId: string, waitSeconds: number) {
    const until = Date.now() + waitSeconds * 1000;
    for (;;) {
      const d = await this.repo.getDelivery(deliveryId);
      if (!d) throw notFound('delivery', deliveryId);
      if (d.attempts > 0 || Date.now() >= until || !this.running) return { ...this.deliveryView(d), attemptLog: await this.repo.listAttempts(d.id) };
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** When a delivery stops being retried: webhooks.retryWindowHours after it was queued. */
  private giveUpAt(d: Pick<WebhookDeliveryRecord, 'createdAt'>): number {
    return Date.parse(d.createdAt) + this.cfg.retryWindowHours * 3_600_000;
  }

  private deliveryView(d: WebhookDeliveryRecord, includePayload = false) {
    const { payload, lockedUntil: _l, ...rest } = d;
    const open = d.status === 'pending' || d.status === 'delivering';
    return { ...rest, ...(open ? { giveUpAt: new Date(this.giveUpAt(d)).toISOString() } : {}), ...(includePayload ? { payload } : {}) };
  }

  async listDeliveries(id: string, q: { status?: unknown; eventType?: unknown; cursor?: unknown; limit?: unknown; includePayload?: unknown; includeAttempts?: unknown } = {}) {
    const ep = await this.repo.getEndpoint(id);
    if (!ep) throw notFound('webhook', id);
    if (q.status !== undefined && q.status !== '' && !DELIVERY_STATUSES.includes(q.status as DeliveryStatus)) throw badRequest(`status must be one of ${DELIVERY_STATUSES.join(', ')}`);
    const limit = q.limit === undefined || q.limit === '' ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw badRequest('limit must be an integer from 1 to 500');
    const rows = await this.repo.listDeliveries({
      endpointId: id,
      ...(q.status ? { status: q.status as DeliveryStatus } : {}),
      ...(typeof q.eventType === 'string' && q.eventType ? { eventType: q.eventType } : {}),
      ...(typeof q.cursor === 'string' && q.cursor ? { before: q.cursor } : {}),
      limit,
    });
    const withPayload = q.includePayload === true || q.includePayload === 'true';
    const withAttempts = q.includeAttempts !== false && q.includeAttempts !== 'false';
    const deliveries = await Promise.all(rows.map(async (d) => ({ ...this.deliveryView(d, withPayload), ...(withAttempts ? { attemptLog: await this.repo.listAttempts(d.id) } : {}) })));
    return { deliveries, nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null, counts: await this.repo.countByStatus(id) };
  }

  /** Send a delivery again as a new outbox row with the same webhook-id and payload (receivers can deduplicate). */
  async replay(id: string, deliveryId: string, actor?: WebhookActor) {
    const d = await this.repo.getDelivery(deliveryId);
    if (!d || d.endpointId !== id) throw notFound('delivery', deliveryId);
    if (d.status === 'pending' || d.status === 'delivering') throw new ApiError('conflict', 409, `delivery ${deliveryId} is still ${d.status}; replay it once it succeeded or is dead`);
    const ep = await this.repo.getEndpoint(id);
    if (!ep) throw notFound('webhook', id);
    if (!ep.enabled) throw new ApiError('conflict', 409, `webhook ${id} is disabled${ep.disabledReason ? ` (${ep.disabledReason})` : ''}; enable it with update_webhook first`);
    const copy = this.delivery(id, d.payload, { messageId: d.messageId, replayOf: d.id });
    await this.repo.enqueue([copy]);
    await this.audit(actor, 'webhook.delivery.replay', id, { deliveryId: d.id, replayId: copy.id, eventType: d.eventType });
    this.wake();
    return { delivery: this.deliveryView(copy) };
  }

  /**
   * resend_webhook (#306): send an event to an endpoint again, named by `deliveryId`, `eventId` or `dedupeKey`
   * (`render:<jobId>`: the terminal event of a render). A delivery waiting for its next attempt is made due now
   * (`rescheduled`); a finished one (succeeded or dead) is queued again with the same webhook-id and payload
   * (`queued`, with a fresh retry window); an event this endpoint never got (e.g. one emitted before it existed, found
   * by eventId or dedupeKey at another endpoint) is queued for it under its own webhook-id.
   */
  async resend(id: string, input: unknown, actor?: WebhookActor) {
    const a = parse(resendSchema, input);
    const given = (['deliveryId', 'eventId', 'dedupeKey'] as const).filter((k) => a[k] !== undefined);
    if (given.length !== 1) throw badRequest('send exactly one of deliveryId, eventId or dedupeKey (e.g. "render:<jobId>" for the outcome of a render)');
    const ep = await this.repo.getEndpoint(id);
    if (!ep) throw notFound('webhook', id);
    if (!ep.enabled) throw new ApiError('conflict', 409, `webhook ${id} is disabled${ep.disabledReason ? ` (${ep.disabledReason})` : ''}; enable it with update_webhook first`);
    let source: WebhookDeliveryRecord | null = null;
    if (a.deliveryId) {
      source = await this.repo.getDelivery(a.deliveryId);
      if (!source || source.endpointId !== id) throw notFound('delivery', a.deliveryId);
    } else {
      const filter = a.eventId ? { eventId: a.eventId } : { dedupeKey: a.dedupeKey! };
      // This endpoint's own delivery first (newest), else the event as another endpoint got it.
      source = (await this.repo.listDeliveries({ ...filter, endpointId: id, limit: 1 }))[0] ?? (await this.repo.listDeliveries({ ...filter, limit: 1 }))[0] ?? null;
      if (!source) throw notFound('event', a.eventId ?? a.dedupeKey!, { hint: 'only events that were queued for some endpoint and are still in the delivery log (webhooks.deliveryRetentionDays) can be sent again' });
    }
    const at = new Date(this.now()).toISOString();
    let action: 'rescheduled' | 'queued';
    let delivery: WebhookDeliveryRecord;
    if (source.endpointId === id && source.status === 'delivering') {
      throw new ApiError('conflict', 409, `delivery ${source.id} is being sent right now; its outcome is in the delivery log in a moment`);
    } else if (source.endpointId === id && source.status === 'pending') {
      if (!(await this.repo.reschedule(source.id, at))) throw new ApiError('conflict', 409, `delivery ${source.id} changed state meanwhile; try again`);
      action = 'rescheduled';
      delivery = { ...source, nextAttemptAt: at, updatedAt: at };
    } else {
      // Same payload; the webhook-id follows the endpoint and the event's dedupe key, so it equals the original's.
      delivery = this.delivery(id, source.payload, { ...(source.endpointId === id ? { replayOf: source.id } : {}) });
      await this.repo.enqueue([delivery]);
      action = 'queued';
    }
    await this.audit(actor, 'webhook.resend', id, { action, deliveryId: delivery.id, eventType: source.eventType, ...(source.endpointId !== id ? { fromEndpoint: source.endpointId } : {}) });
    this.wake();
    return { action, delivery: this.deliveryView(delivery) };
  }

  /**
   * get_webhook_log (#306, read scope): one endpoint's delivery log without payloads or targets: per delivery its
   * status, attempts, latency (each attempt's duration) and when it gives up; a summary over the page.
   */
  async log(id: string, q: { status?: unknown; eventType?: unknown; cursor?: unknown; limit?: unknown } = {}) {
    const ep = await this.repo.getEndpoint(id);
    if (!ep) throw notFound('webhook', id);
    const page = await this.listDeliveries(id, { ...q, includePayload: false, includeAttempts: true });
    const attempts = page.deliveries.flatMap((d) => (d as { attemptLog?: WebhookAttemptRecord[] }).attemptLog ?? []);
    const latencies = attempts.map((x) => x.durationMs).sort((x, y) => x - y);
    const pct = (p: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)]! : null);
    const last = (outcome: (o: WebhookAttemptRecord['outcome']) => boolean) => attempts.filter((x) => outcome(x.outcome)).reduce<string | null>((m, x) => (!m || x.at > m ? x.at : m), null);
    return {
      webhook: { id: ep.id, name: ep.name, type: ep.type, enabled: ep.enabled, ...(ep.disabledReason ? { disabledReason: ep.disabledReason } : {}) },
      deliveries: page.deliveries.map((d) => {
        const log = (d as { attemptLog?: WebhookAttemptRecord[] }).attemptLog ?? [];
        return { ...d, attemptLog: log.map(({ deliveryId: _d, endpointId: _e, ...x }) => x), ...(log.length ? { latencyMs: log[log.length - 1]!.durationMs } : {}) };
      }),
      nextCursor: page.nextCursor,
      counts: page.counts,
      summary: {
        deliveries: page.deliveries.length,
        attempts: attempts.length,
        successRate: attempts.length ? Math.round((attempts.filter((x) => x.outcome === 'success').length / attempts.length) * 1000) / 1000 : null,
        latencyMs: { p50: pct(50), p95: pct(95), max: latencies.length ? latencies[latencies.length - 1]! : null },
        lastSuccessAt: last((o) => o === 'success'),
        lastFailureAt: last((o) => o !== 'success'),
      },
      retry: { windowHours: this.cfg.retryWindowHours, maxAttempts: this.cfg.maxAttempts, timeoutSeconds: this.cfg.timeoutSeconds },
    };
  }

  // ---- the worker -----------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs ?? 1000);
    this.timer.unref();
    this.wake();
  }

  /** Look for due deliveries now (after an emit, a replay, a test). */
  wake(): void {
    if (!this.running || this.wakePending) return;
    this.wakePending = true;
    setImmediate(() => {
      this.wakePending = false;
      void this.tick();
    });
  }

  private async tick(): Promise<void> {
    if (!this.running || this.stopping || this.ticking) return;
    this.ticking = true;
    let full = false;
    try {
      const free = (this.opts.concurrency ?? 4) - this.inflight.size;
      if (free <= 0) return;
      const now = this.now();
      const lease = now + this.cfg.timeoutSeconds * 1000 + 60_000;
      const rows = await this.repo.claim(new Date(now).toISOString(), new Date(lease).toISOString(), free);
      full = rows.length === free;
      for (const d of rows) {
        const controller = new AbortController();
        // Each delivery is sent in its own workspace (#304): its endpoint, attempts and audit entries are there.
        const done = runInWorkspace(d.workspaceId, () => this.deliver(d, controller.signal))
          .catch((e) => this.warn('deliver', `webhook delivery ${d.id} crashed: ${(e as Error).message}`))
          .finally(() => {
            this.inflight.delete(d.id);
            this.wake();
          });
        this.inflight.set(d.id, { controller, done });
      }
    } catch (e) {
      this.warn('claim', `webhook worker could not read the outbox: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
    if (full) this.wake();
  }

  /** Delay before attempt `n + 1` after `n` failed attempts: exponential, capped, ±20 % jitter, at least Retry-After. */
  backoffMs(attempts: number, retryAfterSeconds?: number, random = Math.random): number {
    const base = this.cfg.retryBaseSeconds * 1000 * 2 ** Math.max(0, attempts - 1);
    const cap = this.cfg.retryMaxDelaySeconds * 1000;
    let ms = Math.min(base, cap) * (0.8 + 0.4 * random());
    if (retryAfterSeconds !== undefined) ms = Math.max(ms, Math.min(retryAfterSeconds * 1000, cap));
    return Math.round(ms);
  }

  private scrub(text: string, secrets: string[]): string {
    let s = text;
    for (const v of [...secrets, ...this.credentialValues()]) if (v) s = s.split(v).join('[redacted]');
    return redactSecrets(s).slice(0, 500);
  }

  private async deliver(d: WebhookDeliveryRecord, signal: AbortSignal): Promise<void> {
    const started = this.now();
    const attemptNo = d.attempts + 1;
    const ep = await this.repo.getEndpoint(d.endpointId);
    let result: SendResult;
    let secrets: string[] = [];
    let channel = 'unknown';
    if (!ep) result = { outcome: 'failed', error: 'the endpoint was deleted' };
    else if (!ep.enabled) result = { outcome: 'failed', error: `the endpoint is disabled${ep.disabledReason ? ` (${ep.disabledReason})` : ''}` };
    else {
      channel = ep.type;
      const provider = this.providers.get(providerId(ep));
      const email = this.emailSettings();
      const conf = provider?.configured(email);
      if (!provider) result = { outcome: 'failed', error: `notification provider ${providerId(ep)} is not installed` };
      else if (!conf!.ok) result = { outcome: 'retry', error: `${provider.displayName} is not configured: set ${conf!.missing}` };
      else {
        let url: string | undefined;
        try {
          url = ep.url ? this.unseal(`webhook:${ep.id}:url`, ep.url) : undefined;
          if (ep.secret) secrets.push(this.unseal(`webhook:${ep.id}:secret`, ep.secret));
          if (ep.prevSecret && ep.prevSecretExpiresAt && Date.parse(ep.prevSecretExpiresAt) > this.now()) secrets.push(this.unseal(`webhook:${ep.id}:prev-secret`, ep.prevSecret));
        } catch (e) {
          url = undefined;
          result = { outcome: 'failed', error: `cannot decrypt the endpoint (${(e as Error).message})` };
        }
        if (url !== undefined || ep.type === 'email') {
          if (url) secrets = [...secrets, url];
          const sendSecrets = ep.secret ? secrets.filter((s) => s.startsWith(SECRET_PREFIX)) : [];
          result = await withSpan(
            this.telemetry.tracer,
            `webhook.deliver ${ep.type}`,
            { 'reelforge.webhook.channel': ep.type, 'reelforge.webhook.event_type': d.eventType, 'reelforge.webhook.attempt': attemptNo, 'reelforge.webhook.provider': provider.id },
            async (span) => {
              const r = await provider.send({ endpoint: ep, url, secrets: sendSecrets, delivery: d, timeoutMs: this.cfg.timeoutSeconds * 1000, signal, policy: this.policy, email, fetch: this.opts.fetch ?? fetch, now: this.now, serverUrl: this.opts.publicUrl });
              span.setAttribute('reelforge.webhook.outcome', r.outcome);
              if (r.status !== undefined) span.setAttribute('http.response.status_code', r.status);
              return r;
            },
            { kind: SpanKind.CLIENT }
          );
        }
      }
    }
    result ??= { outcome: 'failed', error: 'no result' };
    // Shutdown handed this delivery back: its outcome is not recorded (it is sent again after the restart).
    if (this.released.has(d.id)) return;
    const finished = this.now();
    const at = new Date(finished).toISOString();
    const error = result.error ? this.scrub(result.error, secrets) : undefined;
    let status: DeliveryStatus;
    let next: string | undefined;
    let gaveUp: string | undefined;
    const deadline = this.giveUpAt(d);
    if (result.outcome === 'success') status = 'succeeded';
    else if (result.outcome === 'failed') status = 'dead';
    else if (attemptNo >= this.cfg.maxAttempts) (status = 'dead'), (gaveUp = `no more attempts: webhooks.maxAttempts (${this.cfg.maxAttempts}) reached`);
    else if (finished >= deadline) (status = 'dead'), (gaveUp = `no more attempts: the retry window (webhooks.retryWindowHours, ${this.cfg.retryWindowHours} h) ended`);
    else {
      status = 'pending';
      // The last attempt lands on the end of the retry window rather than after it.
      next = new Date(Math.min(finished + this.backoffMs(attemptNo, result.retryAfterSeconds), deadline)).toISOString();
    }
    const lastError = error && gaveUp ? `${error}; ${gaveUp}` : error;
    const attempt: WebhookAttemptRecord = {
      id: newSequentialId('att'),
      deliveryId: d.id,
      endpointId: d.endpointId,
      attempt: attemptNo,
      at,
      durationMs: Math.max(0, finished - started),
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(error ? { error } : {}),
      outcome: result.outcome === 'success' ? 'success' : status === 'dead' ? 'failed' : 'retry',
    };
    const patch: WebhookDeliveryPatch = {
      status,
      attempts: attemptNo,
      lockedUntil: null,
      lastStatus: result.status ?? null,
      lastError: lastError ?? null,
      updatedAt: at,
      ...(next ? { nextAttemptAt: next } : {}),
      ...(status === 'succeeded' ? { deliveredAt: at } : {}),
    };
    // Fenced by this worker's lease: if it ran out and another worker claimed the row, that worker's attempt counts.
    if (!(await this.repo.recordAttempt(attempt, patch, d.lockedUntil))) {
      this.warn(`lease:${d.id}`, `webhook delivery ${d.id}: attempt ${attemptNo} took longer than its lease and was claimed again by another worker; this outcome is not recorded`);
      return;
    }
    const m = instruments(this.telemetry.meter);
    m.deliveries.add(1, { 'reelforge.channel': channel, 'reelforge.outcome': status === 'succeeded' ? 'success' : status === 'dead' ? 'dead' : 'retry' });
    m.duration.record(attempt.durationMs / 1000, { 'reelforge.channel': channel });
    if (status === 'dead' && ep) {
      this.warn(`dead:${ep.id}`, `webhook ${ep.id} ("${ep.name}", ${ep.type}): delivery ${d.id} of ${d.eventType} failed for good after ${attemptNo} attempt(s): ${lastError ?? 'error'}; send it again with resend_webhook`);
    }
    if (result.disable && ep) {
      await this.repo.updateEndpoint(ep.id, { enabled: false, disabledReason: result.disable, updatedAt: at });
      await this.repo.abandonPending(ep.id, `the endpoint was disabled: ${result.disable}`, at);
      this.invalidate();
      this.opts.log?.('warn', `webhook ${ep.id} ("${ep.name}") was disabled: ${result.disable}; enable it with update_webhook once the receiver is back`);
      await this.audit({ actorType: 'system' }, 'webhook.disable', ep.id, { reason: result.disable });
    }
  }

  private warn(key: string, line: string) {
    const now = Date.now();
    if (now - (this.lastWarn.get(key) ?? 0) < 60_000) return;
    this.lastWarn.set(key, now);
    this.opts.log?.('warn', line);
  }

  /**
   * Stop the worker: no new claims; in-flight attempts get `graceMs` to
   * finish (their outcome is recorded), the rest are aborted and handed back
   * as pending, so nothing is lost and the next start sends them again.
   */
  async stop(graceMs = 5_000): Promise<{ finished: number; released: number }> {
    await this.flush();
    if (!this.running) return { finished: 0, released: 0 };
    this.stopping = true;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const all = [...this.inflight.entries()];
    const finished = new Set<string>();
    await Promise.race([Promise.all(all.map(([id, f]) => f.done.then(() => finished.add(id)))), new Promise((r) => setTimeout(r, graceMs).unref())]);
    const left = all.filter(([id]) => !finished.has(id)).map(([id]) => id);
    if (left.length) {
      for (const id of left) {
        this.released.add(id);
        this.inflight.get(id)?.controller.abort();
      }
      await this.repo.release(left, new Date(this.now()).toISOString()).catch((e) => this.opts.log?.('warn', `webhook worker: could not hand back ${left.length} deliveries (${(e as Error).message}); their lease expires and they are sent again`));
    }
    return { finished: finished.size, released: left.length };
  }

  /** Retention of the delivery log: finished deliveries older than webhooks.deliveryRetentionDays (0 keeps all). */
  async sweep(now = this.now()): Promise<number> {
    const days = this.cfg.deliveryRetentionDays;
    if (!(days > 0)) return 0;
    return this.repo.deleteFinishedBefore(new Date(now - days * 86_400_000).toISOString());
  }

  /** For /readyz and get_capabilities: deliveries per status, worker state. */
  async status() {
    return { worker: this.running, inflight: this.inflight.size, deliveries: await this.repo.countByStatus() };
  }
}
