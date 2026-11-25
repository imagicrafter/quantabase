import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();

vi.mock("../../src/supabase.js", () => ({
  supabase: { schema: () => ({ rpc: rpcMock }) },
}));

const { reportIssue, reportIssueSchema, reportIssueTool } =
  await import("../../src/tools/report-issue.js");

const ISSUE_ID = "3f2b8c1e-9a4d-4c7b-8e21-5d6f7a8b9c0d";
const CTX = { sub: "sub-1", email: "rita@example.com" };

describe("report_issue schema", () => {
  it("accepts the three user categories only", () => {
    for (const category of [
      "data_quality_issue",
      "feature_gap",
      "friction_point",
    ]) {
      expect(() =>
        reportIssueSchema.parse({ category, title: "A real title" }),
      ).not.toThrow();
    }
    for (const category of [
      "source_failure",
      "config_invalid",
      "unknown_tag",
      "",
    ]) {
      expect(() =>
        reportIssueSchema.parse({ category, title: "A real title" }),
      ).toThrow();
    }
  });

  it("requires a title of 5 to 120 characters after trimming", () => {
    const base = { category: "feature_gap" };
    expect(() => reportIssueSchema.parse({ ...base, title: "abcd" })).toThrow();
    expect(() =>
      reportIssueSchema.parse({ ...base, title: "   abcd   " }),
    ).toThrow();
    expect(() =>
      reportIssueSchema.parse({ ...base, title: "a".repeat(121) }),
    ).toThrow();
    expect(reportIssueSchema.parse({ ...base, title: " abcde " }).title).toBe(
      "abcde",
    );
    expect(() =>
      reportIssueSchema.parse({ ...base, title: "a".repeat(120) }),
    ).not.toThrow();
  });

  it("caps detail at 1000 characters and makes it optional", () => {
    const base = { category: "feature_gap", title: "A real title" };
    expect(reportIssueSchema.parse(base).detail).toBeUndefined();
    expect(() =>
      reportIssueSchema.parse({ ...base, detail: "d".repeat(1001) }),
    ).toThrow();
    expect(() =>
      reportIssueSchema.parse({ ...base, detail: "d".repeat(1000) }),
    ).not.toThrow();
  });

  it("rejects unknown fields, so a caller cannot name another reporter", () => {
    expect(() =>
      reportIssueSchema.parse({
        category: "feature_gap",
        title: "A real title",
        email: "someone-else@example.com",
      }),
    ).toThrow();
  });
});

describe("report_issue", () => {
  beforeEach(() => rpcMock.mockReset());

  it("sends the verified email and returns the issue id", async () => {
    rpcMock.mockResolvedValue({ data: ISSUE_ID, error: null });
    const result = await reportIssue(
      { category: "friction_point", title: "Search is slow", detail: "Slow." },
      "rita@example.com",
    );
    expect(rpcMock).toHaveBeenCalledWith("issue_report", {
      p_email: "rita@example.com",
      p_category: "friction_point",
      p_title: "Search is slow",
      p_detail: "Slow.",
    });
    expect(result.id).toBe(ISSUE_ID);
    expect(result.message).toContain(ISSUE_ID);
  });

  it("sends null when there is no detail", async () => {
    rpcMock.mockResolvedValue({ data: ISSUE_ID, error: null });
    await reportIssue(
      { category: "feature_gap", title: "A real title", detail: "" },
      "rita@example.com",
    );
    expect(rpcMock.mock.calls[0]![1].p_detail).toBeNull();
  });

  it("the tool takes the email from the session, not from its arguments", async () => {
    rpcMock.mockResolvedValue({ data: ISSUE_ID, error: null });
    await reportIssueTool.run(
      { category: "feature_gap", title: "A real title" },
      CTX,
    );
    expect(rpcMock.mock.calls[0]![1].p_email).toBe("rita@example.com");
    await expect(
      reportIssueTool.run({ category: "nope", title: "A real title" }, CTX),
    ).rejects.toThrow();
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["42501", "forbidden", "Your account is not active on this Engine"],
    ["KB429", "rate_limited", "too many issues reported in the last hour"],
    ["22023", "invalid_argument", "title must be 5 to 120 characters"],
    ["XX000", "internal_error", "The issue could not be logged"],
  ])("maps database error %s to %s", async (code, expected, message) => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code, message: code === "42501" ? "secret db text" : message },
    });
    await expect(
      reportIssue(
        { category: "feature_gap", title: "A real title" },
        "x@example.com",
      ),
    ).rejects.toMatchObject({ code: expected, message });
  });

  it("hides the text of an unexpected database error", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: {
        code: "XX000",
        message: 'relation "workspace.issues" is broken',
      },
    });
    await expect(
      reportIssue(
        { category: "feature_gap", title: "A real title" },
        "x@example.com",
      ),
    ).rejects.toThrow("The issue could not be logged");
  });

  it("fails when the database returns no id", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    await expect(
      reportIssue(
        { category: "feature_gap", title: "A real title" },
        "x@example.com",
      ),
    ).rejects.toMatchObject({ code: "internal_error" });
  });
});
