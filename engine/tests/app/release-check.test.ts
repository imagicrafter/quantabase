import { describe, it, expect } from "vitest";
import {
  appIdOf,
  cleanText,
  compareVersions,
  createReleaseCheck,
  DEFAULT_RELEASE_REPO,
  newerEntries,
  parseVersion,
  releaseRepoOf,
  type FetchLike,
} from "../../src/app/release-check.js";

const CHANGELOG = `# Changelog

Intro text.

## Unreleased

- not out yet

## [1.2.0] - 2026-12-01

- Added the Updates card.

## 1.1.0

- Faster search.

## [1.0.0] - 2026-11-30

- First public release.

## [1.0.0-rc.1]

- Release candidate.
`;

type Call = { url: string; signal?: AbortSignal | null };

function fakeFetch(files: Record<string, string | number | Error>, calls: Call[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, signal: init?.signal ?? null });
    const name = url.split("/").pop() ?? "";
    const value = files[name];
    if (value instanceof Error) throw value;
    if (typeof value === "number") return new Response("nope", { status: value });
    if (value === undefined) return new Response("missing", { status: 404 });
    return new Response(value, { status: 200 });
  };
}

const ok = { VERSION: "1.2.0\n", "CHANGELOG.md": CHANGELOG };

describe("versions", () => {
  it("parses strict semver only", () => {
    expect(parseVersion("1.2.3")).not.toBeNull();
    expect(parseVersion("1.0.0-rc.1")).not.toBeNull();
    expect(parseVersion(" 1.2.3 ")).toBeNull();
    expect(parseVersion("v1.2.3")).toBeNull();
    expect(parseVersion("01.2.3")).toBeNull();
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("<script>")).toBeNull();
  });

  it("orders releases, prereleases below their release", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.1.9", "1.2.0")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta", "1.0.0-alpha")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareVersions("10.0.0", "9.9.9")).toBeGreaterThan(0);
  });
});

