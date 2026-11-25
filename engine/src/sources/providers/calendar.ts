import type { TagProvider } from "../types.js";

/** Google Calendar: events carry no tags, so every event stays with its owner. */
export const calendarProvider: TagProvider = {
  source: "calendar",
  kinds: [],
  howToRead: "Calendar events have no tags. Do not pass tags.",
  normalize: () => [],
};
