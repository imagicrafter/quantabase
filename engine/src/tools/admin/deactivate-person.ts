import { z } from "zod";
import type { ToolSpec } from "../../mcp/tool-helpers.js";
import { runTwoStep, type TwoStepResult } from "./rpc.js";
import { confirmCodeField, emailField, TWO_STEP_NOTE } from "./schemas.js";

export const deactivatePersonSchema = z
  .object({
    person_email: emailField,
    confirm_code: confirmCodeField,
  })
  .strict();

export type DeactivatePersonInput = z.infer<typeof deactivatePersonSchema>;

export async function deactivatePerson(
  input: DeactivatePersonInput,
  email: string,
): Promise<TwoStepResult> {
  return runTwoStep(
    {
      fn: "admin_person_deactivate",
      args: { p_person_email: input.person_email },
      confirmCode: input.confirm_code,
    },
    email,
  );
}

export const deactivatePersonTool: ToolSpec = {
  name: "admin_deactivate_person",
  description: `Remove a person's access to this Engine at once. You cannot deactivate yourself, and the last active administrator cannot be removed. ${TWO_STEP_NOTE}`,
  shape: deactivatePersonSchema.shape,
  run: async (params, ctx) =>
    deactivatePerson(deactivatePersonSchema.parse(params), ctx.email),
};
