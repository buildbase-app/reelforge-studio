import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME, SERVER_NAME, SERVER_TITLE, userAgent } from '../src/index';

/** The product's public names (#413). */
describe('product names', () => {
  it('names RenderWeld', () => {
    expect(PRODUCT_NAME).toBe('RenderWeld');
    expect(SERVER_NAME).toBe('renderweld');
    expect(SERVER_TITLE).toBe('RenderWeld');
  });

  it('outbound User-Agents are one RenderWeld product token each', () => {
    expect(userAgent('Webhooks')).toBe('RenderWeld-Webhooks/1');
    expect(userAgent('Notifications')).toBe('RenderWeld-Notifications/1');
    expect(userAgent('Asset-Fetch')).toBe('RenderWeld-Asset-Fetch/1');
    expect(userAgent('Licence')).toBe('RenderWeld-Licence/1');
    expect(userAgent('Providers')).toBe('RenderWeld-Providers/1');
    // RFC 9110 product token: token ["/" version].
    for (const c of ['Webhooks', 'Notifications', 'Asset-Fetch', 'Licence', 'Providers'] as const) {
      expect(userAgent(c)).toMatch(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);
    }
  });
});
