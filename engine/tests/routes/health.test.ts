import { describe, it, expect, vi, afterEach } from "vitest";

// env.ts parses process.env once at import time, so each case resets modules
// and re-imports the app after stubbing SOURCE_COMMIT.
async function healthSha(sourceCommit: string | undefined) {
  vi.resetModules();
  if (sourceCommit === undefined) vi.stubEnv("SOURCE_COMMIT", undefined);
  else vi.stubEnv("SOURCE_COMMIT", sourceCommit);
  const { app } = await import("../../src/index.js");
  const res = await app.fetch(new Request("http://localhost/health"));
  return ((await res.json()) as { git_sha: string }).git_sha;
}

describe("GET /health git_sha", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns the commit when SOURCE_COMMIT is a real sha", async () => {
    expect(await healthSha("abc1234")).toBe("abc1234");
  });

  it("returns 'unknown' when SOURCE_COMMIT is unset", async () => {
    expect(await healthSha(undefined)).toBe("unknown");
  });

  it("returns 'unknown' when SOURCE_COMMIT is empty", async () => {
    expect(await healthSha("")).toBe("unknown");
  });

  it("returns 'unknown' when DO leaves the template unexpanded", async () => {
    expect(await healthSha("${_self.commit_hash}")).toBe("unknown");
  });
});
