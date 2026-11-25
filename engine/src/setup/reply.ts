import type { Context } from "hono";
import type { ApplyReport } from "./apply.js";
import type { SignedInputs } from "./inputs.js";
import type { Plan } from "./plan.js";

/**
 * The same answers as the pages, as JSON, for `kbe access setup`.
 *
 * A request that asks for JSON (Accept: application/json, and not text/html)
 * goes through exactly the same routes, the same gate, the same setup code
 * check and lockout, and the same validation as a browser's. Only the shape
 * of the answer differs. Neither the setup code nor the Cloudflare token is
 * ever put in an answer.
 */

export function wantsJson(c: Context): boolean {
  const accept = (c.req.header("accept") ?? "").toLowerCase();
  return accept.includes("application/json") && !accept.includes("text/html");
}

/** What the last step does. Shown in the page's preview and sent as JSON. */
export const FINISH_STEP = {
  title: "Save the result and close setup",
  lines: [
    "Stores your team name, the two applications' audience tags, the hostname and the access level in the Engine's database. None of these is a secret.",
    "The setup code stops working.",
  ],
} as const;

export type RefusalBody = {
  readonly ok: false;
  readonly title: string;
  readonly message: string;
  readonly errors?: readonly string[];
};

export function refusalBody(
  title: string,
  message: string,
  errors?: readonly string[],
): RefusalBody {
  return { ok: false, title, message, ...(errors ? { errors } : {}) };
}

/** The plan and the signed choices to send back with the apply step. */
export function previewBody(plan: Plan, signed: SignedInputs) {
  const steps = [...plan.steps, FINISH_STEP].map((step) => ({
    title: step.title,
    lines: [...step.lines],
  }));
  return {
    ok: true as const,
    plan: {
      host: plan.host,
      level: plan.level,
      connector_url: plan.connectorUrl,
      steps,
    },
    inputs: signed.payload,
    sig: signed.signature,
  };
}

/** What was done, step by step. */
export function resultBody(
  report: Pick<ApplyReport, "steps" | "warnings" | "checks">,
  ok: boolean,
  connectorUrl: string,
) {
  return {
    ok,
    steps: report.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      ...(step.note ? { note: step.note } : {}),
      ...(step.code ? { code: step.code } : {}),
      ...(step.details ? { details: [...step.details] } : {}),
    })),
    warnings: [...report.warnings],
    checks: (report.checks ?? []).map((check) => ({ ...check })),
    connector_url: connectorUrl,
  };
}
