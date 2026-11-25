import { TOKEN_PERMISSIONS, type TokenPermission } from "./permissions.js";

/**
 * The link that opens Cloudflare's "create API token" screen with the four
 * permissions already picked.
 *
 * Cloudflare documents this link ("API token template URLs"):
 * https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
 *
 * What the documentation gives, and so what this uses:
 *   - the user-token form, https://dash.cloudflare.com/profile/api-tokens
 *   - permissionGroupKeys: a JSON list of { key, type }, URL-encoded
 *   - accountId and zoneId: required; "*" and "all" are the documented values
 *   - name: the token's name
 *
 * What it does not give: a way to limit the token to one zone or one account
 * from the link, or to set an end date. The person sets those on the screen.
 * A key Cloudflare does not know is dropped without a message, so the person
 * is always told to check that all four permissions are listed.
 *
 * scripts/kbe/cloudflare_token_link.py builds the same link for the command
 * line; a test there compares the two.
 */

const BASE = "https://dash.cloudflare.com/profile/api-tokens";

/** Cloudflare's short key for each permission (the "Permission reference" tables). */
export const TOKEN_LINK_KEYS: Readonly<Record<TokenPermission["id"], string>> =
  {
    apps: "access",
    organization: "access_acct",
    dns: "dns",
    zone: "zone",
  };

export const TOKEN_LINK_NAME = "KB Engine setup - delete after use";

export function tokenLink(): string {
  const keys = TOKEN_PERMISSIONS.map((p) => ({
    key: TOKEN_LINK_KEYS[p.id],
    type: p.level === "Read" ? "read" : "edit",
  }));
  const query = [
    `permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}`,
    "accountId=%2A",
    "zoneId=all",
    `name=${encodeURIComponent(TOKEN_LINK_NAME)}`,
  ].join("&");
  return `${BASE}?${query}`;
}
