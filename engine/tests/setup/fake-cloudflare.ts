import type { FetchLike } from "../../src/setup/cloudflare-client.js";

/**
 * An in-memory stand-in for the Cloudflare API, behind the same `fetch` shape
 * the real client uses. It behaves like the real thing where it matters to
 * the setup page: PUT replaces the whole object, ids and AUD tags are made by
 * the server, and a request without the right token is refused.
 *
 * Nothing here touches the network.
 */

export const ACCOUNT_ID = "a".repeat(32);
export const ZONE_ID = "b".repeat(32);
// Built from parts so secret scanners do not mistake a test value for a real one.
export const GOOD_TOKEN = [
  "cf",
  "test",
  "only",
  "0123456789",
  "abcdefghij",
].join("-");

type Obj = Record<string, unknown>;
export type Area = "apps" | "organization" | "dns" | "zone";

export type Recorded = {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly redirect: string | undefined;
  readonly hasTimeout: boolean;
  readonly body: unknown;
};

export type Injected = {
  readonly method: string;
  readonly path: RegExp;
  readonly status: number;
  readonly message?: string;
  /** How many matching requests to fail. Default: every one. */
  readonly times?: number;
};

export type FakeOptions = {
  readonly token?: string;
  readonly zoneName?: string;
  /** null: Zero Trust has never been opened on the account. */
  readonly organization?: Obj | null;
  readonly identityProviders?: readonly Obj[];
  readonly dnsRecords?: readonly Obj[];
  readonly extraZones?: readonly Obj[];
  /** Areas the token may not read or write. */
  readonly denied?: readonly Area[];
  /** Areas the token may read but not write. */
  readonly readOnly?: readonly Area[];
  /**
   * How the token answers the two verify routes, as seen on a live account:
   * a token owned by the account gets 401 on the user route and is verified
   * on the account route. Default: "user" (active on the user route).
   */
  readonly tokenOwner?: "user" | "account" | "account-disabled";
  /**
   * A token without Zone Read: the zone list answers, but empty. (Denying
   * "zone" instead makes it answer 403.)
   */
  readonly zoneListEmpty?: boolean;
  /** Cloudflare's error code on a denied call (default 10000; 9109 seen live). */
  readonly deniedCode?: number;
};

