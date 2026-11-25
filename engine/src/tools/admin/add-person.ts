import { z } from "zod";
import type { ToolSpec } from "../../mcp/tool-helpers.js";
import { runTwoStep, type TwoStepResult } from "./rpc.js";
import {
  confirmCodeField,
  emailField,
  ROLES,
  TWO_STEP_NOTE,
} from "./schemas.js";

export const addPersonSchema = z
  .object({
    email: emailField,
    display_name: z.string().trim().min(1).max(120),
    role: z.enum(ROLES),
    admin_ack: z.boolean().default(false),
    confirm_code: confirmCodeField,
  })
  .strict();

export type AddPersonInput = z.infer<typeof addPersonSchema>;

export async function addPerson(
  input: AddPersonInput,
  email: string,
): Promise<TwoStepResult> {
  return runTwoStep(
    {
      fn: "admin_person_add",
      args: {
        p_new_email: input.email,
        p_display_name: input.display_name,
        p_role: input.role,
        p_admin_ack: input.admin_ack,
      },
      confirmCode: input.confirm_code,
    },
    email,
  );
}

export const addPersonTool: ToolSpec = {
  name: "admin_add_person",
  description: `Add a person to this Engine as a reader, reviewer or administrator. A new person starts with no topics. Adding an administrator needs admin_ack=true on BOTH calls, and only after the person asking has said they want a new administrator. The Engine cannot change the sign-in layer: the preview says what else has to be done there. ${TWO_STEP_NOTE}`,
  shape: addPersonSchema.shape,
  run: async (params, ctx) =>
    addPerson(addPersonSchema.parse(params), ctx.email),
};
