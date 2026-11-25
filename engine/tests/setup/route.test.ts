import { shown } from "../shown.js";
import { describe, it, expect } from "vitest";
import { SETUP_CSP } from "../../src/setup/page.js";
import { GOOD_TOKEN } from "./fake-cloudflare.js";
import {
  ADMIN_ASSERTION,
  CHOICES,
  CODE,
  createWorld,
  ENGINE_HOST,
  PLATFORM_HOST,
  previewed,
  READER_ASSERTION,
} from "./world.js";

const MINUTE = 60_000;

describe("GET /setup in setup mode", () => {
  it("shows the form and the token instructions, with a strict CSP and no script", async () => {
    const world = createWorld();
    const res = await world.get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(SETUP_CSP);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const html = await res.text();
    expect(html).toContain('action="/setup/preview"');
    expect(html).toContain('name="code"');
    expect(html).toContain("Access: Apps and Policies");
    expect(html).toContain(
      "Access: Organizations, Identity Providers, and Groups",
    );
    expect(html).toContain("DNS");
    expect(html).toMatch(/Expiration:.*Custom/);
    expect(html).toMatch(/not saved anywhere/);
    // No script, no inline style, no inline event handler: the CSP allows none.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    // The token is asked for only at the apply step.
    expect(html).not.toContain('name="cf_token"');
  });

  it("allows no script source at all, and forms only to itself", () => {
    expect(SETUP_CSP).toContain("default-src 'none'");
    expect(SETUP_CSP).not.toContain("script-src");
    expect(SETUP_CSP).not.toContain("unsafe-inline");
    expect(SETUP_CSP).toContain("form-action 'self'");
    expect(SETUP_CSP).toContain("frame-ancestors 'none'");
  });

  it("offers the sign-in length, 1 year chosen, and says the admin pages stay 12 hours", async () => {
    const world = createWorld();
    const html = await (await world.get()).text();
    expect(html).toMatch(/<select[^>]*name="session"/);
    expect(html).toMatch(/<option value="8760h" selected>1 year<\/option>/);
    expect(html).toMatch(/<option value="720h">30 days<\/option>/);
    expect(html).toMatch(/<option value="24h">1 day<\/option>/);
    expect(html).toMatch(/12 hours/);
  });

  it("shows the address it was reached on, read-only, and does not ask for it", async () => {
    const world = createWorld();
    const html = await (await world.get()).text();
    expect(html).toContain(PLATFORM_HOST);
    expect(html).not.toContain('name="origin"');
  });

  it("does not show the owner's email to someone who has not given the code", async () => {
    const world = createWorld();
    const html = await (await world.get()).text();
    expect(html).not.toContain("owner@example.com");
    expect(html).not.toContain('name="owner_email"');
    expect(html).toMatch(/owner named in your Engine config/);
    // After the code, the preview names the owner.
    expect(shown((await previewed(world)).html)).toContain("owner@example.com");
  });

  it("asks for the owner email when no config has been applied", async () => {
    const world = createWorld({ owner: null });
    expect(await (await world.get()).text()).toContain('name="owner_email"');
  });

  it("does not put a hostile Host header into the page", async () => {
    const world = createWorld();
    const res = await world.app.fetch(
      new Request("http://x.example/setup", {
        headers: { Host: 'evil"><img src=x>.example' },
      }),
    );
    const html = await res.text();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil");
    expect(html).toMatch(/not opened on a usable address/);
    expect(html).not.toContain('name="origin"');
  });

  it("links to Cloudflare's token screen with the four permissions filled in", async () => {
    const world = createWorld();
    const html = await (await world.get()).text();
    expect(html).toContain(
      'href="https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=',
    );
    expect(html).toContain('rel="noopener noreferrer"');
    // What the link cannot set is still asked for in words.
    expect(html).toMatch(/Specific zone/);
    expect(html).toMatch(/narrow it to your one account/);
  });

  it("starts the hostname box with the one the applied config names", async () => {
    const world = createWorld({
      deps: { configuredHost: async () => "Engine.Example.com" },
    });
    const html = await (await world.get()).text();
    expect(html).toContain('name="host" value="engine.example.com"');
    // No level is known before setup, so none is picked.
    expect(html).not.toMatch(/name="level"[^>]* checked/);
  });

  it("leaves the hostname box empty when the config names none, or cannot be read", async () => {
    for (const configuredHost of [
      async () => null,
      async () => '"><script>',
      async () => {
        throw new Error("database is away");
      },
    ]) {
      const world = createWorld({ deps: { configuredHost } });
      const res = await world.get();
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('name="host" value=""');
      expect(html).not.toContain("<script>");
    }
  });

  it("answers 503 when the app has no setup code", async () => {
    const world = createWorld({ setupCode: null });
    const res = await world.get();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("<form");
    expect(
      (await world.post("/setup/preview", { code: CODE, ...CHOICES })).status,
    ).toBe(503);
    expect((await world.post("/setup/apply", { code: CODE })).status).toBe(503);
  });

  it("answers 503 when the database cannot be read", async () => {
    const world = createWorld({
      deps: {
        mode: async () => {
          throw new Error("password=hunter2 connection refused");
        },
      },
    });
    const res = await world.get();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("hunter2");
  });
});

