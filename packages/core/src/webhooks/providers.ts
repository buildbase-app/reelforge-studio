import { PRODUCT_NAME, userAgent } from '../product';
import { eventText, eventTitle } from './events';
import { classifyStatus, postOnce, type HttpResult, type OutboundPolicy } from './http';
import { signatureHeaders } from './signature';
import type { AttemptOutcome, ChannelType, EmailProviderId, WebhookDeliveryRecord, WebhookEndpointRecord } from './types';

/**
 * Notification providers (D-073): one per channel type, and one per email
 * service. Each turns a delivery into one request and says how it went; the
 * dispatcher owns retries, the log and the schedule. A provider never throws
 * and never puts a credential in `error`.
 */

/** Email settings (notifications.email.*); secrets are decrypted values. */

/** The notification email's message id header (mail filters can match on it). */
export function messageIdHeaders(messageId: string): Record<string, string> {
  return { 'X-Renderweld-Message-Id': messageId };
}

export interface EmailSettings {
  from?: string;
  smtp: { host?: string; port: number; security: 'starttls' | 'tls' | 'none'; user?: string; password?: string };
  resend: { apiKey?: string; baseUrl: string };
  postmark: { serverToken?: string; baseUrl: string; messageStream: string };
  sendgrid: { apiKey?: string; baseUrl: string };
  ses: { region?: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; endpoint?: string };
}

export interface SendContext {
  endpoint: WebhookEndpointRecord;
  /** Decrypted target URL (webhook and chat channels). */
  url?: string;
  /** Decrypted signing secrets: the current one first, then the previous one during a rotation overlap. */
  secrets: string[];
  delivery: WebhookDeliveryRecord;
  timeoutMs: number;
  signal: AbortSignal;
  policy: OutboundPolicy;
  email: EmailSettings;
  fetch: typeof fetch;
  now: () => number;
  serverUrl?: string;
}

export interface SendResult {
  outcome: AttemptOutcome;
  status?: number;
  error?: string;
  retryAfterSeconds?: number;
  /** Turn the endpoint off with this reason (410 Gone). */
  disable?: string;
}

export interface NotificationProvider {
  /** `webhook`, `slack`, `discord`, `teams`, or `email:<service>`. */
  readonly id: string;
  readonly channel: ChannelType;
  readonly displayName: string;
  /** Whether the provider has what it needs (email: credentials and a sender); says what is missing. */
  configured(email: EmailSettings): { ok: boolean; missing?: string };
  send(ctx: SendContext): Promise<SendResult>;
}

export function providerId(endpoint: Pick<WebhookEndpointRecord, 'type' | 'email'>): string {
  return endpoint.type === 'email' ? `email:${endpoint.email?.provider ?? 'smtp'}` : endpoint.type;
}

function fromHttp(r: HttpResult): SendResult {
  if (r.status === undefined) return { outcome: r.refused ? 'failed' : 'retry', error: r.error ?? 'no answer' };
  const outcome = classifyStatus(r.status);
  return {
    outcome,
    status: r.status,
    ...(outcome === 'success' ? {} : { error: `HTTP ${r.status}` }),
    ...(r.retryAfterSeconds !== undefined ? { retryAfterSeconds: r.retryAfterSeconds } : {}),
    ...(r.status === 410 ? { disable: 'the receiver answered 410 Gone' } : {}),
  };
}

const always = () => ({ ok: true });

// ---- webhooks and chat --------------------------------------------------------------

export const webhookProvider: NotificationProvider = {
  id: 'webhook',
  channel: 'webhook',
  displayName: 'Signed webhook (Standard Webhooks)',
  configured: always,
  async send(ctx) {
    const body = JSON.stringify(ctx.delivery.payload);
    // The attempt's own timestamp (the event's time is in the payload), per the spec.
    const headers = signatureHeaders(ctx.secrets, ctx.delivery.messageId, Math.floor(ctx.now() / 1000), body);
    return fromHttp(await postOnce(ctx.url!, body, headers, { ...ctx.policy, timeoutMs: ctx.timeoutMs, signal: ctx.signal }));
  },
};

