import { describe, it, expect } from "vitest";
import { getDocumentSchema } from "../../src/tools/get-document.js";

describe("get_document schema", () => {
  it("rejects non-UUID id", () => {
    expect(() => getDocumentSchema.parse({ id: "not-a-uuid" })).toThrow();
  });

  it("accepts valid UUID", () => {
    expect(() =>
      getDocumentSchema.parse({ id: "00000000-0000-0000-0000-000000000000" }),
    ).not.toThrow();
  });
});
