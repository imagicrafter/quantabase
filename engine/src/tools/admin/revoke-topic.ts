import { z } from "zod";
import type { ToolSpec } from "../../mcp/tool-helpers.js";
import { runTwoStep, type TwoStepResult } from "./rpc.js";
import {
  confirmCodeField,
  emailField,
  topicField,
  TWO_STEP_NOTE,
} from "./schemas.js";

export const revokeTopicSchema = z
  .object({
    person_email: emailField,
    topic: topicField,
    confirm_code: confirmCodeField,
  })
  .strict();

export type RevokeTopicInput = z.infer<typeof revokeTopicSchema>;

export async function revokeTopic(
  input: RevokeTopicInput,
  email: string,
): Promise<TwoStepResult> {
  return runTwoStep(
    {
      fn: "admin_revoke",
      args: { p_person_email: input.person_email, p_topic: input.topic },
      confirmCode: input.confirm_code,
    },
    email,
  );
}

export const revokeTopicTool: ToolSpec = {
  name: "admin_revoke_topic",
  description: `Take one topic away from a person. ${TWO_STEP_NOTE}`,
  shape: revokeTopicSchema.shape,
  run: async (params, ctx) =>
    revokeTopic(revokeTopicSchema.parse(params), ctx.email),
};