function chat(id: 'slack' | 'discord' | 'teams', displayName: string, body: (title: string, text: string) => unknown): NotificationProvider {
  return {
    id,
    channel: id,
    displayName,
    configured: always,
    async send(ctx) {
      const title = eventTitle(ctx.delivery.payload);
      const text = eventText(ctx.delivery.payload, ctx.serverUrl);
      return fromHttp(await postOnce(ctx.url!, JSON.stringify(body(title, text)), {}, { ...ctx.policy, timeoutMs: ctx.timeoutMs, signal: ctx.signal }));
    },
  };
}

/** Slack incoming webhook: `{ text }` (mrkdwn off for the details block). */
export const slackProvider = chat('slack', 'Slack incoming webhook', (title, text) => ({
  text: title,
  blocks: [
    { type: 'section', text: { type: 'plain_text', text: title.slice(0, 3000) } },
    { type: 'section', text: { type: 'plain_text', text: text.split('\n').slice(2).join('\n').slice(0, 2900) || ' ' } },
  ],
}));

/** Discord webhook: `{ content }` (max 2000 characters), mentions disabled. */
export const discordProvider = chat('discord', 'Discord webhook', (_title, text) => ({
  username: PRODUCT_NAME,
  content: text.length > 1990 ? `${text.slice(0, 1987)}...` : text,
  allowed_mentions: { parse: [] },
}));

/** Microsoft Teams (Workflows "post to a channel when a webhook request is received", or a legacy connector): an Adaptive Card message. */
export const teamsProvider = chat('teams', 'Microsoft Teams webhook (Workflows / connector)', (title, text) => ({
  type: 'message',
  attachments: [
    {
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
          { type: 'TextBlock', text: text.split('\n').slice(2).join('\n\n').slice(0, 20_000), wrap: true },
        ],
      },
    },
  ],
}));

// ---- email ----------------------------------------------------------------------------

interface Mail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  messageId: string;
}

function mail(ctx: SendContext): Mail {
  return {
    from: ctx.email.from!,
    to: ctx.endpoint.email?.to ?? [],
    subject: eventTitle(ctx.delivery.payload).slice(0, 200),
    text: eventText(ctx.delivery.payload, ctx.serverUrl),
    messageId: ctx.delivery.messageId,
  };
}

function needFrom(email: EmailSettings, extra: Array<[unknown, string]>): { ok: boolean; missing?: string } {
  const missing = [...(email.from ? [] : ['notifications.email.from']), ...extra.filter(([v]) => !v).map(([, n]) => n)];
  return missing.length ? { ok: false, missing: missing.join(', ') } : { ok: true };
}

/** An HTTP email API call: JSON in, status out. Credentials go in headers only and never into `error`. */
async function apiCall(ctx: SendContext, url: string, headers: Record<string, string>, body: unknown, service: string, credential: string): Promise<SendResult> {
  try {
    const res = await ctx.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': userAgent('Notifications'), ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]),
    });
    const text = await res.text().catch(() => '');
    const outcome = classifyStatus(res.status);
    if (outcome === 'success') return { outcome, status: res.status };
    let detail = '';
    try {
      const j = JSON.parse(text) as Record<string, any>;
      detail = String(j.message ?? j.Message ?? j.errors?.[0]?.message ?? j.name ?? '').slice(0, 200);
    } catch {
      /* not JSON */
    }
    const auth = res.status === 401 || res.status === 403 ? ` (check ${credential})` : '';
    const ra = res.headers.get('retry-after');
    return { outcome, status: res.status, error: `${service} answered HTTP ${res.status}${detail ? `: ${detail}` : ''}${auth}`, ...(ra && /^\d+$/.test(ra) ? { retryAfterSeconds: Number(ra) } : {}) };
  } catch (e) {
    const err = e as Error;
    return { outcome: 'retry', error: `${service} not reachable: ${err.name === 'TimeoutError' ? `timed out after ${ctx.timeoutMs} ms` : err.message}` };
  }
}

