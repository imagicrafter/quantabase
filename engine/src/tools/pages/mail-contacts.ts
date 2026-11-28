import type { ToolSpec } from "../../mcp/tool-helpers.js";
import { contactsForDb, mailContactsSchema } from "../../sources/mail-contacts.js";
import { pageRpc } from "./rpc.js";

/**
 * report_mail_contacts (migration 0080): the plugin's suggest-rules skill
 * hands over counts per address and per domain from the caller's OWN Gmail
 * headers (sent to, received from, threads, replied, last seen). The Engine
 * keeps them for the caller's rule screen, where they become boxes, the
 * person's picks from Claude (`chosen`) ticked.
 * A new report replaces the last one for that account. Counts only: any
 * other key (a subject, snippet, name or id) is refused by the schema.
 */
export const reportMailContactsTool: ToolSpec = {
  name: "report_mail_contacts",
  description:
    "Only when the person runs suggest-rules: hand over counts from ONE of your own Gmail accounts' mail headers, per address and per domain " +
    "(sent_to, received_from, threads, replied, last_seen) over the last `days`, and `chosen` for what the person picked when you asked them. " +
    "Their Sources screen shows them as suggested rules, the chosen ones ticked; they save the rules there. " +
    "Counts only: never a name, subject, snippet, body or message id. Replaces the last report for that account.",
  shape: mailContactsSchema.shape,
  run: async (params, ctx) => {
    const report = mailContactsSchema.parse(params);
    const { rows, dropped } = contactsForDb(report);
    const data = (await pageRpc(
      "source_contacts_report",
      ctx.sub,
      { p_account: report.account, p_days: report.days, p_messages: report.messages_read, p_contacts: rows },
      "The suggestions could not be recorded",
    )) as Record<string, unknown> | null;
    return {
      addresses: Number(data?.["addresses"] ?? 0),
      domains: Number(data?.["domains"] ?? 0),
      left_out: dropped,
      next: "Open Sources in your Engine and pick this Gmail account: the person's picks are ticked there. They save the rules on that screen; you make none.",
    };
  },
};
