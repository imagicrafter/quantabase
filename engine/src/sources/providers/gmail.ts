import { tag, text, unique } from "../clean.js";
import type { TagProvider } from "../types.js";

/**
 * Gmail: the labels on a thread. Only labels a person made count; Gmail's
 * own labels (INBOX, UNREAD, CATEGORY_* and so on) are never tags. A label's
 * id is stable when it is renamed, so the id is the key; the name is shown.
 */

const SYSTEM = new Set([
  "inbox", "sent", "draft", "drafts", "spam", "trash", "unread", "starred", "important",
  "chat", "chats", "snoozed", "scheduled", "all mail", "yellow_star", "opened", "muted",
]);

const isSystem = (value: string): boolean => {
  const v = value.toLowerCase();
  return SYSTEM.has(v) || v.startsWith("category_") || v.startsWith("category/");
};

export const gmailProvider: TagProvider = {
  source: "gmail",
  kinds: ["label"],
  howToRead:
    'Pass every label on the thread as {"kind": "label", "id": "<label id>", "name": "<label name>"}, unchanged. ' +
    "If the thread only shows label ids, read the names once with the list-labels tool. Leave out nothing; the Engine drops Gmail's own labels.",
  normalize: (raw) =>
    unique(
      raw.map((r) => {
        const name = text(r.name) || text(r.id);
        const id = text(r.id) || name;
        return isSystem(id) || isSystem(name) ? null : tag("label", id, name);
      }),
    ),
};