describe("changelog", () => {
  it("returns the entries newer than the running version, up to the latest, newest first", () => {
    const entries = newerEntries(CHANGELOG, "1.0.0", "1.2.0");
    expect(entries.map((e) => e.version)).toEqual(["1.2.0", "1.1.0"]);
    expect(entries[0]!.text).toContain("Added the Updates card.");
    expect(entries[0]!.text).not.toContain("1.1.0");
  });

  it("skips Unreleased and anything above the stable version", () => {
    expect(newerEntries(CHANGELOG, "1.0.0", "1.1.0").map((e) => e.version)).toEqual(["1.1.0"]);
    expect(newerEntries(CHANGELOG, "1.0.0-rc.1", "1.0.0").map((e) => e.version)).toEqual(["1.0.0"]);
  });

  it("caps the number of entries and the text", () => {
    const many = Array.from({ length: 12 }, (_, i) => `## ${i + 2}.0.0\n\n${"x".repeat(2000)}\n`).join("\n");
    const entries = newerEntries(many, "1.0.0", "20.0.0");
    expect(entries.length).toBeLessThanOrEqual(5);
    expect(entries.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(4000);
  });

  it("strips control characters and keeps text plain", () => {
    expect(cleanText("a\u0000b\u001b[31mc\r\nd\te")).toBe("ab[31mc\nd\te");
  });
});

describe("settings", () => {
  it("accepts owner/repo and falls back to the default otherwise", () => {
    expect(releaseRepoOf(undefined)).toBe(DEFAULT_RELEASE_REPO);
    expect(releaseRepoOf("")).toBe(DEFAULT_RELEASE_REPO);
    expect(releaseRepoOf("acme/engine.fork")).toBe("acme/engine.fork");
    expect(releaseRepoOf("acme/../x")).toBe(DEFAULT_RELEASE_REPO);
    expect(releaseRepoOf("https://evil.example/x")).toBe(DEFAULT_RELEASE_REPO);
    expect(DEFAULT_RELEASE_REPO).toBe("imagicrafter/quantabase");
  });

  it("keeps an app id only when it is a real UUID", () => {
    const id = "0f1e2d3c-4b5a-4968-8776-655443322110";
    expect(appIdOf(id)).toBe(id);
    expect(appIdOf(id.toUpperCase())).toBe(id);
    expect(appIdOf("${APP_ID}")).toBeNull();
    expect(appIdOf("")).toBeNull();
    expect(appIdOf(undefined)).toBeNull();
    expect(appIdOf("not-an-id")).toBeNull();
  });
});

describe("the release check", () => {
  const at = (t: number) => () => t;

  it("reads VERSION and CHANGELOG from the stable branch over HTTPS, no token", async () => {
    const calls: Call[] = [];
    const check = createReleaseCheck({ repo: "acme/qb", fetch: fakeFetch(ok, calls), now: at(0) });
    const r = await check("1.0.0");
    expect(r).toMatchObject({ ok: true, latest: "1.2.0", newer: true, repo: "acme/qb" });
    expect(r.ok && r.notes.map((n) => n.version)).toEqual(["1.2.0", "1.1.0"]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://raw.githubusercontent.com/acme/qb/stable/VERSION",
      "https://raw.githubusercontent.com/acme/qb/stable/CHANGELOG.md",
    ]);
    expect(calls.every((c) => c.signal instanceof AbortSignal)).toBe(true);
  });

  it("says up to date when the running version is the same or newer", async () => {
    const same = await createReleaseCheck({ repo: "a/b", fetch: fakeFetch(ok), now: at(0) })("1.2.0");
    expect(same).toMatchObject({ ok: true, newer: false, notes: [] });
    const ahead = await createReleaseCheck({ repo: "a/b", fetch: fakeFetch(ok), now: at(0) })("1.3.0-rc.1");
    expect(ahead).toMatchObject({ ok: true, newer: false, notes: [] });
  });

  it("cannot compare an unknown running version, but still names the latest", async () => {
    const r = await createReleaseCheck({ repo: "a/b", fetch: fakeFetch(ok), now: at(0) })("unknown");
    expect(r).toMatchObject({ ok: true, latest: "1.2.0", newer: null, notes: [] });
  });

  it("fails quietly on a network error, a non-200 or a bad VERSION", async () => {
    for (const files of [
      { VERSION: new Error("ECONNRESET"), "CHANGELOG.md": CHANGELOG },
      { VERSION: 503, "CHANGELOG.md": CHANGELOG },
      { VERSION: "<b>1.2.0</b>", "CHANGELOG.md": CHANGELOG },
      { VERSION: "1.2", "CHANGELOG.md": CHANGELOG },
    ]) {
      const r = await createReleaseCheck({ repo: "a/b", fetch: fakeFetch(files), now: at(0) })("1.0.0");
      expect(r).toEqual({ ok: false });
    }
  });

  it("still reports the version when only the changelog is missing", async () => {
    const r = await createReleaseCheck({ repo: "a/b", fetch: fakeFetch({ VERSION: "1.2.0" }), now: at(0) })("1.0.0");
    expect(r).toMatchObject({ ok: true, latest: "1.2.0", newer: true, notes: [] });
  });

  it("refuses an oversized body", async () => {
    const big = { VERSION: "1.2.0", "CHANGELOG.md": "x".repeat(300 * 1024) };
    const r = await createReleaseCheck({ repo: "a/b", fetch: fakeFetch(big), now: at(0) })("1.0.0");
    expect(r).toMatchObject({ ok: true, notes: [] });
    const bigVersion = await createReleaseCheck({ repo: "a/b", fetch: fakeFetch({ VERSION: "1".repeat(300 * 1024) }), now: at(0) })("1.0.0");
    expect(bigVersion).toEqual({ ok: false });
  });

  it("gives up after the timeout", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const r = await createReleaseCheck({ repo: "a/b", fetch: hang, now: at(0), timeoutMs: 5 })("1.0.0");
    expect(r).toEqual({ ok: false });
  });

  it("caches an answer for an hour, then asks again", async () => {
    const calls: Call[] = [];
    let t = 0;
    const check = createReleaseCheck({ repo: "a/b", fetch: fakeFetch(ok, calls), now: () => t });
    await check("1.0.0");
    t = 59 * 60 * 1000;
    await check("1.1.0");
    expect(calls).toHaveLength(2);
    t = 61 * 60 * 1000;
    await check("1.0.0");
    expect(calls).toHaveLength(4);
  });

  it("uses the cached files for a different running version", async () => {
    const check = createReleaseCheck({ repo: "a/b", fetch: fakeFetch(ok), now: at(0) });
    await check("1.0.0");
    expect(await check("1.1.0")).toMatchObject({ newer: true, notes: [{ version: "1.2.0" }] });
  });

  it("retries a failure after a few minutes, not an hour", async () => {
    const calls: Call[] = [];
    let t = 0;
    const check = createReleaseCheck({ repo: "a/b", fetch: fakeFetch({ VERSION: 500 }, calls), now: () => t });
    await check("1.0.0");
    await check("1.0.0");
    expect(calls).toHaveLength(1);
    t = 6 * 60 * 1000;
    await check("1.0.0");
    expect(calls).toHaveLength(2);
  });
});