describe("POST /setup/preview", () => {
  it("shows the exact plan for a right code, and carries the choices signed", async () => {
    const world = createWorld();
    const { html, inputs, sig } = await previewed(world);
    expect(html).toContain("CNAME engine.example.com -&gt; " + PLATFORM_HOST);
    expect(shown(html)).toContain("owner@example.com, amy@example.com");
    expect(html).toContain("Managed OAuth");
    expect(html).toContain("https://claude.ai/api/mcp/auth_callback");
    expect(html).toContain("engine.example.com/status");
    expect(html).toContain("engine.example.com/setup");
    expect(html).toMatch(/second factor/);
    expect(html).toContain('action="/setup/apply"');
    expect(html).toContain('name="cf_token"');
    expect(inputs.length).toBeGreaterThan(20);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    // The code is asked for again, never carried in the page.
    expect(html).not.toContain(CODE);
    expect(html).toMatch(/name="code"[^>]*required/);
    expect(html).not.toMatch(/name="code"[^>]*value=/);
  });

  it("needs no Cloudflare token and makes no Cloudflare call", async () => {
    const world = createWorld();
    await previewed(world);
    expect(world.cloudflare.requests).toHaveLength(0);
  });

  it("refuses a wrong code and shows nothing about the choices", async () => {
    const world = createWorld();
    const res = await world.post("/setup/preview", {
      ...CHOICES,
      code: "wrong",
    });
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).not.toContain("CNAME");
    expect(html).not.toContain('name="inputs"');
    expect(world.db.calls.fail).toBe(1);
  });

  it("refuses a missing code the same way", async () => {
    const world = createWorld();
    expect((await world.post("/setup/preview", CHOICES)).status).toBe(401);
  });

  it("checks the code before it validates anything else", async () => {
    const world = createWorld();
    const res = await world.post("/setup/preview", {
      code: "wrong",
      host: "not a host",
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toMatch(/hostname is not valid/);
  });

  it("sends the form back with the problems, safely escaped, and never the code", async () => {
    const world = createWorld();
    const res = await world.post("/setup/preview", {
      ...CHOICES,
      code: CODE,
      host: '"><script>alert(1)</script>',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/hostname is not valid/);
    expect(html).not.toContain("<script>");
    // An invalid value is not given back at all; the valid ones are.
    expect(html).not.toContain("script&gt;");
    expect(html).toContain(PLATFORM_HOST);
    expect(shown(html)).toContain("amy@example.com");
    expect(html).not.toContain(CODE);
    expect(html).not.toContain('name="inputs"');
  });

  it("ignores an app address sent in the form: the DNS target is where the page is", async () => {
    const world = createWorld();
    const { html } = await previewed(world, {
      ...CHOICES,
      origin: "attacker.example.net",
    });
    expect(html).toContain("CNAME engine.example.com -&gt; " + PLATFORM_HOST);
    expect(html).not.toContain("attacker.example.net");
  });

  it("refuses to plan when the page was not reached on a usable address", async () => {
    const world = createWorld();
    const res = await world.post(
      "/setup/preview",
      { ...CHOICES, code: CODE, origin: PLATFORM_HOST },
      {},
      "localhost",
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/own address is not valid/);
  });

  it("says in words whether what is already there will be replaced", async () => {
    const world = createWorld();
    const off = await previewed(world);
    expect(off.html).toMatch(/setup stops and changes nothing/);
    const on = await previewed(world, { ...CHOICES, replace: "yes" });
    expect(on.html).toMatch(/it is repointed here/);
    expect(on.html).toMatch(/taken over and rewritten/);
  });

  it("says 'closed' when the database holds a different code", async () => {
    const world = createWorld({
      dbCode: "a-different-code-is-in-the-database-01",
    });
    const res = await world.post("/setup/preview", { ...CHOICES, code: CODE });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/kbe access reopen/);
  });

  it("answers 503 when the lockout cannot be read, and accepts nothing", async () => {
    const world = createWorld({
      deps: {
        lockout: {
          attemptCheck: async () => {
            throw new Error("database down");
          },
          attemptFail: async () => ({ locked: false, retry_after_seconds: 0 }),
          codeValid: async () => true,
        },
      },
    });
    const res = await world.post("/setup/preview", { ...CHOICES, code: CODE });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('name="inputs"');
  });
});

describe("the lockout", () => {
  it("locks after five wrong codes, refuses the right one, and lifts after an hour", async () => {
    const world = createWorld();
    for (let i = 0; i < 4; i += 1) {
      const res = await world.post("/setup/preview", {
        ...CHOICES,
        code: "guess-" + i,
      });
      expect(res.status).toBe(401);
    }
    const fifth = await world.post("/setup/preview", {
      ...CHOICES,
      code: "guess-5",
    });
    expect(fifth.status).toBe(429);
    expect(fifth.headers.get("Retry-After")).toBe("3600");
    expect(await fifth.text()).toMatch(/about 60 more minutes/);

    const right = await world.post("/setup/preview", {
      ...CHOICES,
      code: CODE,
    });
    expect(right.status).toBe(429);
    expect(await right.text()).not.toContain('name="inputs"');
    const apply = await world.post("/setup/apply", {
      code: CODE,
      cf_token: GOOD_TOKEN,
    });
    expect(apply.status).toBe(429);
    expect(world.cloudflare.requests).toHaveLength(0);

    world.clock.now += 59 * MINUTE;
    expect(
      (await world.post("/setup/preview", { ...CHOICES, code: CODE })).status,
    ).toBe(429);
    world.clock.now += 2 * MINUTE;
    expect(
      (await world.post("/setup/preview", { ...CHOICES, code: CODE })).status,
    ).toBe(200);
  });

  it("counts wrong codes on the apply route too", async () => {
    const world = createWorld();
    const signed = await previewed(world);
    for (let i = 0; i < 5; i += 1) {
      await world.post("/setup/apply", {
        inputs: signed.inputs,
        sig: signed.sig,
        code: "guess",
        cf_token: GOOD_TOKEN,
      });
    }
    const res = await world.post("/setup/apply", {
      inputs: signed.inputs,
      sig: signed.sig,
      code: CODE,
      cf_token: GOOD_TOKEN,
    });
    expect(res.status).toBe(429);
    expect(world.cloudflare.requests).toHaveLength(0);
    expect(world.db.row.setup_state).toBe("open");
  });
});

describe("form posts must come from the setup page", () => {
  const body = { ...CHOICES, code: CODE };

  it.each([
    [{ "Sec-Fetch-Site": "cross-site" }],
    [{ "Sec-Fetch-Site": "same-site" }],
    [{ "Sec-Fetch-Site": "none" }],
    [{ "Sec-Fetch-Site": "", Origin: "https://evil.example.net" }],
    [{ "Sec-Fetch-Site": "", Origin: "null" }],
    [{ "Sec-Fetch-Site": "", Origin: "not a url" }],
  ])(
    "refuses %j with 403, without spending a code attempt",
    async (headers) => {
      const world = createWorld();
      const res = await world.post("/setup/preview", body, headers);
      expect(res.status).toBe(403);
      expect(world.db.calls.check + world.db.calls.fail).toBe(0);
      const apply = await world.post("/setup/apply", body, headers);
      expect(apply.status).toBe(403);
      expect(world.cloudflare.requests).toHaveLength(0);
    },
  );

  it("accepts a same-origin Origin header, and a client that sends neither header", async () => {
    const world = createWorld();
    const same = await world.post("/setup/preview", body, {
      "Sec-Fetch-Site": "",
      Origin: "https://" + PLATFORM_HOST,
    });
    expect(same.status).toBe(200);
    const none = await world.post("/setup/preview", body, {
      "Sec-Fetch-Site": "",
    });
    expect(none.status).toBe(200);
  });

  it.each([
    "application/json",
    "text/plain",
    "multipart/form-data; boundary=x",
  ])("refuses a %s body", async (type) => {
    const world = createWorld();
    const res = await world.post("/setup/preview", body, {
      "Content-Type": type,
    });
    expect(res.status).toBe(415);
    expect(world.db.calls.check).toBe(0);
  });

  it("sets a referrer policy that lets its own form posts carry an Origin", async () => {
    const world = createWorld();
    expect((await world.get()).headers.get("Referrer-Policy")).toBe(
      "same-origin",
    );
  });
});

describe("POST /setup/apply", () => {
  const applyWith = async (
    world: ReturnType<typeof createWorld>,
    over: Record<string, string> = {},
  ) => {
    const signed = await previewed(world);
    return world.post("/setup/apply", {
      inputs: signed.inputs,
      sig: signed.sig,
      code: CODE,
      cf_token: GOOD_TOKEN,
      ...over,
    });
  };

  it("sets up Cloudflare, stores the settings, closes setup and shows the connector address", async () => {
    const world = createWorld();
    const res = await applyWith(world);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Setup is complete");
    // Seen live: the edge answers 404 for a short while after creation.
    expect(html).toMatch(/Sign-in can take a minute or two to start working/);
    expect(html).toMatch(/not found \(404\)/);
    expect(html).toContain("https://engine.example.com/mcp");
    expect(html).toMatch(/Delete the Cloudflare API token/);
    // 2026-11-20: DigitalOcean answered not-found until the hostname was
    // added to the app's domains. The page says exactly how.
    expect(html).toMatch(/Add engine\.example\.com to the app in DigitalOcean/);
    expect(html).toMatch(/Settings.*Domains.*Add domain/s);
    expect(html).toMatch(/You manage your domain/);
    expect(html).toMatch(/doctl apps spec get/);
    expect(html).toContain("Created");
    expect(html).not.toContain("Failed");

    const [engineApp, adminApp] = world.cloudflare.state.apps;
    expect(world.db.row.access).toEqual({
      team_domain: "https://acme.cloudflareaccess.com",
      aud: engineApp?.["aud"],
      status_aud: adminApp?.["aud"],
      host: "engine.example.com",
      resource_url: "https://engine.example.com/mcp",
      level: "people",
      session: "8760h",
    });
    expect(world.db.row.setup_state).toBe("complete");
    expect(world.db.row.code_hash).toBeNull();
    expect(world.seen.completed).toBe(1);
  });

  it("refuses altered signed inputs and calls Cloudflare not at all", async () => {
    const world = createWorld();
    const signed = await previewed(world);
    const decoded = JSON.parse(
      Buffer.from(signed.inputs, "base64url").toString("utf8"),
    );
    decoded.inputs.emails = ["attacker@example.net"];
    const altered = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    for (const fields of [
      { inputs: altered, sig: signed.sig },
      { inputs: signed.inputs, sig: "0".repeat(64) },
      { inputs: signed.inputs },
      { sig: signed.sig },
      {},
    ]) {
      const res = await world.post("/setup/apply", {
        code: CODE,
        cf_token: GOOD_TOKEN,
        ...fields,
      } as Record<string, string>);
      expect(res.status).toBe(400);
    }
    expect(world.cloudflare.requests).toHaveLength(0);
    expect(world.db.row.setup_state).toBe("open");
  });

  it("refuses plain (unsigned) choices sent straight to apply", async () => {
    const world = createWorld();
    const res = await world.post("/setup/apply", {
      ...CHOICES,
      code: CODE,
      cf_token: GOOD_TOKEN,
    });
    expect(res.status).toBe(400);
    expect(world.cloudflare.requests).toHaveLength(0);
  });

  it("refuses a preview that has expired", async () => {
    const world = createWorld();
    const signed = await previewed(world);
    world.clock.now += 31 * MINUTE;
    const res = await world.post("/setup/apply", {
      inputs: signed.inputs,
      sig: signed.sig,
      code: CODE,
      cf_token: GOOD_TOKEN,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/too old/);
    expect(world.cloudflare.requests).toHaveLength(0);
  });

  it("refuses a wrong code even with validly signed inputs", async () => {
    const world = createWorld();
    const res = await applyWith(world, { code: "wrong" });
    expect(res.status).toBe(401);
    expect(world.cloudflare.requests).toHaveLength(0);
  });

  it("refuses when the config's owner changed after the preview", async () => {
    let owner = "owner@example.com";
    const world = createWorld({ deps: { ownerEmail: async () => owner } });
    const signed = await previewed(world);
    owner = "someone.else@example.com";
    const res = await world.post("/setup/apply", {
      inputs: signed.inputs,
      sig: signed.sig,
      code: CODE,
      cf_token: GOOD_TOKEN,
    });
    expect(res.status).toBe(400);
    expect(world.cloudflare.requests).toHaveLength(0);
  });

  it("refuses a preview that was made on a different address", async () => {
    const world = createWorld();
    const signed = await previewed(world);
    const res = await world.post(
      "/setup/apply",
      {
        inputs: signed.inputs,
        sig: signed.sig,
        code: CODE,
        cf_token: GOOD_TOKEN,
      },
      {},
      "other-app.example.net",
    );
    expect(res.status).toBe(400);
    expect(world.cloudflare.requests).toHaveLength(0);
  });

  it("runs one apply at a time: a second one sent meanwhile is refused", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = createWorld();
    const world = createWorld({
      deps: {
        cloudflareFetch: async (url, init) => {
          await gate;
          return inner.cloudflare.fetch(url, init);
        },
      },
    });
    const signed = await previewed(world);
    const fields = {
      inputs: signed.inputs,
      sig: signed.sig,
      code: CODE,
      cf_token: GOOD_TOKEN,
    };
    const first = world.post("/setup/apply", fields);
    // Let the first reach Cloudflare and wait there.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await world.post("/setup/apply", fields);
    expect(second.status).toBe(409);
    expect(await second.text()).toMatch(/already running/);
    release();
    expect((await first).status).toBe(200);
    expect(inner.cloudflare.state.apps).toHaveLength(3);
    expect(inner.cloudflare.state.policies).toHaveLength(3);
    // ...and the lock is released afterwards, even after a failure.
    const third = await world.post("/setup/apply", fields);
    expect(third.status).not.toBe(409);
  });

  it("finishes a setup under way even if someone locks the page meanwhile", async () => {
    const inner = createWorld();
    let struck = false;
    const world = createWorld({
      deps: {
        cloudflareFetch: async (url, init) => {
          if (!struck) {
            struck = true;
            // Five wrong codes arrive while Cloudflare is being set up.
            for (let i = 0; i < 5; i += 1) await world.db.attemptFail();
          }
          return inner.cloudflare.fetch(url, init);
        },
      },
    });
    const signed = await previewed(world);
    const res = await world.post("/setup/apply", {
      inputs: signed.inputs,
      sig: signed.sig,
      code: CODE,
      cf_token: GOOD_TOKEN,
    });
    expect(struck).toBe(true);
    expect(res.status).toBe(200);
    expect(world.db.row.setup_state).toBe("complete");
  });

  it("but a lock still stops a setup that starts after it", async () => {
    const world = createWorld();
    const signed = await previewed(world);
    for (let i = 0; i < 5; i += 1) await world.db.attemptFail();
    const res = await world.post("/setup/apply", {
      inputs: signed.inputs,
      sig: signed.sig,
      code: CODE,
      cf_token: GOOD_TOKEN,
    });
    expect(res.status).toBe(429);
    expect(world.cloudflare.requests).toHaveLength(0);
    expect(world.db.row.setup_state).toBe("open");
  });

  it("reports a missing or malformed token without calling Cloudflare", async () => {
    const world = createWorld();
    for (const cf_token of [
      "",
      "short",
      "has a space in it 0123456789 0123456789",
    ]) {
      const res = await applyWith(world, { cf_token });
      expect(res.status).toBe(422);
      expect(await res.text()).toMatch(
        /does not look like a Cloudflare API token/,
      );
    }
    expect(world.cloudflare.requests).toHaveLength(0);
    expect(world.db.row.setup_state).toBe("open");
  });

  it("on a Cloudflare failure part-way: says which steps were done, and leaves setup open", async () => {
    const world = createWorld();
    world.cloudflare.failOn({
      method: "POST",
      path: /\/access\/apps$/,
      status: 500,
      message: "internal error",
      times: 1,
    });
    const res = await applyWith(world);
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("Setup stopped");
    expect(html).toMatch(
      /Set who may sign in<\/span><span class="badge created">Created/,
    );
    expect(html).toMatch(/class="badge failed">Failed/);
    expect(html).toMatch(/class="badge not_run">Not run/);
    expect(html).toMatch(/Setup is still open/);
    expect(html).not.toContain("Connect Claude");

    expect(world.db.row.access).toBeNull();
    expect(world.db.row.setup_state).toBe("open");
    expect(world.db.calls.complete).toBe(0);
    expect(world.seen.completed).toBe(0);

    // The same choices again finish the job, with no duplicates.
    const again = await applyWith(world);
    expect(again.status).toBe(200);
    expect(world.cloudflare.state.apps).toHaveLength(3);
    expect(world.cloudflare.state.policies).toHaveLength(3);
    expect(world.cloudflare.state.dnsRecords).toHaveLength(1);
    expect(world.db.row.setup_state).toBe("complete");
  });

  it("names the permission a token is missing", async () => {
    const world = createWorld({ cloudflare: { denied: ["organization"] } });
    const res = await applyWith(world);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(
      "Access: Organizations, Identity Providers, and Groups",
    );
    expect(world.cloudflare.writes()).toHaveLength(0);
    expect(world.db.row.setup_state).toBe("open");
  });

  it("tells the person what to do when Zero Trust was never opened", async () => {
    const world = createWorld({ cloudflare: { organization: null } });
    const res = await applyWith(world);
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/open Zero Trust once, pick a team name/);
    expect(world.db.row.setup_state).toBe("open");
  });

  it("reports it when the database refuses the code at the last step", async () => {
    const world = createWorld({ deps: { complete: async () => false } });
    const res = await applyWith(world);
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(
      /did not accept the setup code at the last step/,
    );
    expect(world.seen.completed).toBe(0);
  });

  it("reports it when the database cannot store the result, without the database's words", async () => {
    const world = createWorld({
      deps: {
        complete: async () => {
          throw new Error("password=hunter2 connection refused");
        },
      },
    });
    const res = await applyWith(world);
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toMatch(/could not store the result/);
    expect(html).not.toContain("hunter2");
  });

  it("a second apply on a finished Engine is refused: the window is closed", async () => {
    const world = createWorld();
    const signed = await previewed(world);
    const fields = {
      inputs: signed.inputs,
      sig: signed.sig,
      code: CODE,
      cf_token: GOOD_TOKEN,
    };
    expect((await world.post("/setup/apply", fields)).status).toBe(200);
    const writes = world.cloudflare.writes().length;
    // Now set up: the page is behind sign-in, and no assertion was sent.
    const again = await world.post("/setup/apply", fields, {}, ENGINE_HOST);
    expect(again.status).toBe(401);
    expect(world.cloudflare.writes().length).toBe(writes);
  });
});

