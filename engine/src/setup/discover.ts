import { z } from "zod";
import { CloudflareError, type CloudflareClient } from "./cloudflare-client.js";
import { permissionLabel, type TokenPermission } from "./permissions.js";

/**
 * Before anything is changed: check the token works, find the zone and the
 * account the hostname belongs to, and check the token can at least read
 * each of the areas setup will write to.
 *
 * Cloudflare offers no way for a token to list its own permissions without a
 * further permission, so write access cannot be proven here. A token that can
 * read but not write is caught at the first write, which names the missing
 * permission and changes nothing.
 *
 * Every sub-check leaves a line in `details` (route, HTTP status, Cloudflare's
 * error codes and words, the token scrubbed out by the client), so a failure
 * says exactly which check failed. Never the token itself.
 */

/** A problem a person can act on. The message is shown to them as is. */
export class SetupStepError extends Error {
  /** A fixed word for a problem the command line has its own words for. */
  readonly code?: string;
  /** What each sub-check saw, for the log and the page. Never a secret. */
  readonly details: readonly string[];
  constructor(message: string, code?: string, details: readonly string[] = []) {
    super(message);
    this.name = "SetupStepError";
    if (code) this.code = code;
    this.details = details;
  }
}

const HexId = z.string().regex(/^[a-f0-9]{32}$/i);

const Zone = z.object({
  id: HexId,
  name: z.string(),
  account: z.object({ id: HexId }),
});
type Zone = z.infer<typeof Zone>;

export type Discovery = {
  readonly accountId: string;
  readonly zoneId: string;
  readonly zoneName: string;
  readonly warnings: readonly string[];
};

const TOKEN_REFUSED =
  "Cloudflare did not accept this token. Check that all of it was copied and that it has not expired.";

/** engine.sub.example.com -> itself, sub.example.com, example.com. */
export function zoneCandidates(host: string): readonly string[] {
  const labels = host.split(".");
  return labels
    .slice(0, Math.max(labels.length - 1, 1))
    .map((_, i) => labels.slice(i).join("."));
}

/** "401 [1000] Invalid API Token": what Cloudflare said, no token. */
function said(err: CloudflareError): string {
  const codes = err.codes.length > 0 ? ` [${err.codes.join(",")}]` : "";
  const words = err.message.replace(/^Cloudflare answered \d+:?\s*/, "");
  return `${err.status || err.kind}${codes}${words ? ` ${words}` : ""}`;
}

/** Network trouble and running out of time are not answers: pass them on. */
function rethrowUnlessAnswer(err: unknown): asserts err is CloudflareError {
  if (!(err instanceof CloudflareError)) throw err;
  if (err.kind === "network" || err.kind === "timeout") throw err;
}

type ZoneSearch = {
  readonly zone: Zone | null;
  readonly details: readonly string[];
  /** Cloudflare refused the token outright (401) on the zone list. */
  readonly refused: boolean;
  /** A zone call was refused with code 9109 (seen live with a future start date). */
  readonly code9109?: boolean;
};

/** Cloudflare's "Unauthorized to access requested resource". */
const NOT_ALLOWED_YET = 9109;

async function findZone(
  client: CloudflareClient,
  host: string,
): Promise<ZoneSearch> {
  const details: string[] = [];
  let code9109 = false;
  for (const name of zoneCandidates(host)) {
    try {
      const found = await client.list(["zones"], { name });
      const zone = found
        .map((item) => Zone.safeParse(item))
        .find((parsed) => parsed.success && parsed.data.name === name);
      if (zone?.success) return { zone: zone.data, details, refused: false, code9109 };
      details.push(`zones?name=${name}: no match`);
    } catch (err) {
      rethrowUnlessAnswer(err);
      details.push(`zones?name=${name}: ${said(err)}`);
      if (err.codes.includes(NOT_ALLOWED_YET)) code9109 = true;
      if (err.kind === "auth") return { zone: null, details, refused: true, code9109 };
      if (err.kind !== "forbidden") throw err;
    }
  }
  return { zone: null, details, refused: false, code9109 };
}

const Status = z.object({ status: z.string() });

type Verified = { readonly active: boolean; readonly detail: string };

async function verifyOn(
  client: CloudflareClient,
  path: readonly string[],
  label: string,
): Promise<Verified> {
  try {
    const parsed = Status.safeParse(await client.get(path));
    if (!parsed.success)
      return { active: false, detail: `${label}: unreadable answer` };
    return parsed.data.status === "active"
      ? { active: true, detail: `${label}: active` }
      : { active: false, detail: `${label}: status ${parsed.data.status}` };
  } catch (err) {
    rethrowUnlessAnswer(err);
    return { active: false, detail: `${label}: ${said(err)}` };
  }
}

