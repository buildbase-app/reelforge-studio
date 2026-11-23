import { createHash } from 'node:crypto';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { BrokerListener, brokerError, readyBody, type BrokerDelivery } from './dispatch-broker';
import type { DispatchPublisher } from './dispatch';

/**
 * `queue.dispatch: sqs` (D-105): job ids on an Amazon SQS standard queue.
 *
 * The outbox relay sends `r:<job id>` bodies (SendMessageBatch, 10 per call).
 * Workers long-poll (ReceiveMessage, WaitTimeSeconds 20) with the queue's
 * visibility timeout set per receive (queue.sqs.visibilityTimeoutSeconds),
 * wake their ordinary claim and delete the message once that claim ran
 * (dispatch-broker.ts has the semantics). A worker that dies after its claim
 * and before the delete leaves the message invisible until the timeout; then
 * another worker receives it, its claim finds nothing new, and it deletes it.
 *
 * Credentials: queue.sqs.accessKeyId/secretAccessKey/sessionToken when set
 * (secrets: `_FILE` or encrypted runtime settings), else the AWS default
 * chain (IAM role, IRSA / web identity, AWS_* variables). They are read on
 * every call and the client is rebuilt when they change, so a rotated key set
 * at runtime applies without a restart.
 */
export interface SqsDispatchConfig {
  queueUrl?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  visibilityTimeoutSeconds: number;
  /** Long-poll wait (1..20 s). Default 20. */
  waitTimeSeconds?: number;
}

/** The region of a queue URL (https://sqs.<region>.amazonaws.com/<account>/<name>), if it names one. */
export function sqsRegionFromUrl(queueUrl: string | undefined): string | undefined {
  if (!queueUrl) return undefined;
  try {
    const host = new URL(queueUrl).hostname;
    return /^sqs[.-]([a-z0-9-]+)\.amazonaws\.com(\.cn)?$/.exec(host)?.[1] ?? /^([a-z]{2}(-gov)?-[a-z]+-\d)\.queue\.amazonaws\.com$/.exec(host)?.[1] ?? /^sqs\.([a-z0-9-]+)\.localhost\.localstack\.cloud$/.exec(host)?.[1];
  } catch {
    return undefined;
  }
}

/** Holds an SQS client for the current settings; rebuilt when the endpoint, region or credentials change. */
class SqsClients {
  private client: SQSClient | null = null;
  private fp = '';
  constructor(private readonly cfg: () => SqsDispatchConfig) {}

  get(): { sqs: SQSClient; queueUrl: string; c: SqsDispatchConfig } {
    const c = this.cfg();
    if (!c.queueUrl) throw new Error('queue.sqs.queueUrl is not set');
    const region = c.region ?? sqsRegionFromUrl(c.queueUrl);
    const creds = c.accessKeyId && c.secretAccessKey ? { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}) } : undefined;
    // A fingerprint, not the values: the key itself is never kept outside the settings.
    const fp = createHash('sha256').update(JSON.stringify([region, c.endpoint, creds])).digest('hex');
    if (!this.client || fp !== this.fp) {
      this.client?.destroy();
      this.client = new SQSClient({
        ...(region ? { region } : {}),
        ...(c.endpoint ? { endpoint: c.endpoint } : {}),
        ...(creds ? { credentials: creds } : {}),
        // The relay and the listener retry with their own backoff.
        maxAttempts: 2,
      });
      this.fp = fp;
    }
    return { sqs: this.client, queueUrl: c.queueUrl, c };
  }

  close() {
    this.client?.destroy();
    this.client = null;
  }
}

export class SqsDispatchPublisher implements DispatchPublisher {
  readonly driver = 'sqs';
  private readonly clients: SqsClients;
  constructor(cfg: () => SqsDispatchConfig) {
    this.clients = new SqsClients(cfg);
  }

  async publish(jobIds: string[]): Promise<void> {
    const { sqs, queueUrl } = this.clients.get();
    for (let i = 0; i < jobIds.length; i += 10) {
      const chunk = jobIds.slice(i, i + 10);
      const out = await sqs.send(new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: chunk.map((id, n) => ({ Id: String(n), MessageBody: readyBody(id) })) }));
      // A partial failure retries the whole batch (duplicates are no-ops on the worker side).
      if (out.Failed?.length) throw new Error(`SQS refused ${out.Failed.length} of ${chunk.length} messages: ${out.Failed[0]!.Code ?? ''} ${out.Failed[0]!.Message ?? ''}`.trim());
    }
  }

  async close(): Promise<void> {
    this.clients.close();
  }
}

export class SqsDispatchListener extends BrokerListener {
  readonly driver = 'sqs';
  private readonly clients: SqsClients;
  private abort = new AbortController();

  constructor(
    cfg: () => SqsDispatchConfig,
    opts: { log?: (level: 'info' | 'warn' | 'error', line: string) => void } = {}
  ) {
    super({ redeliverAfterMs: cfg().visibilityTimeoutSeconds * 1000, maxBatch: 10, ...(opts.log ? { log: opts.log } : {}) });
    this.clients = new SqsClients(cfg);
  }

  protected async connect(): Promise<void> {
    const { sqs, queueUrl } = this.clients.get();
    // Checks the credentials and that the queue exists.
    await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['VisibilityTimeout'] }), { abortSignal: this.abort.signal });
  }

  protected async receive(max: number): Promise<BrokerDelivery[]> {
    const { sqs, queueUrl, c } = this.clients.get();
    const out = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: Math.max(1, Math.min(10, max)),
        WaitTimeSeconds: Math.max(1, Math.min(20, c.waitTimeSeconds ?? 20)),
        VisibilityTimeout: c.visibilityTimeoutSeconds,
      }),
      { abortSignal: this.abort.signal }
    );
    return (out.Messages ?? []).filter((m) => m.ReceiptHandle && m.Body).map((m) => ({ handle: m.ReceiptHandle!, body: m.Body! }));
  }

  protected async acknowledge(d: BrokerDelivery): Promise<void> {
    const { sqs, queueUrl } = this.clients.get();
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: d.handle })).catch((e) => this.base.log?.('warn', `dispatch: could not delete an SQS message (${brokerError(e)}); it comes back after the visibility timeout and is a no-op then`));
  }

  protected async giveBack(d: BrokerDelivery): Promise<void> {
    const { sqs, queueUrl } = this.clients.get();
    await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: d.handle, VisibilityTimeout: 0 })).catch(() => undefined);
  }

  protected async close(): Promise<void> {
    this.abort.abort();
    this.clients.close();
  }
}
