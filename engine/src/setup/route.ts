import { Hono, type Context } from "hono";
import { logger } from "../log/logger.js";
import { applyPlan, explain, TOKEN_STEP, type ApplyReport } from "./apply.js";
import { setupAssetVersion } from "./assets.js";
import {
  CloudflareError,
  createCloudflareClient,
} from "./cloudflare-client.js";
import type { AccessSettings } from "../config/settings.js";
import type { SetupDeps } from "./gate.js";
import {
  arrivalHost,
  checkCode,
  json,
  message,
  page,
  posted,
  stage,
  UNAVAILABLE,
} from "./gate.js";
import {
  echoableValues,
  formValues,
  isHostname,
  openSignedInputs,
  parseSetupForm,
  signInputs,
  type FixedValues,
  type FormValues,
  type SetupInputs,
} from "./inputs.js";
import { formPage, infoPage, type FormView } from "./page.js";
import { previewPage, resultPage } from "./page-plan.js";
import { buildPlan, type Plan } from "./plan.js";
import { previewBody, refusalBody, resultBody, wantsJson } from "./reply.js";

/**
 * The /setup routes.
 *
 *   GET  /setup          the form, or (once set up) what is in force
 *   POST /setup/preview  checks the code and the choices; shows the plan
 *   POST /setup/apply    takes the signed choices, the code again and the
 *                        Cloudflare token; carries out the plan
 *
 * Every request goes through gate.ts first.
 *
 * `kbe access setup` uses the same two POST routes. It sends the same form
 * fields and asks for JSON (reply.ts); nothing else differs.
 *
 * THE TOKEN is read from the form in applyRoute, handed to the Cloudflare
 * client, and goes nowhere else: not to the logger, not into a page, not into
 * the database, not into an error.
 */

export type { SetupDeps } from "./gate.js";

async function fixedOwner(deps: SetupDeps): Promise<string | null> {
  const owner = await deps.ownerEmail();
  return owner ? owner.trim().toLowerCase() : null;
}

/**
 * What the form may not override: the config's owner, and in setup mode the
 * app's own address, which is the hostname this page was reached on. (Once
 * set up, the page is reached on the Engine's hostname instead, so a reopened
 * setup has to ask for the address.)
 */
async function fixedValues(
  c: Context,
  deps: SetupDeps,
  reopened: boolean,
): Promise<FixedValues> {
  return {
    owner: await fixedOwner(deps),
    origin: reopened ? null : arrivalHost(c),
  };
}

const EMPTY: FormValues = {
  host: "",
  origin: "",
  level: "",
  ownerEmail: "",
  emails: "",
  domains: "",
  replace: false,
};

/**
 * What the form shows. The owner's email is not shown here: this page can be
 * opened without the setup code. It appears in the preview, after the code.
 */
function formView(
  values: FormValues,
  errors: readonly string[],
  fixed: FixedValues,
  reopened: boolean,
  claimed = false,
): FormView {
  const origin =
    fixed.origin !== null && isHostname(fixed.origin) ? fixed.origin : null;
  return {
    values,
    errors,
    ownerFromConfig: fixed.owner !== null,
    fixedOrigin: origin,
    originUnusable: fixed.origin !== null && origin === null,
    reopened,
    claimed,
    // A claimed session has proven the first-run code: it may see the owner.
    knownOwner: claimed ? fixed.owner : null,
  };
}

/**
 * What the form starts with, so the person does not retype what is already
 * known: the hostname and level in force when setup was reopened, otherwise
 * the hostname the applied config names. Never the owner's email or a list
 * of people: this page opens without the setup code.
 */
async function startValues(
  deps: SetupDeps,
  access: AccessSettings | null,
): Promise<FormValues> {
  if (access) {
    return { ...EMPTY, host: access.host, level: access.level ?? "" };
  }
  let named: string | null;
  try {
    named = (await deps.configuredHost?.()) ?? null;
  } catch {
    named = null; // a suggestion only: the form still works without it
  }
  const host = (named ?? "").trim().toLowerCase();
  return { ...EMPTY, host: isHostname(host) ? host : "" };
}

