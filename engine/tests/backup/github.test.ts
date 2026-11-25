import { describe, expect, it } from "vitest";
import { GitHubError, blobSha, pushFiles } from "../../src/backup/github.js";
import { fakeGitHub } from "./fake-github.js";

const files = (entries: Array<[string, string]>) => new Map(entries);

function push(gh: ReturnType<typeof fakeGitHub>, f: Map<string, string>, over: { token?: string; branch?: string } = {}) {
  return pushFiles({
    token: over.token ?? gh.token,
    repo: "acme/kb-backup",
    branch: over.branch ?? "main",
    files: f,
    message: "Engine backup",
    fetch: gh.fetch,
  });
}

describe("blobSha", () => {
  it("is git's blob id", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(blobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("pushFiles", () => {
  it("replaces the branch with exactly the given files in one commit", async () => {
    const gh = fakeGitHub();
    const out = await push(gh, files([["index.md", "# i\n"], ["people/Bob.md", "bob\n"]]));
    expect(out.status).toBe("done");
    expect(out.files).toBe(2);
    expect([...gh.filesOn("main").keys()].sort()).toEqual(["index.md", "people/Bob.md"]);
    expect(gh.parentsOf("main")).toHaveLength(1);
  });

  it("makes no commit when nothing changed", async () => {
    const gh = fakeGitHub();
    const f = files([["index.md", "# i\n"]]);
    await push(gh, f);
    const count = gh.commitCount();
    const again = await push(gh, f);
    expect(again.status).toBe("unchanged");
    expect(gh.commitCount()).toBe(count);
  });

  it("sends unchanged files by id and only changed files as text; removes what is gone", async () => {
    const gh = fakeGitHub();
    await push(gh, files([["a.md", "one\n"], ["b.md", "two\n"]]));
    await push(gh, files([["a.md", "one\n"], ["c.md", "three\n"]]));
    const tree = gh.requests.filter((r) => r.path.endsWith("/git/trees") && r.method === "POST").at(-1);
    const entries = (tree?.body as { tree: Array<Record<string, string>> }).tree;
    expect(entries.find((e) => e["path"] === "a.md")).toMatchObject({ sha: blobSha("one\n") });
    expect(entries.find((e) => e["path"] === "c.md")).toMatchObject({ content: "three\n" });
    expect([...gh.filesOn("main").keys()].sort()).toEqual(["a.md", "c.md"]);
  });

  it("starts an empty repository, then writes the backup", async () => {
    const gh = fakeGitHub({ empty: true });
    const out = await push(gh, files([["index.md", "# i\n"]]));
    expect(out.status).toBe("done");
    expect([...gh.filesOn("main").keys()]).toEqual(["index.md"]);
  });

  it("makes a missing branch from nothing", async () => {
    const gh = fakeGitHub();
    await push(gh, files([["index.md", "# i\n"]]), { branch: "backup" });
    expect([...gh.filesOn("backup").keys()]).toEqual(["index.md"]);
    expect(gh.parentsOf("backup")).toEqual([]);
    expect([...gh.filesOn("main").keys()]).toEqual(["README.md"]);
  });

  it("uploads blobs one by one for a large change", async () => {
    const gh = fakeGitHub();
    const many = files(Array.from({ length: 301 }, (_, i) => [`p/${i}.md`, `page ${i}\n`] as [string, string]));
    await push(gh, many);
    expect(gh.requests.filter((r) => r.path.endsWith("/git/blobs")).length).toBe(301);
    expect(gh.filesOn("main").size).toBe(301);
  });

  it("refuses a public repository before writing anything", async () => {
    const gh = fakeGitHub({ private: false });
    await expect(push(gh, files([["index.md", "x\n"]]))).rejects.toThrow(/must be private/);
    expect(gh.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("names the step and status on failure, never the token", async () => {
    const gh = fakeGitHub();
    const err = await push(gh, files([["index.md", "x\n"]]), { token: "ghp_wrongwrongwrongwrong" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).message).toMatch(/check repository: the token was refused .*HTTP 401/);
    expect((err as GitHubError).message).not.toContain("ghp_");
  });

  it("puts the token in the Authorization header only, and calls api.github.com only", async () => {
    const gh = fakeGitHub();
    await push(gh, files([["index.md", "x\n"]]));
    for (const r of gh.requests) {
      expect(r.headers["authorization"]).toBe(`Bearer ${gh.token}`);
      expect(r.path).not.toContain(gh.token);
      expect(JSON.stringify(r.body)).not.toContain(gh.token);
    }
  });
});
