/**
 * The product's public names (#413). Every public surface takes its name from
 * here. Data keys (database, storage, the settings encryption salt) never
 * change.
 */

/** The product name in messages, titles and labels. */
export const PRODUCT_NAME = 'RenderWeld';

/** The MCP server name (initialize, /.well-known/mcp.json) and get_capabilities `server.name`. */
export const SERVER_NAME = 'renderweld';
/** The server's human title (MCP initialize and the server card). */
export const SERVER_TITLE = PRODUCT_NAME;

/** What sends an outbound request. */
export type UserAgentComponent = 'Webhooks' | 'Notifications' | 'Asset-Fetch' | 'Licence' | 'Providers';

/** The default User-Agent of an outbound request, e.g. `RenderWeld-Webhooks/1`. */
export function userAgent(component: UserAgentComponent): string {
  return `${PRODUCT_NAME}-${component}/1`;
}
