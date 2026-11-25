import { describe, it, expect } from "vitest";
import {
  buildUrl,
  CLOUDFLARE_API_BASE,
  CloudflareError,
  createCloudflareClient,
  type FetchLike,
} from "../../src/setup/cloudflare-client.js";
import {
  createFakeCloudflare,
  GOOD_TOKEN,
  ACCOUNT_ID,
} from "./fake-cloudflare.js";

const reply = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });

function clientWith(fetch: FetchLike, timeoutMs?: number) {
  return createCloudflareClient({ token: GOOD_TOKEN, fetch, timeoutMs });
}

async function caught(run: () => Promise<unknown>): Promise<CloudflareError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(CloudflareError);
    return err as CloudflareError;
  }
  throw new Error("expected a CloudflareError");
}

/** Everything about an error that could be logged or shown. */
const everythingIn = (err: Error) =>
  [
    err.message,
    err.stack ?? "",
    JSON.stringify(err),
    JSON.stringify(Object.entries(err)),
    String((err as { cause?: unknown }).cause ?? ""),
  ].join("\n");

describe("where requests go", () => {
  it("only ever to the Cloudflare API base URL", async () => {
    const fake = createFakeCloudflare();
    const client = clientWith(fake.fetch);
    await client.get(["user", "tokens", "verify"]);
    await client.list(["zones"], { name: "example.com" });
    await client.send("POST", ["accounts", ACCOUNT_ID, "access", "policies"], {
      name: "x",
    });
    expect(fake.requests.length).toBe(3);
    for (const r of fake.requests) {
      expect(r.url.startsWith(CLOUDFLARE_API_BASE)).toBe(true);
      expect(r.authorization).toBe("Bearer " + GOOD_TOKEN);
    }
  });

  it.each([
    [[]],
    [["zones", ".."]],
    [["zones", "../../../other"]],
    [["zones", "a/b"]],
    [["zones", "a?x=1"]],
    [["zones", "a#frag"]],
    [["zones", ""]],
    [["//evil.example.net", "x"]],
    [["https://evil.example.net/"]],
    [["@evil.example.net"]],
    [["zones", "x".repeat(65)]],
    [["zones", "%2e%2e"]],
  ])("refuses to build a path from %j", (path) => {
    expect(() => buildUrl(path as string[])).toThrow(CloudflareError);
  });

  it("sends nothing at all for a path it refuses", async () => {
    const fake = createFakeCloudflare();
    const client = clientWith(fake.fetch);
    await caught(() => client.get(["zones", "../../../../evil"]));
    await caught(() => client.send("PUT", ["https://evil.example.net"], {}));
    expect(fake.requests).toHaveLength(0);
  });

  it("puts query values in the query, never in the path or host", () => {
    const odd = "x/../../y?z=1#h@evil.example.net";
    const url = buildUrl(["zones"], { name: odd });
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(url.pathname).toBe("/client/v4/zones");
    expect(url.searchParams.get("name")).toBe(odd);
  });

  it("never follows a redirect, and sets a timeout on every call", async () => {
    const fake = createFakeCloudflare();
    const client = clientWith(fake.fetch);
    await client.get(["zones"]);
    await client.send("POST", ["accounts", ACCOUNT_ID, "access", "policies"], {
      name: "x",
    });
    for (const r of fake.requests) {
      expect(r.redirect).toBe("error");
      expect(r.hasTimeout).toBe(true);
    }
  });

  it("treats a redirect answer as a failure even if the fetch hands one back", async () => {
    const seen: string[] = [];
    const fetch: FetchLike = async (url) => {
      seen.push(url);
      return reply(302, "", { Location: "https://evil.example.net/steal" });
    };
    const err = await caught(() => clientWith(fetch).get(["zones"]));
    expect(err.message).toMatch(/redirect/);
    expect(seen).toHaveLength(1);
  });
});