export const resendProvider: NotificationProvider = {
  id: 'email:resend',
  channel: 'email',
  displayName: 'Email via Resend',
  configured: (e) => needFrom(e, [[e.resend.apiKey, 'notifications.email.resend.apiKey']]),
  send(ctx) {
    const m = mail(ctx);
    // Resend deduplicates on Idempotency-Key for 24 h: a retried attempt is not sent twice.
    return apiCall(ctx, `${ctx.email.resend.baseUrl}/emails`, { authorization: `Bearer ${ctx.email.resend.apiKey}`, 'idempotency-key': m.messageId }, { from: m.from, to: m.to, subject: m.subject, text: m.text, headers: messageIdHeaders(m.messageId) }, 'Resend', 'notifications.email.resend.apiKey');
  },
};

export const postmarkProvider: NotificationProvider = {
  id: 'email:postmark',
  channel: 'email',
  displayName: 'Email via Postmark',
  configured: (e) => needFrom(e, [[e.postmark.serverToken, 'notifications.email.postmark.serverToken']]),
  send(ctx) {
    const m = mail(ctx);
    return apiCall(
      ctx,
      `${ctx.email.postmark.baseUrl}/email`,
      { 'x-postmark-server-token': ctx.email.postmark.serverToken! },
      { From: m.from, To: m.to.join(','), Subject: m.subject, TextBody: m.text, MessageStream: ctx.email.postmark.messageStream, Headers: Object.entries(messageIdHeaders(m.messageId)).map(([Name, Value]) => ({ Name, Value })) },
      'Postmark',
      'notifications.email.postmark.serverToken'
    );
  },
};

export const sendgridProvider: NotificationProvider = {
  id: 'email:sendgrid',
  channel: 'email',
  displayName: 'Email via SendGrid',
  configured: (e) => needFrom(e, [[e.sendgrid.apiKey, 'notifications.email.sendgrid.apiKey']]),
  send(ctx) {
    const m = mail(ctx);
    return apiCall(
      ctx,
      `${ctx.email.sendgrid.baseUrl}/v3/mail/send`,
      { authorization: `Bearer ${ctx.email.sendgrid.apiKey}` },
      {
        personalizations: [{ to: m.to.map((email) => ({ email })) }],
        from: { email: m.from },
        subject: m.subject,
        content: [{ type: 'text/plain', value: m.text }],
        headers: messageIdHeaders(m.messageId),
      },
      'SendGrid',
      'notifications.email.sendgrid.apiKey'
    );
  },
};

/** SMTP (nodemailer): any mail server or relay; Mailpit in development and the Docker e2e. */
export const smtpProvider: NotificationProvider = {
  id: 'email:smtp',
  channel: 'email',
  displayName: 'Email via SMTP',
  configured: (e) => needFrom(e, [[e.smtp.host, 'notifications.email.smtp.host']]),
  async send(ctx) {
    const s = ctx.email.smtp;
    const m = mail(ctx);
    let nodemailer: typeof import('nodemailer');
    try {
      nodemailer = (await import('nodemailer')).default as unknown as typeof import('nodemailer');
    } catch (e) {
      return { outcome: 'failed', error: `nodemailer is not installed: ${(e as Error).message}` };
    }
    const transport = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.security === 'tls',
      requireTLS: s.security === 'starttls',
      ignoreTLS: s.security === 'none',
      ...(s.user ? { auth: { user: s.user, pass: s.password ?? '' } } : {}),
      connectionTimeout: ctx.timeoutMs,
      greetingTimeout: ctx.timeoutMs,
      socketTimeout: ctx.timeoutMs,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const abort = () => transport.close();
    ctx.signal.addEventListener('abort', abort, { once: true });
    try {
      const info = await transport.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, messageId: `<${m.messageId}@renderweld.local>`, headers: messageIdHeaders(m.messageId) });
      const code = Number(/^(\d{3})/.exec(String(info.response ?? ''))?.[1] ?? 250);
      return { outcome: 'success', status: code };
    } catch (e) {
      const err = e as Error & { code?: string; responseCode?: number; response?: string };
      const code = err.responseCode;
      // SMTP: 4xx is temporary (retry), 5xx permanent; auth failures never get better by repeating.
      const outcome: AttemptOutcome = err.code === 'EAUTH' || (code !== undefined && code >= 500) ? 'failed' : 'retry';
      const why = err.code === 'EAUTH' ? ' (check notifications.email.smtp.user / password)' : '';
      return { outcome, ...(code ? { status: code } : {}), error: `SMTP ${err.code ?? 'error'}: ${String(err.response ?? err.message).slice(0, 200)}${why}` };
    } finally {
      ctx.signal.removeEventListener('abort', abort);
      transport.close();
    }
  },
};

