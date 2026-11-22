export interface MockLicenceKey {
  key: string;
  /** null: unlimited. Default 1. */
  activationLimit?: number | null;
  status?: 'active' | 'revoked' | 'expired' | 'not_yet';
  expiresAt?: string | null;
  /** Instances that already hold an activation. */
  activations?: string[];
}

export interface MockLicenceRequest {
  op: 'validate' | 'activate' | 'deactivate';
  org: string;
  /** Body field names (never values). */
  fields: string[];
  /** Request header names. */
  headers: string[];
  instance: string | null;
}

export interface MockLicenceServer {
  url: string;
  port: number;
  orgId: string;
  requests: MockLicenceRequest[];
  addKey(k: MockLicenceKey): void;
  revoke(key: string): void;
  /** normal | rate_limited (429 LICENSE_CHECKS_LIMITED) | error (503) | drop (connection reset) */
  setMode(mode: 'normal' | 'rate_limited' | 'error' | 'drop'): void;
  activations(key: string): string[];
  /** Requests seen per operation. */
  counts(): { activate: number; validate: number; deactivate: number };
  close(): Promise<void>;
}

export function startMockLicenceServer(opts?: { port?: number; host?: string; orgId?: string; keys?: MockLicenceKey[] }): Promise<MockLicenceServer>;
