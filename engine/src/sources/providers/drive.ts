import { tag, text, unique } from "../clean.js";
import type { SourceTag, TagProvider } from "../types.js";

/**
 * Google Drive: the folder a file sits in, and tags written in a file's
 * description (the existing convention, e.g. "kx/consulting"; see
 * docs/tagging.md). A folder's id is the key; its name is shown. A
 * description tag is its own id, in lower case.
 */

export const DESCRIPTION_PREFIX = "kx/";

const TAG_IN_TEXT = /(?:^|\s)kx\/([a-z][a-z0-9-]{0,39})(?=$|[\s.,;:!?)])/gi;

function descriptionTags(description: string): readonly (SourceTag | null)[] {
  return [...description.matchAll(TAG_IN_TEXT)].map((m) => {
    const id = `${DESCRIPTION_PREFIX}${(m[1] ?? "").toLowerCase()}`;
    return tag("description_tag", id, id);
  });
}

export const driveProvider: TagProvider = {
  source: "drive",
  kinds: ["folder", "description_tag"],
  howToRead:
    'Pass the folder the file is in as {"kind": "folder", "id": "<folder id>", "name": "<folder name>"} (one entry per parent folder), ' +
    'and the file\'s description, if it has one, as {"kind": "description", "name": "<the description text, unchanged>"}.',
  normalize: (raw) =>
    unique(
      raw.flatMap((r) => {
        const kind = text(r.kind);
        if (kind === "folder") return [text(r.id) ? tag("folder", text(r.id), text(r.name) || text(r.id)) : null];
        if (kind === "description") return descriptionTags(text(r.name));
        return [];
      }),
    ),
};