export type FakeCloudflare = {
  readonly fetch: FetchLike;
  readonly requests: Recorded[];
  readonly writes: () => readonly Recorded[];
  readonly state: {
    organization: Obj | null;
    identityProviders: Obj[];
    policies: Obj[];
    apps: Obj[];
    dnsRecords: Obj[];
  };
  readonly failOn: (rule: Injected) => void;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const ok = (result: unknown) =>
  json(200, {
    success: true,
    errors: [],
    result,
    result_info: { total_pages: 1 },
  });
const fail = (status: number, code: number, message: string) =>
  json(status, { success: false, errors: [{ code, message }], result: null });

function areaOf(path: string): Area | null {
  if (/\/access\/(apps|policies)/.test(path)) return "apps";
  if (/\/access\/(organizations|identity_providers)/.test(path))
    return "organization";
  if (/\/dns_records/.test(path)) return "dns";
  if (path === "/zones") return "zone";
  return null;
}

export function createFakeCloudflare(
  options: FakeOptions = {},
): FakeCloudflare {
  const token = options.token ?? GOOD_TOKEN;
  const zoneName = options.zoneName ?? "example.com";
  let counter = 0;
  const hexId = () => (++counter).toString(16).padStart(32, "0");
  const uuid = () => {
    const h = hexId();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const state: FakeCloudflare["state"] = {
    organization:
      options.organization === undefined
        ? {
            auth_domain: "acme.cloudflareaccess.com",
            name: "Acme",
            login_design: { header_text: "Hello" },
          }
        : options.organization,
    identityProviders: [...(options.identityProviders ?? [])].map((p) => ({
      ...p,
    })),
    policies: [],
    apps: [],
    dnsRecords: [...(options.dnsRecords ?? [])].map((r) => ({ ...r })),
  };
  const zones: Obj[] = [
    { id: ZONE_ID, name: zoneName, account: { id: ACCOUNT_ID } },
    ...(options.extraZones ?? []),
  ];
  const requests: Recorded[] = [];
  const injected: { rule: Injected; left: number }[] = [];

  const expandPolicies = (app: Obj): Obj => ({
    ...app,
    policies: ((app["policies"] as Obj[] | undefined) ?? []).map((link) => ({
      ...(state.policies.find((p) => p["id"] === link["id"]) ?? {}),
      precedence: link["precedence"],
    })),
  });

  function collection(
    list: Obj[],
    method: string,
    id: string | undefined,
    body: Obj,
    make: (b: Obj) => Obj,
    show: (o: Obj) => Obj = (o) => o,
  ): Response {
    if (method === "GET" && !id) return ok(list.map(show));
    if (method === "POST" && !id) {
      const created = make(body);
      list.push(created);
      return ok(show(created));
    }
    const index = list.findIndex((item) => item["id"] === id);
    if (index < 0) return fail(404, 7003, "not found");
    const current = list[index] as Obj;
    if (method === "GET") return ok(show(current));
    // PUT replaces the whole object; only server-made fields survive.
    const keep = {
      id: current["id"],
      ...(current["aud"] ? { aud: current["aud"] } : {}),
    };
    const next =
      method === "PATCH" ? { ...current, ...body } : { ...body, ...keep };
    list[index] = next;
    return ok(show(next));
  }

  function route(method: string, url: URL, body: Obj): Response {
    const path = url.pathname.replace("/client/v4", "");
    const parts = path.split("/").filter(Boolean);
    const owner = options.tokenOwner ?? "user";
    if (path === "/user/tokens/verify")
      return owner === "user"
        ? ok({ id: hexId(), status: "active" })
        : fail(401, 1000, "Invalid API Token");
    if (/^\/accounts\/[^/]+\/tokens\/verify$/.test(path))
      return owner === "user"
        ? fail(401, 1000, "Invalid API Token")
        : ok({
            id: hexId(),
            status: owner === "account" ? "active" : "disabled",
          });
    if (path === "/zones") {
      if (options.zoneListEmpty) return ok([]);
      const name = url.searchParams.get("name");
      return ok(name ? zones.filter((z) => z["name"] === name) : zones);
    }
    if (parts[0] === "zones" && parts[2] === "dns_records") {
      const name = url.searchParams.get("name");
      const list = collection(
        state.dnsRecords,
        method,
        parts[3],
        body,
        (b) => ({ id: hexId(), ...b }),
      );
      if (method === "GET" && !parts[3] && name)
        return ok(state.dnsRecords.filter((r) => r["name"] === name));
      return list;
    }
    if (
      parts[0] !== "accounts" ||
      parts[1] !== ACCOUNT_ID ||
      parts[2] !== "access"
    )
      return fail(404, 7003, "no route");
    const [, , , resource, id] = parts;
    if (resource === "organizations") {
      if (method === "GET")
        return state.organization
          ? ok(state.organization)
          : fail(404, 9999, "access.api.error.not_found");
      state.organization = { ...body };
      return ok(state.organization);
    }
    if (resource === "identity_providers")
      return collection(state.identityProviders, method, id, body, (b) => ({
        id: uuid(),
        ...b,
      }));
    if (resource === "policies")
      return collection(state.policies, method, id, body, (b) => ({
        id: uuid(),
        ...b,
      }));
    if (resource === "apps")
      return collection(
        state.apps,
        method,
        id,
        body,
        (b) => ({ id: uuid(), aud: hexId() + hexId(), ...b }),
        expandPolicies,
      );
    return fail(404, 7003, "no route");
  }

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = init.body ? (JSON.parse(String(init.body)) as Obj) : {};
    const path = url.pathname.replace("/client/v4", "");
    requests.push({
      method,
      url: input,
      path,
      authorization: headers.get("authorization"),
      redirect: init.redirect,
      hasTimeout: init.signal instanceof AbortSignal,
      body: init.body ? body : undefined,
    });
    if (url.origin !== "https://api.cloudflare.com")
      throw new Error(`the fake was asked for ${url.origin}`);
    if (headers.get("authorization") !== `Bearer ${token}`)
      return fail(401, 1000, "Invalid API Token");

    const hit = injected.find(
      (i) => i.left > 0 && i.rule.method === method && i.rule.path.test(path),
    );
    if (hit) {
      hit.left -= 1;
      return fail(
        hit.rule.status,
        10001,
        hit.rule.message ?? "injected failure",
      );
    }
    const area = areaOf(path);
    const write = method !== "GET";
    if (
      area &&
      (options.denied?.includes(area) ||
        (write && options.readOnly?.includes(area)))
    )
      return fail(403, options.deniedCode ?? 10000, "Authentication error");
    return route(method, url, body);
  };

  return {
    fetch,
    requests,
    writes: () => requests.filter((r) => r.method !== "GET"),
    state,
    failOn: (rule) => {
      injected.push({ rule, left: rule.times ?? Number.POSITIVE_INFINITY });
    },
  };
}
