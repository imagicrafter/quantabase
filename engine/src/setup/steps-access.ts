import { z } from "zod";
import type { CloudflareClient } from "./cloudflare-client.js";
import { SetupStepError } from "./discover.js";
import {
  contains,
  isSet,
  mergeDeep,
  only,
  sameItems,
  type Json,
  type JsonObject,
} from "./merge.js";
import type { ApplicationStep, PolicyStep } from "./plan.js";
import {
  asObject,
  HOW_TO_REPLACE,
  Id,
  type ApplyContext,
  type StepOutcome,
} from "./steps-shared.js";

/**
 * The sign-in rules and the two applications.
 *
 * These decide who gets in, so an existing one is never trusted to be right
 * just because its list matches. Anything on it that could weaken sign-in
 * (a rule that switches the second factor off, a long session, open
 * cross-origin settings on an application) makes it "different", and the
 * rewrite drops it: a rule is written back with exactly the wanted fields,
 * an application keeps only its cosmetic ones.
 */

// ── sign-in rules ───────────────────────────────────────────────────────────

const Named = z.object({ id: Id, name: z.string().optional() }).passthrough();
const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  (Array.isArray(value) && value.length === 0);

/** Rule fields that change what the rule demands. None of them is wanted. */
const POLICY_EXTRAS = [
  "mfa_config",
  "approval_required",
  "approval_groups",
  "isolation_required",
  "purpose_justification_required",
  "connection_rules",
];

function policyMatches(current: JsonObject, step: PolicyStep): boolean {
  return (
    current["decision"] === (step.decision ?? "allow") &&
    sameItems(current["include"], step.include as unknown as Json[]) &&
    isEmpty(current["exclude"]) &&
    isEmpty(current["require"]) &&
    current["session_duration"] === step.sessionDuration &&
    !POLICY_EXTRAS.some((key) => isSet(current[key]))
  );
}

export async function ensurePolicy(
  client: CloudflareClient,
  context: ApplyContext,
  step: PolicyStep,
): Promise<StepOutcome> {
  const path = ["accounts", context.accountId, "access", "policies"];
  const wanted: JsonObject = {
    name: step.name,
    decision: step.decision ?? "allow",
    include: step.include as unknown as Json,
    exclude: [],
    require: [],
    session_duration: step.sessionDuration,
  };
  const withId = (id: string): ApplyContext => ({
    ...context,
    policyIds: { ...context.policyIds, [step.id]: id },
  });

  // A rule is found by its name, which setup made up: it is setup's own.
  const existing = (await client.list(path))
    .map((item) => Named.safeParse(item))
    .find((parsed) => parsed.success && parsed.data.name === step.name);
  if (!existing?.success) {
    const created = Named.parse(await client.send("POST", path, wanted));
    return { status: "created", context: withId(created.id) };
  }

  const current = existing.data;
  if (policyMatches(asObject(current), step))
    return { status: "unchanged", context: withId(current.id) };

  // Exactly the wanted fields: PUT replaces the rule, so nothing else it
  // carried (a switched-off second factor, a longer session) survives.
  await client.send("PUT", [...path, current.id], wanted);
  return { status: "updated", context: withId(current.id) };
}

// ── applications ────────────────────────────────────────────────────────────

const Application = z
  .object({
    id: Id,
    aud: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    type: z.string().optional(),
    domain: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

/** The only fields of an existing application that an update keeps. */
const COSMETIC = [
  "logo_url",
  "custom_deny_message",
  "custom_deny_url",
  "custom_non_identity_deny_url",
  "custom_pages",
  "tags",
];

/** Application fields that loosen sign-in when switched on. None is wanted. */
const APP_EXTRAS = [
  "cors_headers",
  "options_preflight_bypass",
  "allow_authenticate_via_warp",
  "allow_iframe",
  "read_service_tokens_from_header",
  "service_auth_401_redirect",
  "skip_interstitial",
];

/** Ids of the rules attached to an application, however they are written. */
function attachedPolicyIds(app: JsonObject): readonly string[] {
  const policies = app["policies"];
  if (!Array.isArray(policies)) return [];
  return policies.map((p) =>
    typeof p === "string" ? p : String((p as JsonObject)?.["id"] ?? ""),
  );
}

function wantedApplication(step: ApplicationStep, context: ApplyContext) {
  const policyId = context.policyIds[step.policy];
  if (!policyId || !context.loginMethodId) {
    throw new SetupStepError(
      "An earlier step did not finish; run setup again.",
    );
  }
  const secondFactor: JsonObject =
    step.secondFactor && context.authenticators
      ? { mfa_config: { allowed_authenticators: [...context.authenticators] } }
      : {};
  return {
    policyId,
    fields: mergeDeep(mergeDeep(step.body, secondFactor), {
      allowed_idps: [context.loginMethodId],
    }),
  };
}

function applicationMatches(
  current: JsonObject,
  fields: JsonObject,
  policyId: string,
): boolean {
  const attached = attachedPolicyIds(current);
  return (
    contains(current, fields) &&
    attached.length === 1 &&
    attached[0] === policyId &&
    !APP_EXTRAS.some((key) => isSet(current[key]))
  );
}

export async function ensureApplication(
  client: CloudflareClient,
  context: ApplyContext,
  step: ApplicationStep,
): Promise<StepOutcome> {
  const path = ["accounts", context.accountId, "access", "apps"];
  const { policyId, fields } = wantedApplication(step, context);
  const policies = [{ id: policyId, precedence: 1 }];
  const withAud = (aud: string): ApplyContext => ({
    ...context,
    auds: { ...context.auds, [step.id]: aud },
  });

  const existing = (await client.list(path))
    .map((item) => Application.safeParse(item))
    .find(
      (parsed) =>
        parsed.success &&
        parsed.data.type === "self_hosted" &&
        parsed.data.domain === step.domain,
    );
  if (!existing?.success) {
    const created = Application.parse(
      await client.send("POST", path, { ...fields, policies }),
    );
    return { status: "created", context: withAud(created.aud) };
  }

  const current = asObject(existing.data);
  // An application setup did not make is only taken over when asked to.
  if (existing.data.name !== fields["name"] && !step.replaceExisting) {
    throw new SetupStepError(
      `Cloudflare already has an application for ${step.domain} that setup did not make. ${HOW_TO_REPLACE}`,
    );
  }
  if (applicationMatches(current, fields, policyId))
    return { status: "unchanged", context: withAud(existing.data.aud) };

  // Read, keep the cosmetic fields, write. Everything that decides who gets
  // in comes from the plan; PUT resets the rest to Cloudflare's defaults.
  const body = { ...only(current, COSMETIC), ...fields, policies };
  const updated = Application.parse(
    await client.send("PUT", [...path, existing.data.id], body),
  );
  return { status: "updated", context: withAud(updated.aud) };
}
