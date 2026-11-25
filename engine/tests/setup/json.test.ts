import { shown } from "../shown.js";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { _captureLogsForTests } from "../../src/log/logger.js";
import { GOOD_TOKEN } from "./fake-cloudflare.js";
import {
  ADMIN_ASSERTION,
  CHOICES,
  CODE,
  createWorld,
  ENGINE_HOST,
  PLATFORM_HOST,
  type World,
} from "./world.js";

// `kbe access setup` posts the same form fields to the same two routes and
// asks for JSON. These tests prove that asking for JSON changes the shape of
// the answer and nothing else: the same gate, code check, lockout, signature
// and validation apply, and no secret is in any answer or log line.

const JSON_ONLY = { Accept: "application/json" };

type Body = Record<string, unknown>;

async function body(res: Response): Promise<Body> {
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  return (await res.clone().json()) as Body;
}

async function preview(world: World, fields: Record<string, string> = {}) {
  return world.post(
    "/setup/preview",
    { code: CODE, ...CHOICES, ...fields },
    JSON_ONLY,
  );
}

async function signed(world: World): Promise<{ inputs: string; sig: string }> {
  const res = await preview(world);
  expect(res.status).toBe(200);
  const got = await body(res);
  return { inputs: String(got["inputs"]), sig: String(got["sig"]) };
}

async function apply(world: World, over: Record<string, string> = {}) {
  const fields = await signed(world);
  return world.post(
    "/setup/apply",
    { ...fields, code: CODE, cf_token: GOOD_TOKEN, ...over },
    JSON_ONLY,
  );
}

let capture: ReturnType<typeof _captureLogsForTests>;
beforeEach(() => {
  capture = _captureLogsForTests();
});
afterEach(() => capture.stop());

function expectNoSecret(world: World, texts: readonly string[]) {
  const everything = [
    ...texts,
    capture.lines().join("\n"),
    JSON.stringify(world.db.row),
  ].join("\n");
  for (const secret of [GOOD_TOKEN, CODE]) {
    expect(everything.includes(secret)).toBe(false);
    expect(everything.includes(encodeURIComponent(secret))).toBe(false);
    expect(everything.includes(Buffer.from(secret).toString("base64"))).toBe(
      false,
    );
  }
}

async function text(res: Response): Promise<string> {
  return (
    (await res.clone().text()) + JSON.stringify([...res.headers.entries()])
  );
}

