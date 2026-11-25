import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
const embedMock = vi.fn();

vi.mock("../../src/supabase.js", () => ({
  embedText: embedMock,
  supabase: { schema: () => ({ rpc: rpcMock }) },
}));

const { whoKnows, whoKnowsSchema, countPeople } =
  await import("../../src/tools/who-knows.js");

describe("who_knows schema", () => {
  it("rejects empty topic", () => {
    expect(() => whoKnowsSchema.parse({ topic: "" })).toThrow();
  });

  it("rejects topic over 1000 chars", () => {
    expect(() => whoKnowsSchema.parse({ topic: "a".repeat(1001) })).toThrow();
  });

  it("accepts valid topic", () => {
    expect(() =>
      whoKnowsSchema.parse({ topic: "dispatch pipeline" }),
    ).not.toThrow();
  });
});

describe("countPeople", () => {
  it("counts authors and participants from the rows it is given, most documents first", () => {
    const people = countPeople([
      { id: "d1", title: "One", author: " Ada ", participants: ["Bea", "Cy"] },
      { id: "d2", title: "Two", author: "Bea", participants: ["Ada"] },
      { id: "d3", title: "Three", author: null, participants: ["Bea"] },
    ]);
    expect(people.map((p) => [p.name, p.document_count])).toEqual([
      ["Bea", 3],
      ["Ada", 2],
      ["Cy", 1],
    ]);
    expect(people[1]!.evidence).toEqual([
      { id: "d1", title: "One", role: "author" },
      { id: "d2", title: "Two", role: "participant" },
    ]);
  });

  it("counts a person once per document, as author before participant", () => {
    const people = countPeople([
      { id: "d1", title: "One", author: "Ada", participants: ["Ada", "ada"] },
    ]);
    expect(people).toEqual([
      {
        name: "Ada",
        document_count: 1,
        evidence: [{ id: "d1", title: "One", role: "author" }],
      },
    ]);
  });

  it("ignores empty, missing and malformed people", () => {
    expect(
      countPeople([
        { id: "d1", title: "One", author: "  ", participants: "Ada" },
        { id: "d2", title: "Two", participants: [null, 7, "", " "] },
        { id: "d3", title: "Three" },
      ]),
    ).toEqual([]);
  });

  it("does not change the rows it is given", () => {
    const rows = [
      Object.freeze({
        id: "d1",
        title: "One",
        author: "Ada",
        participants: Object.freeze(["Bea"]),
      }),
    ];
    expect(() => countPeople(rows)).not.toThrow();
  });
});

describe("whoKnows", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    embedMock.mockReset();
    embedMock.mockResolvedValue([0.1, 0.2]);
  });

  it("asks the same access-filtered search as `search`, as the caller, and counts only what comes back", async () => {
    rpcMock.mockResolvedValue({
      data: [{ id: "d1", title: "One", author: "Ada", participants: ["Bea"] }],
      error: null,
    });
    const result = await whoKnows({ topic: "roadmap" }, "sub-reader");
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("documents_search_by_oauth_subject", {
      p_oauth_subject: "sub-reader",
      query_text: "roadmap",
      query_embedding: [0.1, 0.2],
      match_count: 50,
    });
    expect(result.people.map((p) => p.name)).toEqual(["Ada", "Bea"]);
  });

  it("returns nobody when the caller can see no matching document", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    expect(await whoKnows({ topic: "roadmap" }, "sub-zed")).toEqual({
      people: [],
    });
    rpcMock.mockResolvedValue({ data: null, error: null });
    expect(await whoKnows({ topic: "roadmap" }, "sub-zed")).toEqual({
      people: [],
    });
  });

  it("fails closed on a database error, without passing on its text", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "XX000", message: "secret detail" },
    });
    await expect(
      whoKnows({ topic: "roadmap" }, "sub-reader"),
    ).rejects.toMatchObject({
      code: "internal_error",
      message: "Search failed",
    });
  });

  it("fails closed when the topic cannot be embedded", async () => {
    embedMock.mockRejectedValue(new Error("down"));
    await expect(
      whoKnows({ topic: "roadmap" }, "sub-reader"),
    ).rejects.toMatchObject({ code: "internal_error" });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
