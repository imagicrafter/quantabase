import type { AccessSettings } from "../../config/settings.js";

/**
 * RFC 9728 `oauth-protected-resource` metadata. Points an MCP client (Claude) at
 * the Cloudflare Access application that issues tokens for this resource server.
 *
 * NOTE: empirically verified 2026-08-18 (plan Step 3) that Cloudflare Access serves
 * this document itself at the edge — both `/.well-known/oauth-protected-resource`
 * and the `/mcp`-suffixed form — on the application hostname, for ANY request,
 * without reaching this origin at all. This route is kept as a defensive fallback
 * only, in case that edge behavior ever changes; it is not expected to be hit in
 * production.
 */
export type ProtectedResourceMetadata = {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly bearer_methods_supported: readonly string[];
};

/**
 * Build the discovery document from the sign-in settings. Throws when there
 * are none, so an Engine that is not set up fails loudly rather than
 * advertising an empty document.
 *
 * No `scopes_supported` — authorization here is domain-based (resolved against
 * `workspace.principals` and `workspace.access_grants`), not OAuth-scope-based, and
 * Cloudflare Access does not register application-specific scopes for DCR clients.
 */
export function buildProtectedResourceMetadata(
  access: AccessSettings | null,
): ProtectedResourceMetadata {
  if (!access) {
    throw new Error(
      "Access not configured: no sign-in settings to serve the protected-resource document",
    );
  }

  return {
    resource: access.resourceUrl,
    authorization_servers: [access.teamDomain],
    bearer_methods_supported: ["header"],
  };
}
