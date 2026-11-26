import { describe, expect, it } from "vitest";
import type { CurateDeps } from "../../src/curator/curate.js";
import type { PlannedNewPage } from "../../src/curator/output.js";
import { fileByName } from "../../src/curator/namematch.js";
import { hasStrongKey } from "../../src/curator/quality.js";
import { sameAsExisting } from "../../src/curator/similar.js";
import { entitySchema } from "../../src/entities/templates.js";
import { fakeStore, item, page } from "./fixtures.js";

/**
 * A weekly meeting keeps its title but each one has its own meeting id (or
 * date-slug key). The curator must never fold a new meeting into an older
 * meeting page by title: a meeting is the same meeting only under the same
 * key (the same rule page_import follows from migration 0079). Fiction only.
 */

const schema = entitySchema(["consulting"]);
const meetings = schema.drawers.find((d) => d.id === "meetings")!;
const TITLE = "Pat / Sam sync-up";

const newMeeting = (key: string): PlannedNewPage => ({
  drawer: "meetings", key, title: TITLE, description: "", fields: {}, related: [],
  sections: [{ heading: "Summary", text: "2025-06-10: Pat and Sam agreed the next step." }],
});

const WEEK_ONE = page({ key: "meeting:01ab", title: TITLE, drawer: "meetings", body: "# x\n" });
const SLUG_DAY_ONE = page({ key: "meeting:2025-06-10-pat-sam-sync-up", title: TITLE, drawer: "meetings", body: "# x\n" });

describe("recurring meetings in the curator", () => {
  it("treats every meeting key as strong, so names are never used to match it", () => {
    expect(meetings.key_rule.kind).toBe("source_id");
    expect(hasStrongKey(meetings, "meeting:01cd")).toBe(true);
    expect(hasStrongKey(meetings, "meeting:2025-06-11-pat-sam-sync-up")).toBe(true);
  });

  it("does not file a meeting with another id on an older meeting with the same title", () => {
    expect(sameAsExisting(newMeeting("meeting:01cd"), [WEEK_ONE], schema)).toBeNull();
  });

  it("does not file a date-slug meeting one day later on the day before", () => {
    expect(sameAsExisting(newMeeting("meeting:2025-06-11-pat-sam-sync-up"), [SLUG_DAY_ONE], schema)).toBeNull();
  });

  it("fileByName keeps the new meeting and never asks the database for a name match", async () => {
    const f = fakeStore([WEEK_ONE]);
    const deps = { store: f.store, schema } as unknown as CurateDeps;
    const plan = { updates: [], newPages: [newMeeting("meeting:01cd")], notes: "" };
    const out = await fileByName(plan, [WEEK_ONE], item(), deps, async () => null, [WEEK_ONE]);
    expect(out.plan.newPages.map((n) => n.key)).toEqual(["meeting:01cd"]);
    expect(out.plan.updates).toEqual([]);
    expect(out.matched).toBe(0);
    expect(f.store.nameMatch).not.toHaveBeenCalled();
  });
});
