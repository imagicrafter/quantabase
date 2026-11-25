import { z } from "zod";

export const TWO_STEP_NOTE =
  "Administrators only. Two steps: call WITHOUT confirm_code to get a preview of exactly what will change and a one-time code; show that preview to the person and wait for an explicit yes; then call again with the same arguments plus confirm_code to apply. Never invent, guess or reuse a confirmation code -- a code works once, only for the exact arguments it was issued for, and only for 10 minutes.";

export const emailField = z.string().trim().toLowerCase().email().max(254);

export const topicField = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9-]*$/,
    "a topic id is lowercase letters, digits and dashes",
  )
  .max(64);

/** The code a preview returned: 32 lowercase hex characters. */
export const confirmCodeField = z
  .string()
  .regex(
    /^[0-9a-f]{32}$/,
    "use the confirm_code exactly as the preview returned it",
  )
  .optional();

export const ROLES = ["reader", "reviewer", "administrator"] as const;
