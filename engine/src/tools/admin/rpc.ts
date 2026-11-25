import { db } from "../../db.js";
import { McpAppError } from "../../mcp/errors.js";
import { logger } from "../../log/logger.js";
import { mapDbError } from "../db-error.js";

const ADMINS_ONLY = "Administrators only";
const FAILED = "The admin request failed";

export const NEXT_STEP =
  "NOTHING HAS CHANGED YET. Show the preview text to the person exactly as written and ask whether to go ahead. Only after they answer with an explicit yes, call this tool again with the SAME arguments plus this confirm_code. If they say anything else, stop. The code works once, for this exact change, for 10 minutes. Never invent, guess, alter or reuse a code.";

export type RpcArgs = Readonly<Record<string, string | boolean | null>>;

export type PreviewResult = {
  readonly status: "confirmation_required";
  readonly preview: string;
  readonly confirm_code: string;
  readonly expires_at: string;
  readonly next_step: string;
};

export type AppliedResult = {
  readonly status: "applied";
  readonly summary: string;
};

export type TwoStepResult = PreviewResult | AppliedResult;

export type TwoStepSpec = {
  /** Database function prefix, e.g. `admin_grant` -> `_preview` / `_apply`. */
  readonly fn: string;
  /** Arguments shared by both steps (without `p_email` and `p_code`). */
  readonly args: RpcArgs;
  readonly confirmCode?: string;
};

function asRecord(data: unknown): Record<string, unknown> {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  throw new McpAppError("internal_error", FAILED);
}

/**
 * Call one admin function as the verified caller. The database re-checks
 * that `email` is an active administrator on every call; nothing here does.
 */
export async function callAdmin(
  fn: string,
  email: string,
  args: RpcArgs = {},
): Promise<unknown> {
  const { data, error } = await db()
    .rpc(fn, { p_email: email, ...args });

  if (error) {
    logger.warn({ fn, code: error.code }, "admin RPC failed");
    throw mapDbError(error, ADMINS_ONLY, FAILED);
  }
  return data;
}

async function preview(
  spec: TwoStepSpec,
  email: string,
): Promise<PreviewResult> {
  const row = asRecord(await callAdmin(`${spec.fn}_preview`, email, spec.args));
  const text = row["preview"];
  const code = row["confirm_code"];
  if (typeof text !== "string" || typeof code !== "string" || !code) {
    throw new McpAppError("internal_error", FAILED);
  }
  return {
    status: "confirmation_required",
    preview: text,
    confirm_code: code,
    expires_at: String(row["expires_at"] ?? ""),
    next_step: NEXT_STEP,
  };
}

async function apply(
  spec: TwoStepSpec,
  email: string,
  code: string,
): Promise<AppliedResult> {
  const row = asRecord(
    await callAdmin(`${spec.fn}_apply`, email, { ...spec.args, p_code: code }),
  );
  if (row["applied"] !== true) {
    throw new McpAppError("internal_error", FAILED);
  }
  return { status: "applied", summary: String(row["summary"] ?? "") };
}

/** Without a code: preview. With one: apply. Never both in one call. */
export async function runTwoStep(
  spec: TwoStepSpec,
  email: string,
): Promise<TwoStepResult> {
  return spec.confirmCode === undefined
    ? preview(spec, email)
    : apply(spec, email, spec.confirmCode);
}
