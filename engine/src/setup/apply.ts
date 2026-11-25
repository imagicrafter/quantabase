import { z, ZodError } from "zod";
import { CloudflareError, type CloudflareClient } from "./cloudflare-client.js";
import { readBack, type Check } from "./checks.js";
import { discover, SetupStepError } from "./discover.js";
import { SESSIONS, type Level, type SessionLength } from "./inputs.js";
import { permissionLabel, type TokenPermission } from "./permissions.js";
import type { Plan, PlanStep } from "./plan.js";
import { runStep, type ApplyContext, type StepStatus } from "./steps.js";

/**
 * Carries out a plan, one step after another, and reports exactly what
 * happened to each. It stops at the first step that fails: later steps are
 * reported as not run, nothing is rolled back, and a second run picks up
 * where this one stopped (each step only writes what is missing).
 *
 * This file never sees the API token: the client it is given holds it.
 */

export type StepReport = {
  readonly id: string;
  readonly title: string;
  readonly status: StepStatus | "failed" | "not_run";
  /** Why it failed, in words a person can act on. */
  readonly note?: string;
  /** A fixed word for a failure the command line knows what to say about. */
  readonly code?: string;
  /** What each sub-check saw (discover.ts). Never a secret. */
  readonly details?: readonly string[];
};

/** The code and details a SetupStepError carries, as report fields. */
export function errorFields(
  err: unknown,
): Pick<StepReport, "code" | "details"> {
  if (!(err instanceof SetupStepError)) return {};
  return {
    ...(err.code ? { code: err.code } : {}),
    ...(err.details.length > 0 ? { details: err.details } : {}),
  };
}

/**
 * The sign-in settings stored in workspace.engine_settings.access. Nothing
 * here is secret.
 */
export const StoredAccessSchema = z
  .object({
    team_domain: z
      .string()
      .regex(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/),
    aud: z.string().min(16),
    status_aud: z.string().min(16),
    host: z.string().min(1),
    resource_url: z.string().url(),
    level: z.enum(["owner", "people", "domain"]),
    /** The sign-in length, which is also the connector's approval length. */
    session: z.enum(SESSIONS).optional(),
  })
  .strict()
  .refine((a) => a.aud !== a.status_aud, {
    message: "the two applications must have different audience tags",
  });
export type StoredAccess = z.infer<typeof StoredAccessSchema>;

export type ApplyReport = {
  readonly steps: readonly StepReport[];
  readonly warnings: readonly string[];
  /** Present only when every step succeeded. */
  readonly access: StoredAccess | null;
  /** What the read-back found (checks.ts). Only after every step succeeded. */
  readonly checks?: readonly Check[];
};

export const TOKEN_STEP = {
  id: "token",
  title: "Check the Cloudflare token",
} as const;

const NEEDS: Readonly<Record<PlanStep["kind"], TokenPermission["id"]>> = {
  organization: "organization",
  login_method: "organization",
  dns: "dns",
  policy: "apps",
  application: "apps",
};

/** Turn any failure into a sentence for the person. Never includes a secret. */
export function explain(err: unknown, kind?: PlanStep["kind"]): string {
  if (err instanceof SetupStepError) return err.message;
  if (err instanceof CloudflareError) {
    if (err.kind === "forbidden" && kind)
      return `The token is not allowed to do this. It needs: ${permissionLabel(NEEDS[kind])}.`;
    if (err.kind === "auth")
      return "Cloudflare stopped accepting the token. Make a new one and run setup again.";
    return err.message;
  }
  if (err instanceof ZodError)
    return "Cloudflare's answer was not in the shape this page expects. Nothing more was changed.";
  return "This step failed unexpectedly. Nothing more was changed.";
}

const notRun = (steps: readonly PlanStep[]): readonly StepReport[] =>
  steps.map((s) => ({ id: s.id, title: s.title, status: "not_run" }));

function storedAccess(
  context: ApplyContext,
  host: string,
  level: Level,
  session: SessionLength,
): StoredAccess {
  return StoredAccessSchema.parse({
    team_domain: context.teamDomain,
    aud: context.auds["engine_app"],
    status_aud: context.auds["admin_app"],
    host,
    resource_url: `https://${host}/mcp`,
    level,
    session,
  });
}

type Progress = {
  readonly context: ApplyContext;
  readonly reports: readonly StepReport[];
  readonly failed: boolean;
};

async function runSteps(
  client: CloudflareClient,
  start: ApplyContext,
  steps: readonly PlanStep[],
  outOfTime: () => boolean,
): Promise<Progress> {
  let progress: Progress = { context: start, reports: [], failed: false };
  for (const [index, step] of steps.entries()) {
    const base = { id: step.id, title: step.title };
    try {
      if (outOfTime())
        throw new SetupStepError(
          "Setup ran out of time. Run it again; finished steps are not repeated.",
        );
      const outcome = await runStep(client, progress.context, step);
      progress = {
        context: outcome.context,
        reports: [...progress.reports, { ...base, status: outcome.status }],
        failed: false,
      };
    } catch (err) {
      return {
        context: progress.context,
        reports: [
          ...progress.reports,
          {
            ...base,
            status: "failed",
            note: explain(err, step.kind),
            ...errorFields(err),
          },
          ...notRun(steps.slice(index + 1)),
        ],
        failed: true,
      };
    }
  }
  return progress;
}

export type ApplyOptions = {
  readonly now?: () => number;
  /** Stop starting new steps after this long. */
  readonly budgetMs?: number;
};

const DEFAULT_BUDGET_MS = 75_000;

/** The report when the plan ran: every step, and the settings if all went well. */
function finalReport(
  plan: Plan,
  done: Progress,
  warnings: readonly string[],
): ApplyReport {
  const checked: StepReport = { ...TOKEN_STEP, status: "unchanged" };
  const base = { warnings, access: null };
  if (done.failed) return { ...base, steps: [checked, ...done.reports] };
  try {
    return {
      steps: [checked, ...done.reports],
      warnings,
      access: storedAccess(done.context, plan.host, plan.level, plan.session),
    };
  } catch (err) {
    // Everything ran, but what was read back cannot be trusted as settings.
    const last = done.reports.at(-1);
    const failed = last
      ? [{ ...last, status: "failed" as const, note: explain(err) }]
      : [];
    return {
      ...base,
      steps: [checked, ...done.reports.slice(0, -1), ...failed],
    };
  }
}

/** Carry out the plan with this client. Never throws. */
export async function applyPlan(
  plan: Plan,
  client: CloudflareClient,
  options: ApplyOptions = {},
): Promise<ApplyReport> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);

  let found;
  try {
    found = await discover(client, plan.host);
  } catch (err) {
    return {
      steps: [
        {
          ...TOKEN_STEP,
          status: "failed",
          note: explain(err),
          ...errorFields(err),
        },
        ...notRun(plan.steps),
      ],
      warnings: [],
      access: null,
    };
  }

  const start: ApplyContext = {
    accountId: found.accountId,
    zoneId: found.zoneId,
    policyIds: {},
    auds: {},
  };
  const done = await runSteps(
    client,
    start,
    plan.steps,
    () => now() > deadline,
  );
  const report = finalReport(plan, done, found.warnings);
  if (!report.access) return report;
  return { ...report, checks: await readBack(client, found.accountId, plan) };
}
