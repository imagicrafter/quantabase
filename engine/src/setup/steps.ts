import { z } from "zod";
import { CloudflareError, type CloudflareClient } from "./cloudflare-client.js";
import { SetupStepError } from "./discover.js";
import { mergeDeep, without } from "./merge.js";
import type { DnsStep, OrganizationStep, PlanStep } from "./plan.js";
import { ensureApplication, ensurePolicy } from "./steps-access.js";
import {
  asObject,
  HOW_TO_REPLACE,
  Id,
  READ_ONLY,
  SETUP_MARK,
  type ApplyContext,
  type StepOutcome,
} from "./steps-shared.js";

/**
 * One function per kind of step. Each looks for the thing first and only
 * writes when it is missing or different, so running setup twice makes
 * nothing twice. Cloudflare's PUT replaces the whole object, so an update is
 * always: read it, lay the wanted fields over it, write the result.
 * (The sign-in rules and applications are in steps-access.ts.)
 */

export type { ApplyContext, StepOutcome, StepStatus } from "./steps-shared.js";

const NO_TEAM =
  "Zero Trust has never been opened on this Cloudflare account, so it has no team name. Nothing was created. In the Cloudflare dashboard, open Zero Trust once, pick a team name and the free plan, then run setup again.";

// ── organization ────────────────────────────────────────────────────────────

const Organization = z
  .object({
    auth_domain: z.string().regex(/^[a-z0-9-]+\.cloudflareaccess\.com$/),
    mfa_config: z
      .object({ allowed_authenticators: z.array(z.string()).nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

async function readOrganization(client: CloudflareClient, accountId: string) {
  let raw: unknown;
  try {
    raw = await client.get(["accounts", accountId, "access", "organizations"]);
  } catch (err) {
    if (err instanceof CloudflareError && err.kind === "not_found")
      throw new SetupStepError(NO_TEAM, "no_team");
    throw err;
  }
  const parsed = Organization.safeParse(raw);
  if (!parsed.success) throw new SetupStepError(NO_TEAM, "no_team");
  return parsed.data;
}

async function ensureOrganization(
  client: CloudflareClient,
  context: ApplyContext,
  step: OrganizationStep,
): Promise<StepOutcome> {
  const org = await readOrganization(client, context.accountId);
  const teamDomain = `https://${org.auth_domain}`;
  const already = (org.mfa_config?.allowed_authenticators ?? []).filter((a) =>
    step.authenticators.includes(a),
  );
  if (already.length > 0) {
    return {
      status: "unchanged",
      context: { ...context, teamDomain, authenticators: already },
    };
  }
  const body = mergeDeep(without(asObject(org), READ_ONLY), {
    mfa_config: {
      allowed_authenticators: [...step.authenticators],
      session_duration: step.sessionDuration,
    },
  });
  await client.send(
    "PUT",
    ["accounts", context.accountId, "access", "organizations"],
    body,
  );
  return {
    status: "updated",
    context: { ...context, teamDomain, authenticators: step.authenticators },
  };
}

// ── one-time PIN ────────────────────────────────────────────────────────────

const LoginMethod = z.object({ id: Id, type: z.string() });

async function ensureLoginMethod(
  client: CloudflareClient,
  context: ApplyContext,
): Promise<StepOutcome> {
  const path = ["accounts", context.accountId, "access", "identity_providers"];
  const existing = (await client.list(path))
    .map((item) => LoginMethod.safeParse(item))
    .find((parsed) => parsed.success && parsed.data.type === "onetimepin");
  if (existing?.success) {
    return {
      status: "unchanged",
      context: { ...context, loginMethodId: existing.data.id },
    };
  }
  const created = LoginMethod.parse(
    await client.send("POST", path, {
      name: "One-time PIN",
      type: "onetimepin",
      config: {},
    }),
  );
  return {
    status: "created",
    context: { ...context, loginMethodId: created.id },
  };
}

// ── DNS ─────────────────────────────────────────────────────────────────────

const DnsRecord = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/i),
  type: z.string(),
  name: z.string(),
  content: z.string().optional(),
  proxied: z.boolean().optional(),
  comment: z.string().nullish(),
});

async function ensureDns(
  client: CloudflareClient,
  context: ApplyContext,
  step: DnsStep,
): Promise<StepOutcome> {
  const path = ["zones", context.zoneId, "dns_records"];
  const records = (await client.list(path, { name: step.name }))
    .map((item) => DnsRecord.parse(item))
    .filter((record) => record.name.toLowerCase() === step.name);
  const wanted = {
    type: "CNAME",
    name: step.name,
    content: step.target,
    proxied: true,
    comment: SETUP_MARK,
  };

  if (records.length === 0) {
    await client.send("POST", path, { ...wanted, ttl: 1 });
    return { status: "created", context };
  }
  const [record] = records;
  if (records.length > 1 || !record || record.type !== "CNAME") {
    throw new SetupStepError(
      `${step.name} already has DNS records of another kind. Remove them in Cloudflare DNS, then run setup again.`,
    );
  }
  const content = (record.content ?? "").toLowerCase().replace(/\.$/, "");
  if (content === step.target && record.proxied === true)
    return { status: "unchanged", context };
  // A record that points somewhere else is repointed only when it is setup's
  // own, or when the person asked for it.
  const mine = record.comment === SETUP_MARK;
  if (content !== step.target && !mine && !step.replaceExisting) {
    throw new SetupStepError(
      `${step.name} already points somewhere else in Cloudflare DNS. ${HOW_TO_REPLACE}`,
    );
  }
  await client.send("PATCH", [...path, record.id], wanted);
  return { status: "updated", context };
}

/** Carry out one step of the plan. */
export function runStep(
  client: CloudflareClient,
  context: ApplyContext,
  step: PlanStep,
): Promise<StepOutcome> {
  switch (step.kind) {
    case "organization":
      return ensureOrganization(client, context, step);
    case "login_method":
      return ensureLoginMethod(client, context);
    case "dns":
      return ensureDns(client, context, step);
    case "policy":
      return ensurePolicy(client, context, step);
    case "application":
      return ensureApplication(client, context, step);
  }
}
