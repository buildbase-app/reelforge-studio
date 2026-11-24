/**
 * The product's public names (#413, phase 4 of the rename #408; docs/RENAMED.md).
 * ReelForge is now RenderWeld. Every public surface takes its name from here;
 * the old names stay listed or sent next to the new ones until the aliases are
 * removed (phase 7, #416). Data keys (database, storage, the settings
 * encryption salt) never change.
 */

/** The product name in messages, titles and labels. */
export const PRODUCT_NAME = 'RenderWeld';

/** The MCP server name (initialize, /.well-known/mcp.json) and get_capabilities `server.name`. */
export const SERVER_NAME = 'renderweld';
/** The server's human title (MCP initialize and the server card). */
export const SERVER_TITLE = PRODUCT_NAME;
/** Old server names, listed under `aliases` so a client that matched on them can still find the server. */
export const OLD_SERVER_NAMES: readonly string[] = ['reelforge-studio'];

/** What sends an outbound request. */
export type UserAgentComponent = 'Webhooks' | 'Notifications' | 'Asset-Fetch' | 'Licence' | 'Providers';

/** The old User-Agent product token of each sender that had one before the rename. */
const OLD_USER_AGENT: Partial<Record<UserAgentComponent, string>> = {
  Webhooks: 'ReelForge-Studio-Webhooks/1',
  Notifications: 'ReelForge-Studio-Notifications/1',
  'Asset-Fetch': 'reelforge-studio-asset-fetch',
};

/**
 * The default User-Agent of an outbound request: the RenderWeld product token
 * first, then the old token where there was one (RFC 9110 allows several
 * product tokens), so a receiver that filters on the old value keeps matching
 * until phase 7.
 */
export function userAgent(component: UserAgentComponent): string {
  const old = OLD_USER_AGENT[component];
  return old ? `${PRODUCT_NAME}-${component}/1 ${old}` : `${PRODUCT_NAME}-${component}/1`;
}