describe("POST /setup/preview, asked for JSON", () => {
  it("returns the same plan lines as the page, and the signed choices", async () => {
    const world = createWorld();
    const res = await preview(world);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const got = await body(res);
    expect(got["ok"]).toBe(true);
    const plan = got["plan"] as {
      host: string;
      level: string;
      connector_url: string;
      steps: { title: string; lines: string[] }[];
    };
    expect(plan.host).toBe(ENGINE_HOST);
    expect(plan.level).toBe("people");
    expect(plan.connector_url).toBe("https://" + ENGINE_HOST + "/mcp");

    const html = await (
      await world.post("/setup/preview", { code: CODE, ...CHOICES })
    ).text();
    const unescaped = shown(html)
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
    for (const step of plan.steps) {
      expect(unescaped).toContain(step.title);
      for (const line of step.lines) expect(unescaped).toContain(line);
    }
    const lines = plan.steps.flatMap((s) => s.lines).join("\n");
    expect(lines).toContain("CNAME engine.example.com -> " + PLATFORM_HOST);
    expect(lines).toContain("owner@example.com, amy@example.com");
    expect(plan.steps.at(-1)?.title).toBe("Save the result and close setup");
    expect(String(got["sig"])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("makes no Cloudflare call and needs no token", async () => {
    const world = createWorld();
    await signed(world);
    expect(world.cloudflare.requests).toHaveLength(0);
  });

  it("refuses a wrong code with 401, counts it, and shows no plan", async () => {
    const world = createWorld();
    const res = await preview(world, { code: "not-the-code" });
    expect(res.status).toBe(401);
    const got = await body(res);
    expect(got).toEqual({
      ok: false,
      title: "Wrong setup code",
      message: "That is not the setup code.",
    });
    expect(world.db.calls.fail).toBe(1);
  });

  it("locks after five wrong codes, and then refuses the right one too", async () => {
    const world = createWorld();
    for (let i = 0; i < 5; i += 1) {
      await preview(world, { code: "wrong-guess-" + i });
    }
    expect(world.db.calls.fail).toBe(5);
    const res = await preview(world);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect((await body(res))["title"]).toBe("Setup is locked");
    // The same lock holds for a browser: one count for the page.
    expect(
      (await world.post("/setup/preview", { code: CODE, ...CHOICES })).status,
    ).toBe(429);
  });

  it("checks the code before the choices, and lists every problem after it", async () => {
    const world = createWorld();
    const early = await preview(world, { code: "wrong", host: "not a host" });
    expect(early.status).toBe(401);
    const res = await preview(world, { host: "not a host" });
    expect(res.status).toBe(400);
    const got = await body(res);
    expect(got["ok"]).toBe(false);
    expect((got["errors"] as string[]).join(" ")).toMatch(
      /hostname is not valid/,
    );
    expect(got["inputs"]).toBeUndefined();
  });

  it("still takes the DNS target from the address it was reached on", async () => {
    const world = createWorld();
    const got = await body(
      await preview(world, { origin: "attacker.example.net" }),
    );
    expect(JSON.stringify(got)).not.toContain("attacker.example.net");
  });

  it("keeps the same-origin and form-type checks", async () => {
    const world = createWorld();
    const cross = await world.post(
      "/setup/preview",
      { code: CODE, ...CHOICES },
      { ...JSON_ONLY, "Sec-Fetch-Site": "cross-site" },
    );
    expect(cross.status).toBe(403);
    const typed = await world.post(
      "/setup/preview",
      { code: CODE, ...CHOICES },
      { ...JSON_ONLY, "Content-Type": "application/json" },
    );
    expect(typed.status).toBe(415);
    expect(world.db.calls.check).toBe(0);
  });

  it("answers 503 as JSON when the app has no setup code", async () => {
    const world = createWorld({ setupCode: null });
    const res = await preview(world);
    expect(res.status).toBe(503);
    expect((await body(res))["ok"]).toBe(false);
  });

  it("gives a browser the page, whatever else it accepts", async () => {
    const world = createWorld();
    const res = await world.post(
      "/setup/preview",
      { code: CODE, ...CHOICES },
      { Accept: "text/html,application/json;q=0.9" },
    );
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  });
});

describe("POST /setup/apply, asked for JSON", () => {
  it("carries out the plan and reports every step", async () => {
    const world = createWorld();
    const res = await apply(world);
    expect(res.status).toBe(200);
    const got = await body(res);
    expect(got["ok"]).toBe(true);
    expect(got["connector_url"]).toBe("https://" + ENGINE_HOST + "/mcp");
    const steps = got["steps"] as { id: string; status: string }[];
    expect(steps.at(-1)).toMatchObject({ id: "finish", status: "updated" });
    expect(steps.every((s) => s.status !== "failed")).toBe(true);
    expect(world.db.row.setup_state).toBe("complete");
    expectNoSecret(world, [await text(res)]);
  });

  it("accepts only signed choices: no way round the preview", async () => {
    const world = createWorld();
    const res = await world.post(
      "/setup/apply",
      { code: CODE, cf_token: GOOD_TOKEN, ...CHOICES },
      JSON_ONLY,
    );
    expect(res.status).toBe(400);
    expect(world.cloudflare.requests).toHaveLength(0);
    const forged = await apply(world, { sig: "0".repeat(64) });
    expect(forged.status).toBe(400);
    expect(world.cloudflare.requests).toHaveLength(0);
  });

  it("counts a wrong code on apply too, and calls nothing", async () => {
    const world = createWorld();
    const res = await apply(world, { code: "not-the-code" });
    expect(res.status).toBe(401);
    expect(world.db.calls.fail).toBe(1);
    expect(world.cloudflare.requests).toHaveLength(0);
    expectNoSecret(world, [await text(res)]);
  });

  it("works once: the same code is refused after setup completes", async () => {
    const world = createWorld();
    const fields = await signed(world);
    const send = () =>
      world.post(
        "/setup/apply",
        { ...fields, code: CODE, cf_token: GOOD_TOKEN },
        JSON_ONLY,
      );
    expect((await send()).status).toBe(200);
    // Set up now: the platform address has no sign-in, so it is refused.
    const again = await send();
    expect(again.status).toBe(401);
    expect((await body(again))["title"]).toBe("Sign in required");
    // And with the administrator's sign-in, setup is closed.
    const closed = await world.post(
      "/setup/apply",
      { ...fields, code: CODE, cf_token: GOOD_TOKEN },
      { ...JSON_ONLY, "Cf-Access-Jwt-Assertion": ADMIN_ASSERTION },
      ENGINE_HOST,
    );
    expect(closed.status).toBe(409);
  });

  it("reports a failed step with 422 (never 502), and a second run finishes the job", async () => {
    const world = createWorld();
    world.cloudflare.failOn({
      method: "POST",
      path: /dns_records$/,
      status: 500,
      times: 1,
    });
    const first = await apply(world);
    expect(first.status).toBe(422);
    const got = await body(first);
    expect(got["ok"]).toBe(false);
    const steps = got["steps"] as { status: string; note?: string }[];
    expect(steps.some((s) => s.status === "failed")).toBe(true);
    expect(steps.some((s) => s.status === "not_run")).toBe(true);
    expect(world.db.row.setup_state).toBe("open");

    const second = await apply(world);
    expect(second.status).toBe(200);
    expectNoSecret(world, [await text(first), await text(second)]);
  });

  it("puts no secret in an answer or a log line when Cloudflare echoes the token", async () => {
    const world = createWorld();
    world.cloudflare.failOn({
      method: "POST",
      path: /\/access\/policies$/,
      status: 400,
      message: "invalid Authorization: Bearer " + GOOD_TOKEN,
    });
    const res = await apply(world);
    expect(res.status).toBe(422);
    expect(await res.clone().text()).toContain("[removed]");
    expectNoSecret(world, [await text(res)]);
  });

  it("puts no secret in an answer when the token is refused or mis-shaped", async () => {
    const refused = createWorld({
      cloudflare: { token: "cloudflare-knows-a-different-token-00001" },
    });
    const one = await apply(refused);
    expect(one.status).toBe(422);
    expectNoSecret(refused, [await text(one)]);

    const world = createWorld();
    const two = await apply(world, { cf_token: "short" });
    expect(two.status).toBe(422);
    const steps = (await body(two))["steps"] as { note?: string }[];
    expect(steps[0]?.note).toMatch(/does not look like a Cloudflare API token/);
    expectNoSecret(world, [await text(two)]);
  });

  it("logs the outcome and neither the code nor the token", async () => {
    const world = createWorld();
    const res = await apply(world);
    expect(capture.lines().join("\n")).toContain("setup: apply finished");
    expectNoSecret(world, [await text(res)]);
  });

  it("reports what the read-back found, each with where to click", async () => {
    const world = createWorld();
    const got = await body(await apply(world));
    const checks = got["checks"] as {
      id: string;
      state: string;
      fix: string;
    }[];
    expect(checks.map((c) => [c.id, c.state])).toEqual([
      ["managed_oauth", "ok"],
      ["claude_redirects", "ok"],
      ["second_factor", "ok"],
    ]);
    expect(checks.every((c) => c.fix.length > 20)).toBe(true);
  });

  it("names an account with no Zero Trust team, before anything is created", async () => {
    const world = createWorld({ cloudflare: { organization: null } });
    const res = await apply(world);
    expect(res.status).toBe(422);
    const got = await body(res);
    const steps = got["steps"] as {
      id: string;
      status: string;
      code?: string;
    }[];
    expect(steps.find((s) => s.id === "organization")).toMatchObject({
      status: "failed",
      code: "no_team",
    });
    expect(got["checks"]).toEqual([]);
    expect(world.cloudflare.writes()).toHaveLength(0);
    expectNoSecret(world, [await text(res)]);
  });
});
