import { describe, expect, it } from 'vitest';
import { OLD_SERVER_NAMES, PRODUCT_NAME, SERVER_NAME, SERVER_TITLE, userAgent } from '../src/index';

/** The product's public names after the rename (#413, docs/RENAMED.md). */
describe('product names', () => {
  it('names RenderWeld and keeps the old server name as an alias', () => {
    expect(PRODUCT_NAME).toBe('RenderWeld');
    expect(SERVER_NAME).toBe('renderweld');
    expect(SERVER_TITLE).toBe('RenderWeld');
    expect(OLD_SERVER_NAMES).toEqual(['reelforge-studio']);
  });

  it('outbound User-Agents: the RenderWeld token first, then the old token where there was one', () => {
    expect(userAgent('Webhooks')).toBe('RenderWeld-Webhooks/1 ReelForge-Studio-Webhooks/1');
    expect(userAgent('Notifications')).toBe('RenderWeld-Notifications/1 ReelForge-Studio-Notifications/1');
    expect(userAgent('Asset-Fetch')).toBe('RenderWeld-Asset-Fetch/1 reelforge-studio-asset-fetch');
    expect(userAgent('Licence')).toBe('RenderWeld-Licence/1');
    expect(userAgent('Providers')).toBe('RenderWeld-Providers/1');
    // RFC 9110 product tokens: token ["/" version], separated by spaces.
    for (const c of ['Webhooks', 'Notifications', 'Asset-Fetch', 'Licence', 'Providers'] as const) {
      expect(userAgent(c)).toMatch(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+(\/[A-Za-z0-9!#$%&'*+.^_`|~-]+)?( [A-Za-z0-9!#$%&'*+.^_`|~-]+(\/[A-Za-z0-9!#$%&'*+.^_`|~-]+)?)*$/);
    }
  });
});