describe("the token", () => {
  it.each([
    "",
    "short",
    "has spaces in the token value 0123456789",
    "line\nbreak-0123456789-0123456789",
    "x".repeat(300),
    "tökén-0123456789-0123456789-0123",
  ])("refuses a token shaped like %j before sending anything", (token) => {
    const fake = createFakeCloudflare();
    let err: unknown;
    try {
      createCloudflareClient({ token, fetch: fake.fetch });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CloudflareError);
    expect((err as CloudflareError).kind).toBe("bad_token");
    if (token.length > 0)
      expect(everythingIn(err as Error)).not.toContain(token);
    expect(fake.requests).toHaveLength(0);
  });

  // Cloudflare's scannable formats: prefix, 40 characters, a checksum.
  it.each(["cfut_", "cfat_"])("accepts a %s token", (prefix) => {
    const fake = createFakeCloudflare();
    const token = prefix + "A1b2C3d4E5".repeat(4) + "0f1e2d3c";
    expect(() =>
      createCloudflareClient({ token, fetch: fake.fetch }),
    ).not.toThrow();
  });

  it("is not in the error when Cloudflare refuses it", async () => {
    const fake = createFakeCloudflare({
      token: "the-real-token-is-a-different-one-000000",
    });
    const err = await caught(() => clientWith(fake.fetch).get(["zones"]));
    expect(err.kind).toBe("auth");
    expect(err.status).toBe(401);
    expect(everythingIn(err)).not.toContain(GOOD_TOKEN);
  });

  it("is scrubbed from an error message that Cloudflare echoes it in", async () => {
    const fetch: FetchLike = async () =>
      reply(400, {
        success: false,
        errors: [
          {
            code: 7001,
            message: "bad header: Bearer " + GOOD_TOKEN + " was rejected",
          },
        ],
        result: null,
      });
    const err = await caught(() => clientWith(fetch).get(["zones"]));
    expect(err.message).toContain("[removed]");
    expect(everythingIn(err)).not.toContain(GOOD_TOKEN);
    expect(err.codes).toEqual([7001]);
  });

  it("is not in the error when the network call itself throws with it", async () => {
    const fetch: FetchLike = async (_url, init) => {
      throw new TypeError("fetch failed for " + JSON.stringify(init.headers));
    };
    const err = await caught(() => clientWith(fetch).get(["zones"]));
    expect(err.kind).toBe("network");
    expect(everythingIn(err)).not.toContain(GOOD_TOKEN);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  it("is not in the error for an unreadable answer that contains it", async () => {
    const fetch: FetchLike = async () =>
      reply(502, "<html>upstream said " + GOOD_TOKEN + "</html>");
    const err = await caught(() => clientWith(fetch).get(["zones"]));
    expect(everythingIn(err)).not.toContain(GOOD_TOKEN);
  });
});

describe("failures", () => {
  it("times out", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    const err = await caught(() => clientWith(fetch, 20).get(["zones"]));
    expect(err.kind).toBe("timeout");
  });

  it.each([
    [401, 10000, "auth"],
    [400, 6003, "auth"],
    [403, 10000, "forbidden"],
    [404, 7003, "not_found"],
    [500, 1, "api"],
    [429, 971, "api"],
  ])("maps %i (code %i) to %s", async (status, code, kind) => {
    const fetch: FetchLike = async () =>
      reply(status, {
        success: false,
        errors: [{ code, message: "no" }],
        result: null,
      });
    const err = await caught(() => clientWith(fetch).get(["zones"]));
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
  });

  it("treats success:false on a 200 as a failure", async () => {
    const fetch: FetchLike = async () =>
      reply(200, {
        success: false,
        errors: [{ code: 5, message: "nope" }],
        result: null,
      });
    expect((await caught(() => clientWith(fetch).get(["zones"]))).kind).toBe(
      "api",
    );
  });

  it("reads every page of a list, and stops", async () => {
    const pages: string[] = [];
    const fetch: FetchLike = async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      pages.push(String(page));
      return reply(200, {
        success: true,
        errors: [],
        result: [{ n: page }],
        result_info: { total_pages: 3 },
      });
    };
    expect(await clientWith(fetch).list(["zones"])).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
    ]);
    expect(pages).toEqual(["1", "2", "3"]);
  });
});
