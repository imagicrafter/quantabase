import { blobSha } from "../../src/backup/github.js";

/**
 * A small in-memory GitHub: one repository, its refs, commits and trees, and
 * the handful of REST calls the backup makes. Records every request (with
 * its headers) so tests can check what was sent and that the token went
 * only into Authorization.
 */

type Tree = Map<string, string>; // path -> content

export type FakeRequest = { method: string; path: string; headers: Record<string, string>; body: unknown };

export function fakeGitHub(opts: { private?: boolean; empty?: boolean; token?: string; truncated?: boolean } = {}) {
  const token = opts.token ?? "ghp_faketoken000000000000";
  const trees = new Map<string, Tree>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const refs = new Map<string, string>();
  const blobs = new Map<string, string>();
  const requests: FakeRequest[] = [];
  let n = 0;
  const id = (p: string) => `${p}${String(++n).padStart(40 - p.length, "0")}`;

  const put = (files: Tree) => {
    const t = id("t");
    trees.set(t, new Map(files));
    return t;
  };
  if (!opts.empty) {
    const t = put(new Map([["README.md", "hello\n"]]));
    const c = id("c");
    commits.set(c, { tree: t, parents: [], message: "init" });
    refs.set("main", c);
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const route = (method: string, path: string, body: Record<string, unknown>): Response => {
    const repo = /^\/repos\/acme\/kb-backup(\/.*)?$/.exec(path);
    if (!repo) return json(404, { message: "Not Found" });
    const rest = repo[1] ?? "";
    if (method === "GET" && rest === "") return json(200, { private: opts.private ?? true });
    let m = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (method === "GET" && m) {
      if (refs.size === 0) return json(409, { message: "Git Repository is empty." });
      const sha = refs.get(decodeURIComponent(m[1] ?? ""));
      return sha ? json(200, { object: { sha } }) : json(404, { message: "Not Found" });
    }
    m = /^\/git\/commits\/(\w+)$/.exec(rest);
    if (method === "GET" && m) {
      const c = commits.get(m[1] ?? "");
      return c ? json(200, { tree: { sha: c.tree } }) : json(404, {});
    }
    m = /^\/git\/trees\/(\w+)\?recursive=1$/.exec(rest);
    if (method === "GET" && m) {
      const t = trees.get(m[1] ?? "");
      if (!t) return json(404, {});
      return json(200, { truncated: opts.truncated ?? false, tree: [...t].map(([p, c]) => ({ path: p, type: "blob", sha: blobSha(c) })) });
    }
    if (method === "PUT" && rest === "/contents/README.md") {
      if (refs.size > 0) return json(422, {});
      const t = put(new Map([["README.md", Buffer.from(String(body["content"]), "base64").toString("utf8")]]));
      const c = id("c");
      commits.set(c, { tree: t, parents: [], message: String(body["message"]) });
      refs.set(String(body["branch"]), c);
      return json(201, { commit: { sha: c } });
    }
    if (method === "POST" && rest === "/git/blobs") {
      const sha = blobSha(String(body["content"]));
      blobs.set(sha, String(body["content"]));
      return json(201, { sha });
    }
    if (method === "POST" && rest === "/git/trees") {
      if (refs.size === 0) return json(409, { message: "Git Repository is empty." });
      const entries = body["tree"] as Array<Record<string, string>>;
      const known = new Map<string, string>();
      for (const t of trees.values()) for (const c of t.values()) known.set(blobSha(c), c);
      for (const [sha, c] of blobs) known.set(sha, c);
      const files: Tree = new Map();
      for (const e of entries) {
        const content = e["content"] ?? known.get(e["sha"] ?? "");
        if (content === undefined) return json(422, { message: "bad sha" });
        files.set(String(e["path"]), content);
      }
      return json(201, { sha: put(files) });
    }
    if (method === "POST" && rest === "/git/commits") {
      const c = id("c");
      commits.set(c, { tree: String(body["tree"]), parents: body["parents"] as string[], message: String(body["message"]) });
      return json(201, { sha: c });
    }
    m = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
    if (method === "PATCH" && m) {
      refs.set(decodeURIComponent(m[1] ?? ""), String(body["sha"]));
      return json(200, {});
    }
    if (method === "POST" && rest === "/git/refs") {
      refs.set(String(body["ref"]).replace("refs/heads/", ""), String(body["sha"]));
      return json(201, {});
    }
    return json(404, { message: "Not Found" });
  };

  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const path = `${u.pathname}${u.search}`;
    requests.push({ method: init.method ?? "GET", path, headers, body });
    if (u.hostname !== "api.github.com") return json(400, {});
    if (headers["authorization"] !== `Bearer ${token}`) return json(401, { message: "Bad credentials" });
    return route(init.method ?? "GET", path, body);
  };

  /** The files on a branch now. */
  const filesOn = (branch: string): Tree => {
    const c = refs.get(branch);
    return c ? new Map(trees.get(commits.get(c)?.tree ?? "") ?? []) : new Map();
  };
  const commitCount = () => commits.size;
  const parentsOf = (branch: string) => commits.get(refs.get(branch) ?? "")?.parents ?? [];

  return { fetch, requests, token, filesOn, commitCount, parentsOf, refs };
}
