import { createHash } from "node:crypto";

/**
 * Write a whole set of files to one branch of one GitHub repository as a
 * single commit, through the Git Data API (no git binary, no clone).
 *
 * ONE WAY: the tree is built from the given files alone (no base tree), so a
 * file that is not given is removed and anything edited in the repository is
 * overwritten. Nothing is ever read back except blob ids, to skip an
 * unchanged run.
 *
 * PRIVATE ONLY: the repository is checked before every write and refused if
 * it is public (the backup has no row protection).
 *
 * THE TOKEN goes in the Authorization header and nowhere else: errors carry
 * the step and the HTTP status only.
 */

export const GITHUB_API_HOST = "api.github.com";
const API = `https://${GITHUB_API_HOST}`;
/** Above this many changed files or bytes, blobs go up one by one instead of inline. */
const INLINE_MAX_FILES = 300;
const INLINE_MAX_BYTES = 4 * 1024 * 1024;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class GitHubError extends Error {
  constructor(
    readonly step: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type PushResult = { readonly status: "done" | "unchanged"; readonly commit: string; readonly files: number };

/** Git's blob id for a text file. */
export function blobSha(text: string): string {
  const data = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

type Json = Record<string, unknown>;

function client(token: string, fetchFn: FetchLike) {
  return async (step: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> => {
    const res = await fetchFn(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "kb-engine-backup",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    return { status: res.status, json };
  };
}

type Call = ReturnType<typeof client>;

function fail(step: string, status: number): never {
  const why =
    status === 401 ? "the token was refused (expired or wrong)"
    : status === 403 ? "the token may not write to this repository"
    : status === 404 ? "the repository was not found, or the token cannot see it"
    : status === 409 ? "the repository is empty or busy"
    : status === 422 ? "GitHub did not accept the change"
    : `GitHub answered ${status}`;
  throw new GitHubError(step, status, `${step}: ${why} (HTTP ${status})`);
}

const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");

async function checkPrivate(call: Call, repo: string): Promise<void> {
  const r = await call("check repository", "GET", `/repos/${enc(repo)}`);
  if (r.status !== 200) fail("check repository", r.status);
  if (r.json["private"] !== true) {
    throw new GitHubError("check repository", 200, "check repository: the backup repository must be private");
  }
}

/** The branch head commit, null when the branch does not exist, "empty" for a repository with no commits. */
async function head(call: Call, repo: string, branch: string): Promise<string | null | "empty"> {
  const r = await call("read branch", "GET", `/repos/${enc(repo)}/git/ref/heads/${enc(branch)}`);
  if (r.status === 409) return "empty";
  if (r.status === 404) return null;
  if (r.status !== 200) fail("read branch", r.status);
  const sha = (r.json["object"] as Json | undefined)?.["sha"];
  return typeof sha === "string" ? sha : null;
}

/**
 * The Git Data API cannot write to a repository with no commits at all, so
 * the first backup into a brand-new repository makes one small commit
 * through the contents API, then carries on as usual.
 */
async function seed(call: Call, repo: string, branch: string): Promise<string> {
  const r = await call("start repository", "PUT", `/repos/${enc(repo)}/contents/README.md`, {
    message: "Start the Engine backup",
    content: Buffer.from("# Engine backup\n\nWritten by the Engine each night. One way: edits here are overwritten.\n").toString("base64"),
    branch,
  });
  if (r.status !== 201) fail("start repository", r.status);
  const sha = (r.json["commit"] as Json | undefined)?.["sha"];
  if (typeof sha !== "string") fail("start repository", r.status);
  return sha;
}

/** path -> blob id of the files at a commit; null when the listing is cut short. */
async function existing(call: Call, repo: string, commit: string): Promise<{ tree: string; blobs: Map<string, string> | null }> {
  const c = await call("read commit", "GET", `/repos/${enc(repo)}/git/commits/${commit}`);
  if (c.status !== 200) fail("read commit", c.status);
  const tree = String((c.json["tree"] as Json | undefined)?.["sha"] ?? "");
  const t = await call("read tree", "GET", `/repos/${enc(repo)}/git/trees/${tree}?recursive=1`);
  if (t.status !== 200) fail("read tree", t.status);
  if (t.json["truncated"] === true) return { tree, blobs: null };
  const entries = Array.isArray(t.json["tree"]) ? (t.json["tree"] as Json[]) : [];
  return { tree, blobs: new Map(entries.filter((e) => e["type"] === "blob").map((e) => [String(e["path"]), String(e["sha"])])) };
}

function unchanged(files: ReadonlyMap<string, string>, blobs: Map<string, string> | null): boolean {
  if (!blobs || blobs.size !== files.size) return false;
  return [...files].every(([path, text]) => blobs.get(path) === blobSha(text));
}

async function treeEntries(call: Call, repo: string, files: ReadonlyMap<string, string>, blobs: Map<string, string> | null) {
  const changed = [...files].filter(([path, text]) => blobs?.get(path) !== blobSha(text));
  const bytes = changed.reduce((n, [, text]) => n + Buffer.byteLength(text), 0);
  const inline = changed.length <= INLINE_MAX_FILES && bytes <= INLINE_MAX_BYTES;
  const uploaded = new Map<string, string>();
  if (!inline) {
    for (const [path, text] of changed) {
      const b = await call("upload file", "POST", `/repos/${enc(repo)}/git/blobs`, { content: text, encoding: "utf-8" });
      if (b.status !== 201) fail("upload file", b.status);
      uploaded.set(path, String(b.json["sha"]));
    }
  }
  return [...files].map(([path, text]) => {
    const sha = blobs?.get(path) === blobSha(text) ? blobSha(text) : uploaded.get(path);
    return sha ? { path, mode: "100644", type: "blob", sha } : { path, mode: "100644", type: "blob", content: text };
  });
}

/** Commit `files` as the whole content of `branch`. */
export async function pushFiles(opts: {
  readonly token: string;
  readonly repo: string;
  readonly branch: string;
  readonly files: ReadonlyMap<string, string>;
  readonly message: string;
  readonly fetch: FetchLike;
}): Promise<PushResult> {
  const call = client(opts.token, opts.fetch);
  await checkPrivate(call, opts.repo);
  const found = await head(call, opts.repo, opts.branch);
  const parent = found === "empty" ? await seed(call, opts.repo, opts.branch) : found;
  const before = parent ? await existing(call, opts.repo, parent) : { tree: "", blobs: new Map<string, string>() };
  if (parent && unchanged(opts.files, before.blobs)) {
    return { status: "unchanged", commit: parent, files: opts.files.size };
  }
  const tree = await call("write tree", "POST", `/repos/${enc(opts.repo)}/git/trees`, {
    tree: await treeEntries(call, opts.repo, opts.files, before.blobs),
  });
  if (tree.status !== 201) fail("write tree", tree.status);
  const commit = await call("write commit", "POST", `/repos/${enc(opts.repo)}/git/commits`, {
    message: opts.message,
    tree: tree.json["sha"],
    parents: parent ? [parent] : [],
  });
  if (commit.status !== 201) fail("write commit", commit.status);
  const sha = String(commit.json["sha"]);
  const ref = parent
    ? await call("move branch", "PATCH", `/repos/${enc(opts.repo)}/git/refs/heads/${enc(opts.branch)}`, { sha, force: false })
    : await call("make branch", "POST", `/repos/${enc(opts.repo)}/git/refs`, { ref: `refs/heads/${opts.branch}`, sha });
  if (ref.status !== 200 && ref.status !== 201) fail(parent ? "move branch" : "make branch", ref.status);
  return { status: "done", commit: sha, files: opts.files.size };
}