function getRoute(use: () => SetupDeps) {
  return async (c: Context) => {
    const deps = use();
    const at = await stage(c, deps);
    if (at.kind === "respond") return at.response;
    const version = setupAssetVersion();
    if (at.kind === "closed") {
      const view = {
        host: at.access.host,
        level: at.access.level ?? null,
        session: at.access.session ?? null,
        source: at.access.source,
        reason: at.reason,
        email: at.email,
      };
      return page(c, 200, infoPage(view, version));
    }
    let fixed: FixedValues;
    try {
      fixed = await fixedValues(c, deps, at.reopened);
    } catch {
      return message(c, 503, ...UNAVAILABLE);
    }
    const values = await startValues(deps, at.access);
    return page(
      c,
      200,
      formPage(
        formView(values, [], fixed, at.reopened, !!deps.sessionCode?.(c)),
        version,
      ),
    );
  };
}

function previewRoute(use: () => SetupDeps) {
  return async (c: Context) => {
    const deps = use();
    const sent = await posted(c, deps);
    if (!sent.ok) return sent.response;
    const claimed = deps.sessionCode?.(c);
    const refused = await checkCode(c, deps, claimed ?? sent.form["code"]);
    if (refused) return refused;

    let fixed: FixedValues;
    try {
      fixed = await fixedValues(c, deps, sent.reopened);
    } catch {
      return message(c, 503, ...UNAVAILABLE);
    }
    const version = setupAssetVersion();
    const parsed = parseSetupForm(sent.form, fixed);
    if (!parsed.ok) {
      if (wantsJson(c)) {
        const body = refusalBody(
          "Check your choices",
          "The choices were not accepted. Nothing was changed.",
          parsed.errors,
        );
        return json(c, 400, body);
      }
      const values = echoableValues(formValues(sent.form));
      const view = formView(values, parsed.errors, fixed, sent.reopened, !!claimed);
      return page(c, 400, formPage(view, version));
    }
    // deps.setupCode is set: stage() refuses every request without one.
    const signed = signInputs(parsed.inputs, deps.setupCode ?? "", deps.now());
    const plan = buildPlan(parsed.inputs);
    return wantsJson(c)
      ? json(c, 200, previewBody(plan, signed))
      : page(c, 200, previewPage(plan, signed, [], version, !claimed));
  };
}

/** A failed apply. 4xx, so the hosting edge passes the page through. */
const APPLY_FAILED = 422;

/** The failed steps' notes, codes and details, for the log. */
function failedSteps(report: ApplyReport) {
  return report.steps
    .filter((s) => s.status === "failed")
    .map((s) => ({
      id: s.id,
      ...(s.code ? { code: s.code } : {}),
      ...(s.note ? { note: s.note } : {}),
      ...(s.details ? { details: s.details } : {}),
    }));
}

/** True while an apply is running in this process. */
let applying = false;

const FINISH = {
  id: "finish",
  title: "Save the result and close setup",
} as const;

/** The longest an apply may spend talking to Cloudflare. */
const APPLY_BUDGET_MS = 75_000;

/** Run the plan against Cloudflare. The token goes into the client and stops there. */
async function runAgainstCloudflare(
  deps: SetupDeps,
  plan: Plan,
  token: unknown,
): Promise<ApplyReport> {
  try {
    const client = createCloudflareClient({
      token: typeof token === "string" ? token : "",
      fetch: deps.cloudflareFetch,
      // One deadline for the whole run: no call may outlast it.
      deadline: deps.now() + APPLY_BUDGET_MS,
      now: deps.now,
    });
    return await applyPlan(plan, client, {
      now: deps.now,
      budgetMs: APPLY_BUDGET_MS,
    });
  } catch (err) {
    const note =
      err instanceof CloudflareError && err.kind === "bad_token"
        ? "That does not look like a Cloudflare API token. Paste the whole token and nothing else."
        : explain(err);
    return {
      steps: [
        { ...TOKEN_STEP, status: "failed", note },
        ...plan.steps.map((s) => ({
          id: s.id,
          title: s.title,
          status: "not_run" as const,
        })),
      ],
      warnings: [],
      access: null,
    };
  }
}

/** Store the result. Returns the report with the last step added. */
async function finish(
  deps: SetupDeps,
  report: ApplyReport,
  code: string,
): Promise<{ readonly report: ApplyReport; readonly ok: boolean }> {
  const add = (status: "updated" | "failed" | "not_run", note?: string) => ({
    ...report,
    steps: [...report.steps, { ...FINISH, status, ...(note ? { note } : {}) }],
  });
  if (!report.access) return { report: add("not_run"), ok: false };
  try {
    if (await deps.complete(code, report.access)) {
      deps.onCompleted();
      return { report: add("updated"), ok: true };
    }
    return {
      report: add(
        "failed",
        "The database did not accept the setup code at the last step. Cloudflare is set up; run setup again to save the result.",
      ),
      ok: false,
    };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.name : "unknown" },
      "setup: could not store the sign-in settings",
    );
    return {
      report: add(
        "failed",
        "The database could not store the result. Cloudflare is set up; run setup again to save it.",
      ),
      ok: false,
    };
  }
}

