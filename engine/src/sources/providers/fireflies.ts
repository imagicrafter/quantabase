import { tag, text, unique } from "../clean.js";
import type { TagProvider } from "../types.js";

/** Fireflies: the channels a meeting is in. The channel id is the key. */
export const firefliesProvider: TagProvider = {
  source: "fireflies",
  kinds: ["channel"],
  howToRead:
    'Pass every channel the meeting is in as {"kind": "channel", "id": "<channel id>", "name": "<channel name>"}, unchanged.',
  normalize: (raw) =>
    unique(raw.map((r) => (text(r.id) ? tag("channel", text(r.id), text(r.name) || text(r.id)) : null))),
};
