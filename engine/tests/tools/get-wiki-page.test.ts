import { describe, it, expect } from "vitest";
import { getWikiPageSchema } from "../../src/tools/get-wiki-page.js";

describe("get_wiki_page schema", () => {
  it("rejects empty title_or_path", () => {
    expect(() => getWikiPageSchema.parse({ title_or_path: "" })).toThrow();
  });

  it("rejects title over 500 chars", () => {
    expect(() =>
      getWikiPageSchema.parse({ title_or_path: "a".repeat(501) }),
    ).toThrow();
  });

  it("accepts a wildcard character literally (escaping is the DB function's job)", () => {
    // The schema accepts %, _, etc — escaping happens in wiki_page_get SQL function
    expect(() => getWikiPageSchema.parse({ title_or_path: "%" })).not.toThrow();
    expect(() => getWikiPageSchema.parse({ title_or_path: "_" })).not.toThrow();
  });
});
