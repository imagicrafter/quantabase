import { env } from "../env.js";
import { McpAppError } from "../mcp/errors.js";

// The engine should only ever reach the Supabase project host and the
// Cloudflare Access team domain (for the AS-metadata proxy in index.ts).
// One more host is allowed only when a setup code is configured: the
// Cloudflare API, which the setup page calls with the owner's one-time token
// (setup/cloudflare-client.ts, which itself refuses every other host).
// App Platform has no egress restriction (platform constraint 5 in the plan).
// This allowlist enforces it in code.
//
// Notably absent: any identity provider's API. Sign-in is verified from the
// Cloudflare Access assertion alone; the engine holds no identity-provider API
// key and never calls one.
//
// Supabase Network Restrictions do not apply to the HTTPS API path — only to
// direct Postgres and the pooler. Enforcement in the HTTP client is the only
// available control.

const CLOUDFLARE_API_HOST = "api.cloudflare.com";

let allowedHosts: Set<string> | null = null;

function getAllowedHosts(): Set<string> {
  if (allowedHosts) return allowedHosts;

  const supabaseHost = new URL(env.SUPABASE_URL).hostname;
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  allowedHosts = new Set([
    supabaseHost,
    ...(teamDomain ? [new URL(teamDomain).hostname] : []),
    ...(env.SETUP_CODE ? [CLOUDFLARE_API_HOST] : []),
  ]);
  return allowedHosts;
}

/**
 * Allow one more host. Used for the sign-in team domain when it comes from the
 * stored settings instead of the environment (see config/settings.ts); nothing
 * else should call this.
 */
export function allowOutboundHost(hostname: string): void {
  allowedHosts = new Set([...getAllowedHosts(), hostname]);
}

/**
 * Wrap the global fetch to reject any request to a host outside the allowlist.
 * Call once at application startup.
 */
export function installOutboundAllowlist(): void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function restrictedFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    let url: URL;
    try {
      url = new URL(
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString(),
      );
    } catch {
      throw new McpAppError("internal_error", "Invalid outbound URL");
    }

    const allowed = getAllowedHosts();
    if (!allowed.has(url.hostname)) {
      throw new McpAppError(
        "internal_error",
        `Outbound request to ${url.hostname} is not allowed`,
      );
    }

    return originalFetch(input, init);
  };
}