describe("/setup once the Engine is set up", () => {
  async function finished() {
    const world = createWorld();
    const signed = await previewed(world);
    await world.post("/setup/apply", {
      inputs: signed.inputs,
      sig: signed.sig,
      code: CODE,
      cf_token: GOOD_TOKEN,
    });
    expect(world.db.row.setup_state).toBe("complete");
    return world;
  }
  const admin = { "Cf-Access-Jwt-Assertion": ADMIN_ASSERTION };

  it("needs a Cloudflare assertion: 401 without one, and no form", async () => {
    const world = await finished();
    const res = await world.get({}, ENGINE_HOST);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("<form");
  });

  it("refuses an assertion that does not verify", async () => {
    const world = await finished();
    const res = await world.get(
      { "Cf-Access-Jwt-Assertion": "made.up.assertion" },
      ENGINE_HOST,
    );
    expect(res.status).toBe(401);
  });

  it("verifies against the status application's audience and the team domain", async () => {
    const world = await finished();
    await world.get(admin, ENGINE_HOST);
    expect(world.seen.verify).toEqual([
      {
        audience: world.db.row.access?.status_aud,
        issuer: "https://acme.cloudflareaccess.com",
      },
    ]);
    expect(world.db.row.access?.status_aud).not.toBe(world.db.row.access?.aud);
  });

  it("refuses a signed-in person who is not an administrator", async () => {
    const world = await finished();
    const res = await world.get(
      { "Cf-Access-Jwt-Assertion": READER_ASSERTION },
      ENGINE_HOST,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("engine.example.com/mcp");
  });

  it("refuses when the page has no sign-in application of its own", async () => {
    for (const statusAudience of [
      async () => undefined,
      async (access: { aud: string }) => access.aud,
    ]) {
      const world = await finished();
      const res = await world.app.fetch(
        new Request("http://" + ENGINE_HOST + "/setup", { headers: admin }),
      );
      expect(res.status).toBe(200);
      const guarded = createWorld({
        deps: {
          mode: world.deps.mode,
          guard: { ...world.deps.guard, statusAudience },
        },
      });
      const refused = await guarded.get(admin, ENGINE_HOST);
      expect(refused.status).toBe(503);
    }
  });

  it("fails closed when the administrator check cannot be made", async () => {
    const world = await finished();
    const broken = createWorld({
      deps: {
        mode: world.deps.mode,
        guard: {
          ...world.deps.guard,
          isAdmin: async () => {
            throw new Error("database down");
          },
        },
      },
    });
    expect((await broken.get(admin, ENGINE_HOST)).status).toBe(503);
  });

  it("shows an administrator the level, the hostname and how to run setup again, and no form", async () => {
    const world = await finished();
    const res = await world.get(admin, ENGINE_HOST);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(SETUP_CSP);
    const html = await res.text();
    expect(html).toContain("Named people");
    expect(html).toContain("engine.example.com");
    expect(html).toMatch(/kbe access reopen/);
    expect(html).toMatch(/fresh Cloudflare API token/);
    expect(html).not.toContain("<form");
    expect(html).not.toContain('name="code"');
  });

  it("refuses the form posts, even from an administrator with the old code", async () => {
    const world = await finished();
    const preview = await world.post(
      "/setup/preview",
      { ...CHOICES, code: CODE },
      admin,
      ENGINE_HOST,
    );
    expect(preview.status).toBe(409);
    const apply = await world.post(
      "/setup/apply",
      { code: CODE, cf_token: GOOD_TOKEN },
      admin,
      ENGINE_HOST,
    );
    expect(apply.status).toBe(409);
    expect(world.db.calls.check).toBe(2); // only the two from the original run
  });

  describe("after the owner reopens setup", () => {
    const NEW_CODE = "a-brand-new-setup-code-after-reopen-0002";

    async function reopened() {
      const done = await finished();
      done.db.reopen(NEW_CODE);
      const world = createWorld({
        setupCode: NEW_CODE,
        deps: {
          mode: done.deps.mode,
          lockout: done.deps.lockout,
          complete: done.deps.complete,
          cloudflareFetch: done.deps.cloudflareFetch,
        },
      });
      return { world, done };
    }

    it("still needs sign-in: the form is not shown to a stranger with the code", async () => {
      const { world } = await reopened();
      expect((await world.get({}, ENGINE_HOST)).status).toBe(401);
      const res = await world.post(
        "/setup/preview",
        { ...CHOICES, code: NEW_CODE },
        {},
        ENGINE_HOST,
      );
      expect(res.status).toBe(401);
    });

    it("shows an administrator the form, and the old code no longer works", async () => {
      const { world } = await reopened();
      const res = await world.get(admin, ENGINE_HOST);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('action="/setup/preview"');
      expect(html).toMatch(/current sign-in settings stay in force/);
      // Reached on the Engine's own hostname now, so the app's address is asked for.
      expect(html).toContain('name="origin"');
      // The hostname and level in force are filled in already.
      expect(html).toContain('name="host" value="engine.example.com"');
      expect(html).toMatch(/name="level" value="people" checked/);

      const old = await world.post(
        "/setup/preview",
        { ...CHOICES, code: CODE },
        admin,
        ENGINE_HOST,
      );
      expect(old.status).toBe(401);
    });

    it("lets an administrator run setup again, updating instead of duplicating", async () => {
      const { world, done } = await reopened();
      const preview = await world.post(
        "/setup/preview",
        { ...CHOICES, code: NEW_CODE, level: "owner", emails: "" },
        admin,
        ENGINE_HOST,
      );
      expect(preview.status).toBe(200);
      const html = await preview.text();
      const field = (name: string) =>
        new RegExp('name="' + name + '" value="([^"]*)"').exec(html)?.[1] ?? "";
      const res = await world.post(
        "/setup/apply",
        {
          inputs: field("inputs"),
          sig: field("sig"),
          code: NEW_CODE,
          cf_token: GOOD_TOKEN,
        },
        admin,
        ENGINE_HOST,
      );
      expect(res.status).toBe(200);
      expect(done.cloudflare.state.apps).toHaveLength(3);
      expect(done.cloudflare.state.policies).toHaveLength(3);
      expect(done.db.row.access?.level).toBe("owner");
      expect(done.db.row.setup_state).toBe("complete");
    });

    it("says so when the app was not given the new code", async () => {
      const { world } = await reopened();
      const noCode = createWorld({
        setupCode: null,
        deps: { mode: world.deps.mode },
      });
      const res = await noCode.get(admin, ENGINE_HOST);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/has no setup code/);
      expect(html).not.toContain("<form");
    });
  });
});

describe("/setup on a deployment that uses the environment variables", () => {
  const envMode = async () =>
    ({
      kind: "ready",
      setupOpen: false,
      access: {
        teamDomain: "https://acme.cloudflareaccess.com",
        aud: "env-mcp-aud",
        statusAud: "env-status-aud",
        host: ENGINE_HOST,
        resourceUrl: "https://engine.example.com/mcp",
        source: "environment",
      },
    }) as const;
  const admin = { "Cf-Access-Jwt-Assertion": ADMIN_ASSERTION };

  it("is behind sign-in, shows no form, and refuses the posts", async () => {
    const world = createWorld({ deps: { mode: envMode } });
    expect((await world.get({}, ENGINE_HOST)).status).toBe(401);

    const res = await world.get(admin, ENGINE_HOST);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/environment variables/);
    expect(html).not.toContain("<form");

    const post = await world.post(
      "/setup/preview",
      { ...CHOICES, code: CODE },
      admin,
      ENGINE_HOST,
    );
    expect(post.status).toBe(409);
    expect(world.db.calls.check).toBe(0);
  });
});