const USER_VERIFY = ["user", "tokens", "verify"] as const;
const USER_LABEL = "user/tokens/verify";
const ACCOUNT_LABEL = "accounts/.../tokens/verify";

/**
 * A token made under My Profile (cfut_...) is verified on the user route; one
 * made under the account (cfat_...) gets 401 there and is verified on the
 * account route. So a refusal on one route is not yet a bad token.
 */
async function tokenIsActive(
  client: CloudflareClient,
  accountId: string,
  user: Verified,
): Promise<readonly Verified[]> {
  if (user.active) return [user];
  const account = await verifyOn(
    client,
    ["accounts", accountId, "tokens", "verify"],
    ACCOUNT_LABEL,
  );
  return [user, account];
}

type Lack = { readonly id: TokenPermission["id"]; readonly detail: string };

/** The permission a read needs, or null when the read was allowed. */
async function missing(
  id: TokenPermission["id"],
  label: string,
  read: () => Promise<unknown>,
): Promise<Lack | null> {
  try {
    await read();
    return null;
  } catch (err) {
    rethrowUnlessAnswer(err);
    if (err.kind === "forbidden" || err.kind === "auth")
      return { id, detail: `${label}: ${said(err)}` };
    // Not found (no Zero Trust team yet) is dealt with by its own step.
    if (err.kind === "not_found") return null;
    throw err;
  }
}

async function missingPermissions(
  client: CloudflareClient,
  zone: Zone,
  host: string,
): Promise<readonly Lack[]> {
  const account = ["accounts", zone.account.id, "access"];
  const one = { per_page: "1" };
  const checks = await Promise.all([
    missing("apps", "access/apps", () =>
      client.get([...account, "apps"], one),
    ),
    missing("apps", "access/policies", () =>
      client.get([...account, "policies"], one),
    ),
    missing("organization", "access/organizations", () =>
      client.get([...account, "organizations"]),
    ),
    missing("organization", "access/identity_providers", () =>
      client.get([...account, "identity_providers"], one),
    ),
    missing("dns", "dns_records", () =>
      client.get(["zones", zone.id, "dns_records"], { ...one, name: host }),
    ),
  ]);
  return checks.filter((lack): lack is Lack => lack !== null);
}

async function breadthWarnings(
  client: CloudflareClient,
): Promise<readonly string[]> {
  try {
    const zones = await client.get(["zones"], { per_page: "5" });
    return Array.isArray(zones) && zones.length > 1
      ? [
          "This token can reach more than one zone. It works, but a token limited to the one zone is safer. Delete it when setup is done.",
        ]
      : [];
  } catch {
    return [];
  }
}

function zoneMissing(host: string, details: readonly string[], code9109 = false): SetupStepError {
  // Live 2026-11-20: verify said active, but every zone call answered 403
  // [9109] because the token's start date (TTL "Start date") was in the future.
  const startDate = code9109
    ? " Cloudflare answered 9109 (not allowed): check the token's start date in its TTL settings (a start date in the future causes this; leave it empty), and that it has Zone Read for this zone."
    : "";
  return new SetupStepError(
    `The token cannot see a Cloudflare zone for ${host}. The domain must be on this Cloudflare account, and the token needs ${permissionLabel("zone")} and ${permissionLabel("dns")} for that zone (Zone policy card, Specific zone).${startDate}`,
    "zone_not_found",
    details,
  );
}

export async function discover(
  client: CloudflareClient,
  host: string,
): Promise<Discovery> {
  const user = await verifyOn(client, USER_VERIFY, USER_LABEL);
  const search = await findZone(client, host);
  const zone = search.zone;
  if (!zone) {
    const details = [user.detail, ...search.details];
    if (search.refused && !user.active)
      throw new SetupStepError(TOKEN_REFUSED, "token_inactive", details);
    throw zoneMissing(host, details, search.code9109 === true);
  }

  const verified = await tokenIsActive(client, zone.account.id, user);
  const verifyDetails = verified.map((v) => v.detail);
  if (!verified.some((v) => v.active))
    throw new SetupStepError(TOKEN_REFUSED, "token_inactive", [
      ...verifyDetails,
      ...search.details,
    ]);

  const lacking = await missingPermissions(client, zone, host);
  if (lacking.length > 0) {
    const ids = [...new Set(lacking.map((l) => l.id))];
    throw new SetupStepError(
      `The token is missing: ${ids.map(permissionLabel).join("; ")}. Make a new token with the permissions listed on the setup page.`,
      "missing_permission",
      [...verifyDetails, ...lacking.map((l) => l.detail)],
    );
  }

  return {
    accountId: zone.account.id,
    zoneId: zone.id,
    zoneName: zone.name,
    warnings: await breadthWarnings(client),
  };
}
