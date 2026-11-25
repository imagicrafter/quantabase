import type { CloudflareClient } from "./cloudflare-client.js";
import type { JsonObject } from "./merge.js";
import {
  CLAUDE_REDIRECT_URIS,
  type ApplicationStep,
  type Plan,
} from "./plan.js";

/**
 * After every step has succeeded: read the two applications back once and
 * say which of the settings that most often need a manual click are not in
 * place. The person gets one plain line for each, with where to click.
 *
 * READS ONLY. One list call, with the token the run already holds. Nothing is
 * written, and nothing here can turn a finished setup into a failed one: a
 * read that fails is reported as "could not be checked".
 *
 * What this cannot prove: that Cloudflare enforces a setting it shows (see
 * docs/security.md, section 7). It reports what the application holds.
 */

export type Check = {
  readonly id: "managed_oauth" | "claude_redirects" | "second_factor";
  /** ok: in place. missing: not in place. unknown: could not be read. */
  readonly state: "ok" | "missing" | "unknown";
  /** What it is, in a few words. */
  readonly title: string;
  /** Where to click when it is not in place. */
  readonly fix: string;
};

const WHERE =
  "In the Cloudflare dashboard: Zero Trust, Access controls, Applications";

const obj = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};

function appFor(
  apps: readonly unknown[],
  step: ApplicationStep,
): JsonObject | null {
  const found = apps
    .map(obj)
    .find((a) => a["type"] === "self_hosted" && a["domain"] === step.domain);
  return found ?? null;
}

function step(plan: Plan, id: ApplicationStep["id"]): ApplicationStep {
  const found = plan.steps.find(
    (s): s is ApplicationStep => s.kind === "application" && s.id === id,
  );
  if (!found) throw new Error("the plan has no " + id);
  return found;
}

type Verdicts = Readonly<Record<Check["id"], boolean>>;

function verdicts(
  engine: JsonObject | null,
  admin: JsonObject | null,
): Verdicts {
  const oauth = obj(engine?.["oauth_configuration"]);
  const registration = obj(oauth["dynamic_client_registration"]);
  const allowed = Array.isArray(registration["allowed_uris"])
    ? registration["allowed_uris"]
    : [];
  const mfa = obj(admin?.["mfa_config"]);
  const factors = Array.isArray(mfa["allowed_authenticators"])
    ? mfa["allowed_authenticators"]
    : [];
  return {
    managed_oauth:
      oauth["enabled"] === true && registration["enabled"] === true,
    claude_redirects: CLAUDE_REDIRECT_URIS.every((uri) =>
      allowed.includes(uri),
    ),
    second_factor:
      admin !== null && mfa["mfa_disabled"] !== true && factors.length > 0,
  };
}

function texts(
  plan: Plan,
  engine: JsonObject | null,
): Record<Check["id"], readonly [string, string]> {
  const engineName = String(step(plan, "engine_app").body["name"]);
  const adminName = String(step(plan, "admin_app").body["name"]);
  const registration = obj(
    obj(engine?.["oauth_configuration"])["dynamic_client_registration"],
  );
  const allowed = Array.isArray(registration["allowed_uris"])
    ? registration["allowed_uris"]
    : [];
  const lacking = CLAUDE_REDIRECT_URIS.filter((uri) => !allowed.includes(uri));
  return {
    managed_oauth: [
      "Managed OAuth on the hostname application (Claude connects through it)",
      `${WHERE}, "${engineName}", Edit, Additional settings, OAuth: switch Managed OAuth on. Save.`,
    ],
    claude_redirects: [
      "Claude's redirect addresses on the allowed list",
      `${WHERE}, "${engineName}", Edit, Additional settings, OAuth, Allowed redirect URIs: add ${lacking.join(" and ")}. Save.`,
    ],
    second_factor: [
      "A second factor on /status and /setup",
      `${WHERE}, "${adminName}", Edit: require a second factor (authenticator app, biometrics or security key) for this application. Save.`,
    ],
  };
}

const ORDER: readonly Check["id"][] = [
  "managed_oauth",
  "claude_redirects",
  "second_factor",
];

/** Read the applications back. Never throws; makes no write. */
export async function readBack(
  client: CloudflareClient,
  accountId: string,
  plan: Plan,
): Promise<readonly Check[]> {
  let apps: readonly unknown[] | null;
  try {
    apps = await client.list(["accounts", accountId, "access", "apps"]);
  } catch {
    apps = null; // the error is dropped: it is not for a page or a log
  }
  const engine = apps ? appFor(apps, step(plan, "engine_app")) : null;
  const admin = apps ? appFor(apps, step(plan, "admin_app")) : null;
  const found = verdicts(engine, admin);
  const words = texts(plan, engine);
  return ORDER.map((id) => ({
    id,
    state: apps === null ? "unknown" : found[id] ? "ok" : "missing",
    title: words[id][0],
    fix: words[id][1],
  }));
}