/** The signed choices, if what they were made against has not changed since. */
async function stillHolds(
  c: Context,
  deps: SetupDeps,
  inputs: SetupInputs,
  reopened: boolean,
): Promise<SetupInputs | Response> {
  let owner: string | null;
  try {
    owner = await fixedOwner(deps);
  } catch {
    return message(c, 503, ...UNAVAILABLE);
  }
  if (owner && owner !== inputs.ownerEmail) {
    return message(
      c,
      400,
      "Owner changed",
      "The Engine's owner changed since the preview. Start again.",
    );
  }
  // In setup mode the app's own address is the one this page is on.
  if (!reopened && inputs.origin !== arrivalHost(c)) {
    return message(
      c,
      400,
      "Not accepted",
      "That preview was made on a different address. Start again.",
    );
  }
  return inputs;
}

async function signedInputs(
  c: Context,
  deps: SetupDeps,
  form: Readonly<Record<string, unknown>>,
  reopened: boolean,
): Promise<SetupInputs | Response> {
  const opened = openSignedInputs(
    form["inputs"],
    form["sig"],
    deps.setupCode ?? "",
    deps.now(),
  );
  if (!opened.ok) {
    return opened.reason === "expired"
      ? message(
          c,
          400,
          "Preview expired",
          "That preview is too old. Start again.",
        )
      : message(
          c,
          400,
          "Not accepted",
          "These details did not come from the preview page, or were changed on the way. Start again.",
        );
  }
  return stillHolds(c, deps, opened.inputs, reopened);
}

function applyRoute(use: () => SetupDeps) {
  return async (c: Context) => {
    const deps = use();
    const sent = await posted(c, deps);
    if (!sent.ok) return sent.response;
    const code = deps.sessionCode?.(c) ?? sent.form["code"];
    const refused = await checkCode(c, deps, code);
    if (refused) return refused;

    const inputs = await signedInputs(c, deps, sent.form, sent.reopened);
    if (inputs instanceof Response) return inputs;

    // One apply at a time: two at once could each create the same objects.
    if (applying) {
      return message(
        c,
        409,
        "Setup is already running",
        "Another setup is being applied right now. Wait a minute, then look at the setup page again.",
      );
    }
    applying = true;
    try {
      const plan = buildPlan(inputs);
      const ran = await runAgainstCloudflare(deps, plan, sent.form["cf_token"]);
      const { report, ok } = await finish(deps, ran, String(code).trim());
      logger.info(
        {
          host: plan.host,
          access_level: plan.level,
          ok,
          steps: report.steps.map((s) => `${s.id}:${s.status}`),
          // Which check failed and what Cloudflare said. Never the token.
          failed: failedSteps(report),
        },
        "setup: apply finished",
      );
      // Not 502: DigitalOcean's edge answers a 502 from the app with its own
      // "failed to forward" page, so the person never saw this report.
      const status = ok ? 200 : APPLY_FAILED;
      return wantsJson(c)
        ? json(c, status, resultBody(report, ok, plan.connectorUrl))
        : page(
            c,
            status,
            resultPage(report, ok, plan.connectorUrl, setupAssetVersion()),
          );
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.name : "unknown" },
        "setup: apply could not finish",
      );
      return message(
        c,
        APPLY_FAILED,
        "Setup stopped",
        "Something went wrong while applying. Look at the setup page again: finished steps are not repeated when you run it again.",
      );
    } finally {
      applying = false;
    }
  };
}

/**
 * The three /setup routes, mounted by index.ts. Takes the dependencies, or a
 * function that returns them (read on every request).
 */
export function makeSetupRoutes(deps: SetupDeps | (() => SetupDeps)): Hono {
  const use = typeof deps === "function" ? deps : () => deps;
  const routes = new Hono();
  routes.get("/", getRoute(use));
  routes.post("/preview", previewRoute(use));
  routes.post("/apply", applyRoute(use));
  // Opened directly (a bookmark, a reload, the back button): the preview and
  // the apply step are answers to a form, so start over at the form.
  const startOver = (c: Context) => c.redirect("/setup", 303);
  routes.get("/preview", startOver);
  routes.get("/apply", startOver);
  return routes;
}
