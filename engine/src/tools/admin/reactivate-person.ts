import { z } from "zod";
import type { ToolSpec } from "../../mcp/tool-helpers.js";
import { runTwoStep, type TwoStepResult } from "./rpc.js";
import { confirmCodeField, emailField, TWO_STEP_NOTE } from "./schemas.js";

export const reactivatePersonSchema = z
  .object({
    person_email: emailField,
    confirm_code: confirmCodeField,
  })
  .strict();

export type ReactivatePersonInput = z.infer<typeof reactivatePersonSchema>;

export async function reactivatePerson(
  input: ReactivatePersonInput,
  email: string,
): Promise<TwoStepResult> {
  return runTwoStep(
    {
      fn: "admin_person_reactivate",
      args: { p_person_email: input.person_email },
      confirmCode: input.confirm_code,
    },
    email,
  );
}

export const reactivatePersonTool: ToolSpec = {
  name: "admin_reactivate_person",
  description: `Give a deactivated person their access to this Engine back. They return with the role and topics they had when they were deactivated; the preview lists both, so read it to the person asking. This widens who can see things: use it only when the person asking has said they want this person back. ${TWO_STEP_NOTE}`,
  shape: reactivatePersonSchema.shape,
  run: async (params, ctx) =>
    reactivatePerson(reactivatePersonSchema.parse(params), ctx.email),
};
