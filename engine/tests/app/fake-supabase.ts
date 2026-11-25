import type { FetchLike } from "../../src/app/mgmt.js";

/**
 * A pretend Supabase Management API for one project, enough for the Database
 * screen: project status, keys, postgrest config, SQL, function deploy.
 * Records every request (with the Authorization header) so tests can check
 * where the token went.
 */

export const REF = "abcdefghijklmnopqrst";
export const MGMT_TOKEN = "fake-management-token-for-tests-only";
export const JWT_SECRET = "test-secret-at-least-32-chars-long!!";
export const ANON_KEY = "fake-anon-key-for-tests-only";

export type FakeSupabaseOptions = {
  readonly status?: string;
  readonly jwtSecret?: string;
  readonly failSqlMatching?: RegExp;
  readonly projects?: number;
  readonly admins?: string[];
};

export function createFakeSupabase(options: FakeSupabaseOptions = {}) {
  const state = {
    applied: new Map<string, string>(),
    dbSchema: "public,graphql_public",
    deployed: [] as string[],
    vault: new Map<string, string>(),
    principals: {
      embedHash: null as string | null,
      admins: [...(options.admins ?? [])],
      // email -> the names stored for that administrator (0077).
      names: new Map<string, { display: string; page: string | null }>(),
    },
    reopenedWith: null as string | null,
    sql: [] as Array<{ query: string; parameters?: unknown[] }>,
    requests: [] as Array<{ method: string; url: string; auth: string | null; body: string }>,
  };

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  function runSql(query: string, parameters: unknown[] = []): Response {
    state.sql.push({ query, parameters });
    if (options.failSqlMatching?.test(query)) return json({ message: `syntax error near ${MGMT_TOKEN}` }, 400);
    if (/select filename, checksum from/.test(query)) {
      return json([...state.applied].map(([filename, checksum]) => ({ filename, checksum })));
    }
    const rec = /insert into \w+\.kbe_migrations \(filename, checksum, kb_schema\) values \('([^']+)', '([0-9a-f]+)'/.exec(query);
    if (rec) {
      state.applied.set(rec[1] as string, rec[2] as string);
      return json([]);
    }
    if (/from vault\.secrets where name = 'kbe_embed_token'/.test(query)) {
      return json([{ n: state.vault.has("kbe_embed_token") ? 1 : 0 }]);
    }
    if (/set token_hash = \$1 where handle = 'kb-engine'/.test(query)) {
      state.principals.embedHash = String(parameters[0]);
      return json([{ handle: "kb-engine" }]);
    }
    if (/vault\.create_secret\(\$1, 'kbe_embed_token'/.test(query)) {
      state.vault.set("kbe_embed_token", String(parameters[0]));
      return json([]);
    }
    if (/where role = 'administrator' and active/.test(query)) {
      return json(state.principals.admins.map((email) => ({ email })));
    }
    if (/insert into \w+\.principals/.test(query)) {
      state.principals.admins.push(String(parameters[1]));
      const page = parameters[3] === null || parameters[3] === undefined ? null : String(parameters[3]);
      state.principals.names.set(String(parameters[1]), { display: String(parameters[2] ?? parameters[1]), page });
      return json([]);
    }
    if (/update \w+\.principals set page_name = \$2/.test(query)) {
      const email = String(parameters[0]);
      const before = state.principals.names.get(email);
      const display = !before || before.display === email ? String(parameters[1]) : before.display;
      state.principals.names.set(email, { display, page: String(parameters[1]) });
      return json([]);
    }
    if (/engine_setup_reopen\(\$1\)/.test(query)) {
      state.reopenedWith = String(parameters[0]);
      return json([]);
    }
    return json([]);
  }

  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const headers = new Headers(init.headers as HeadersInit);
    const body = typeof init.body === "string" ? init.body : init.body ? "[form]" : "";
    state.requests.push({ method: init.method ?? "GET", url, auth: headers.get("authorization"), body });
    if (u.hostname !== "api.supabase.com") return json({ message: "wrong host" }, 599);
    if (headers.get("authorization") !== `Bearer ${MGMT_TOKEN}`) return json({ message: "Unauthorized" }, 401);
    const path = u.pathname;
    if (path === "/v1/projects") return json(Array.from({ length: options.projects ?? 1 }, (_, i) => ({ id: `p${i}` })));
    const base = `/v1/projects/${REF}`;
    if (!path.startsWith(base)) return json({ message: "Forbidden resource" }, 403);
    const rest = path.slice(base.length);
    if (rest === "" ) return json({ status: options.status ?? "ACTIVE_HEALTHY" });
    if (rest === "/api-keys") return json([{ name: "anon", type: "legacy", api_key: ANON_KEY }, { name: "service_role", type: "legacy", api_key: "service-role-key" }]);
    if (rest === "/postgrest" && init.method === "GET") return json({ db_schema: state.dbSchema, jwt_secret: options.jwtSecret ?? JWT_SECRET });
    if (rest === "/postgrest" && init.method === "PATCH") {
      state.dbSchema = String((JSON.parse(body) as { db_schema: string }).db_schema);
      return json({ db_schema: state.dbSchema });
    }
    if (rest === "/database/query") {
      const parsed = JSON.parse(body) as { query: string; parameters?: unknown[] };
      return runSql(parsed.query, parsed.parameters);
    }
    if (rest === "/functions/deploy") {
      state.deployed.push(u.searchParams.get("slug") ?? "");
      return json({ status: "ACTIVE", version: 1 });
    }
    return json({ message: "not found" }, 404);
  };

  return { fetch, state };
}

export const FILES = {
  migrations: () => [
    { name: "0000_prelude.sql", sql: "create schema if not exists workspace;" },
    { name: "0001_documents_table.sql", sql: "create table workspace.documents (id int);" },
  ],
  embedSource: () => "Deno.serve(() => new Response('ok'));",
};