type SesSdk = typeof import('@aws-sdk/client-sesv2');
const sesClients = new Map<string, InstanceType<SesSdk['SESv2Client']>>();

/** Amazon SES (API v2 SendEmail) with keys from the settings or the ambient AWS identity. */
export const sesProvider: NotificationProvider = {
  id: 'email:ses',
  channel: 'email',
  displayName: 'Email via Amazon SES',
  configured: (e) => needFrom(e, [[e.ses.region, 'notifications.email.ses.region']]),
  async send(ctx) {
    const s = ctx.email.ses;
    const m = mail(ctx);
    let sdk: SesSdk;
    try {
      sdk = await import('@aws-sdk/client-sesv2');
    } catch (e) {
      return { outcome: 'failed', error: `@aws-sdk/client-sesv2 is not installed: ${(e as Error).message}` };
    }
    const sig = JSON.stringify([s.region, s.endpoint, s.accessKeyId, s.secretAccessKey, s.sessionToken]);
    let client = sesClients.get(sig);
    if (!client) {
      for (const c of sesClients.values()) c.destroy();
      sesClients.clear();
      client = new sdk.SESv2Client({
        region: s.region,
        // The outbox retries; the SDK must not retry inside one attempt.
        maxAttempts: 1,
        ...(s.endpoint ? { endpoint: s.endpoint } : {}),
        ...(s.accessKeyId && s.secretAccessKey ? { credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, ...(s.sessionToken ? { sessionToken: s.sessionToken } : {}) } } : {}),
      });
      sesClients.set(sig, client);
    }
    try {
      const r = await client.send(
        new sdk.SendEmailCommand({
          FromEmailAddress: m.from,
          Destination: { ToAddresses: m.to },
          Content: { Simple: { Subject: { Data: m.subject, Charset: 'UTF-8' }, Body: { Text: { Data: m.text, Charset: 'UTF-8' } }, Headers: Object.entries(messageIdHeaders(m.messageId)).map(([Name, Value]) => ({ Name, Value })) } },
        }),
        { abortSignal: AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]) as never }
      );
      return { outcome: 'success', status: r.$metadata.httpStatusCode ?? 200 };
    } catch (e) {
      const err = e as Error & { $metadata?: { httpStatusCode?: number }; name: string };
      const status = err.$metadata?.httpStatusCode;
      const outcome: AttemptOutcome = status === undefined ? 'retry' : err.name === 'TooManyRequestsException' ? 'retry' : classifyStatus(status);
      const auth = status === 401 || status === 403 || err.name === 'CredentialsProviderError' ? ' (check notifications.email.ses.* or the AWS identity: it needs ses:SendEmail)' : '';
      return { outcome: err.name === 'CredentialsProviderError' ? 'failed' : outcome, ...(status ? { status } : {}), error: `Amazon SES ${err.name}: ${err.message.slice(0, 200)}${auth}` };
    }
  },
};

export const BUILTIN_PROVIDERS: NotificationProvider[] = [webhookProvider, slackProvider, discordProvider, teamsProvider, smtpProvider, resendProvider, postmarkProvider, sesProvider, sendgridProvider];

export const EMAIL_PROVIDER_IDS: Record<EmailProviderId, string> = { smtp: 'email:smtp', resend: 'email:resend', postmark: 'email:postmark', ses: 'email:ses', sendgrid: 'email:sendgrid' };
