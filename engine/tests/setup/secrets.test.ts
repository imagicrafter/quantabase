import { shown } from "../shown.js";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { _captureLogsForTests, logger } from "../../src/log/logger.js";
import type { FetchLike } from "../../src/setup/cloudflare-client.js";
import { GOOD_TOKEN } from "./fake-cloudflare.js";
import { CHOICES, CODE, createWorld, previewed, type World } from "./world.js";

// The two secrets of the setup page are the setup code and the Cloudflare API
// token. These tests run whole requests, good and bad, and then search
// everything that came out (every log line, every response body, every
// response header, the stored row) for either of them.

let capture: ReturnType<typeof _captureLogsForTests>;
beforeEach(() => {
  capture = _captureLogsForTests();
});
afterEach(() => capture.stop());

type Out = { status: number; text: string; headers: string };

async function read(res: Response): Promise<Out> {
  return {
    status: res.status,
    text: await res.text(),
    headers: JSON.stringify([...res.headers.entries()]),
  };
}

async function apply(
  world: World,
  over: Record<string, string> = {},
): Promise<Out> {
  const signed = await previewed(world);
  return read(
    await world.post("/setup/apply", {
      inputs: signed.inputs,
      sig: signed.sig,
      code: CODE,
      cf_token: GOOD_TOKEN,
      ...over,
    }),
  );
}

function expectClean(what: string, text: string, secrets: readonly string[]) {
  for (const secret of secrets) {
    expect(text.includes(secret), what + " contains a secret").toBe(false);
    // Also not in the common encodings of it.
    expect(text.includes(encodeURIComponent(secret))).toBe(false);
    expect(text.includes(Buffer.from(secret).toString("base64"))).toBe(false);
  }
}

function expectNothingLeaked(world: World, outs: readonly Out[]) {
  const secrets = [GOOD_TOKEN, CODE];
  expectClean("the log", capture.lines().join("\n"), secrets);
  for (const out of outs) {
    expectClean("a response body", out.text, secrets);
    expectClean("a response header", out.headers, secrets);
  }
  expectClean("the stored row", JSON.stringify(world.db.row), [
    GOOD_TOKEN,
    CODE,
  ]);
}

