import { z } from "zod";
import type { ToolSpec } from "../../mcp/tool-helpers.js";
import { runTwoStep, type TwoStepResult } from "./rpc.js";
import {
  confirmCodeField,
  emailField,
  topicField,
  TWO_STEP_NOTE,
} from "./schemas.js";

export const grantTopicSchema = z
  .object({
    person_email: emailField,
    topic: topicField,
    sensitive_ack: z.boolean().default(false),
    confirm_code: confirmCodeField,
  })
  .strict();

export type GrantTopicInput = z.infer<typeof grantTopicSchema>;

export async function grantTopic(
  input: GrantTopicInput,
  email: string,
): Promise<TwoStepResult> {
  return runTwoStep(
    {
      fn: "admin_grant",
      args: {
        p_person_email: input.person_email,
        p_topic: input.topic,
        p_sensitive_ack: input.sensitive_ack,
      },
      confirmCode: input.confirm_code,
    },
    email,
  );
}

export const grantTopicTool: ToolSpec = {
  name: "admin_grant_topic",
  description: `Let a person search and read every document in one topic. A topic marked sensitive needs sensitive_ack=true on BOTH calls; set it only after the person asking has been told the topic is sensitive and has said yes to that specifically. The topic "unclassified" can never be granted. ${TWO_STEP_NOTE}`,
  shape: grantTopicSchema.shape,
  run: async (params, ctx) =>
    grantTopic(grantTopicSchema.parse(params), ctx.email),
};