describe("the token and the setup code never leave the request", () => {
  it("on a successful setup", async () => {
    const world = createWorld();
    const out = await apply(world);
    expect(out.status).toBe(200);
    expect(capture.lines().join("\n")).toContain("setup: apply finished");
    expectNothingLeaked(world, [out]);
  });

  it("on every kind of refusal before Cloudflare is called", async () => {
    const world = createWorld();
    const signed = await previewed(world);
    const outs = [
      await read(
        await world.post("/setup/preview", {
          ...CHOICES,
          code: CODE,
          host: "bad host",
        }),
      ),
      await read(
        await world.post("/setup/apply", { code: CODE, cf_token: GOOD_TOKEN }),
      ),
      await read(
        await world.post("/setup/apply", {
          inputs: signed.inputs,
          sig: "0".repeat(64),
          code: CODE,
          cf_token: GOOD_TOKEN,
        }),
      ),
      await read(
        await world.post(
          "/setup/apply",
          {
            inputs: signed.inputs,
            sig: signed.sig,
            code: CODE,
            cf_token: GOOD_TOKEN,
          },
          { "Sec-Fetch-Site": "cross-site" },
        ),
      ),
      await read(
        await world.post(
          "/setup/apply",
          {
            inputs: signed.inputs,
            sig: signed.sig,
            code: CODE,
            cf_token: GOOD_TOKEN,
          },
          { "Content-Type": "application/json" },
        ),
      ),
    ];
    expect(outs.map((o) => o.status)).toEqual([400, 400, 400, 403, 415]);
    expectNothingLeaked(world, outs);
  });

  it("when Cloudflare refuses the token", async () => {
    const world = createWorld({
      cloudflare: { token: "cloudflare-knows-a-different-token-00001" },
    });
    const out = await apply(world);
    expect(out.status).toBe(422);
    expectNothingLeaked(world, [out]);
  });

  it("when a token is missing a permission, or a step fails part-way", async () => {
    for (const cloudflare of [
      { denied: ["dns" as const] },
      { readOnly: ["apps" as const] },
    ]) {
      const world = createWorld({ cloudflare });
      const out = await apply(world);
      expect(out.status).toBe(422);
      expectNothingLeaked(world, [out]);
    }
    const world = createWorld();
    world.cloudflare.failOn({
      method: "POST",
      path: /dns_records$/,
      status: 500,
    });
    const out = await apply(world);
    expect(out.status).toBe(422);
    expectNothingLeaked(world, [out]);
  });

  it("when Cloudflare echoes the token back in an error message", async () => {
    const world = createWorld();
    world.cloudflare.failOn({
      method: "POST",
      path: /\/access\/policies$/,
      status: 400,
      message: "invalid Authorization: Bearer " + GOOD_TOKEN,
    });
    const out = await apply(world);
    expect(out.status).toBe(422);
    expect(out.text).toContain("[removed]");
    expectNothingLeaked(world, [out]);
  });

  it("when the network call throws an error that carries the request", async () => {
    const throwing: FetchLike = async (url, init) => {
      const err = new TypeError(
        "fetch failed: " + url + " " + JSON.stringify(init.headers),
      );
      Object.assign(err, { request: { url, headers: init.headers } });
      throw err;
    };
    const world = createWorld({ deps: { cloudflareFetch: throwing } });
    const out = await apply(world);
    expect(out.status).toBe(422);
    expectNothingLeaked(world, [out]);
  });

  it("when the database fails at the last step", async () => {
    const world = createWorld({
      deps: {
        complete: async (code) => {
          throw new Error("could not run engine_setup_complete(" + code + ")");
        },
      },
    });
    const out = await apply(world);
    expect(out.status).toBe(422);
    expect(capture.lines().join("\n")).toContain(
      "could not store the sign-in settings",
    );
    expectNothingLeaked(world, [out]);
  });

  it("when the code is wrong, and when setup locks", async () => {
    const world = createWorld();
    const outs: Out[] = [];
    for (let i = 0; i < 6; i += 1) {
      outs.push(
        await read(
          await world.post("/setup/apply", {
            code: "wrong-guess-number-" + i,
            cf_token: GOOD_TOKEN,
          }),
        ),
      );
    }
    outs.push(
      await read(
        await world.post("/setup/preview", { ...CHOICES, code: CODE }),
      ),
    );
    expect(outs.at(-1)?.status).toBe(429);
    expectNothingLeaked(world, outs);
    // A wrong guess is not written out either.
    expect(capture.lines().join("\n")).not.toContain("wrong-guess-number");
    expect(outs.map((o) => o.text).join("\n")).not.toContain(
      "wrong-guess-number",
    );
  });

  it("when the token or the code is pasted into the wrong field", async () => {
    const world = createWorld({ owner: null });
    const outs: Out[] = [];
    for (const secret of [GOOD_TOKEN, CODE]) {
      outs.push(
        await read(
          await world.post("/setup/preview", {
            code: CODE,
            host: secret,
            origin: secret,
            level: secret,
            owner_email: secret,
            emails: "amy@example.com " + secret,
            domains: secret,
          }),
        ),
      );
    }
    expect(outs.map((o) => o.status)).toEqual([400, 400]);
    // What was valid is given back; the secret is not.
    expect(shown(outs[0]?.text)).toContain("amy@example.com");
    expectNothingLeaked(world, outs);
  });
});

describe("the logger", () => {
  // tests/setup.ts sets SETUP_CODE for the process; that is the value scrubbed.
  const envCode = process.env["SETUP_CODE"] ?? "";

  it("has a setup code to scrub in this test run", () => {
    expect(envCode.length).toBeGreaterThanOrEqual(32);
  });

  it("removes the setup code from a message, a field, and a nested field", () => {
    logger.info("the code is " + envCode + " ok");
    logger.info({ note: envCode, deep: { list: ["x", envCode] } }, "fields");
    logger.error({ err: new Error("failed with " + envCode) }, "an error");
    const out = capture.lines().join("\n");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(envCode);
  });

  it("redacts fields named like a token or a setup code, whatever they hold", () => {
    logger.info(
      {
        token: GOOD_TOKEN,
        cf_token: GOOD_TOKEN,
        api_token: GOOD_TOKEN,
        setup_code: CODE,
        authorization: "Bearer " + GOOD_TOKEN,
        form: { cf_token: GOOD_TOKEN, code: CODE },
        body: "cf_token=" + GOOD_TOKEN,
        request: {
          token: GOOD_TOKEN,
          cf_token: GOOD_TOKEN,
          authorization: GOOD_TOKEN,
        },
        outer: {
          inner: { token: GOOD_TOKEN, cf_token: GOOD_TOKEN, setup_code: CODE },
        },
      },
      "a careless log call",
    );
    const out = capture.lines().join("\n");
    expect(out).toContain("a careless log call");
    expect(out).not.toContain(GOOD_TOKEN);
    expect(out).not.toContain(CODE);
  });
});
