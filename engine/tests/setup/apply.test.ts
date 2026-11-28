import { describe, it, expect } from "vitest";
import { applyPlan, type ApplyReport } from "../../src/setup/apply.js";
import {
  CLOUDFLARE_API_BASE,
  createCloudflareClient,
} from "../../src/setup/cloudflare-client.js";
import { zoneCandidates } from "../../src/setup/discover.js";
import type { SetupInputs } from "../../src/setup/inputs.js";
import { buildPlan } from "../../src/setup/plan.js";
import {
  createFakeCloudflare,
  GOOD_TOKEN,
  ZONE_ID,
  type FakeCloudflare,
  type FakeOptions,
} from "./fake-cloudflare.js";

const INPUTS: SetupInputs = {
  host: "engine.example.com",
  origin: "app-abc12.ondigitalocean.app",
  level: "people",
  ownerEmail: "owner@example.com",
  emails: ["amy@example.com"],
  domains: [],
  replaceExisting: false,
};

function run(
  fake: FakeCloudflare,
  inputs: SetupInputs = INPUTS,
  token: string = GOOD_TOKEN,
): Promise<ApplyReport> {
  const client = createCloudflareClient({ token, fetch: fake.fetch });
  return applyPlan(buildPlan(inputs), client);
}

const statuses = (report: ApplyReport) =>
  Object.fromEntries(report.steps.map((s) => [s.id, s.status]));
const noteOf = (report: ApplyReport, id: string) =>
  report.steps.find((s) => s.id === id)?.note ?? "";

function fresh(options: FakeOptions = {}) {
  return createFakeCloudflare(options);
}

describe("apply: a fresh Cloudflare account", () => {
  it("creates everything and reads back the team domain and both AUD tags", async () => {
    const fake = fresh();
    const report = await run(fake);

    expect(statuses(report)).toEqual({
      token: "unchanged",
      organization: "updated",
      login_method: "created",
      dns: "created",
      engine_policy: "created",
      engine_app: "created",
      admin_policy: "created",
      admin_app: "created",
      tick_policy: "created",
      tick_app: "created",
      hooks_policy: "created",
      hooks_app: "created",
    });
    const [engineApp, adminApp] = fake.state.apps;
    expect(report.access).toEqual({
      team_domain: "https://acme.cloudflareaccess.com",
      aud: engineApp?.["aud"],
      status_aud: adminApp?.["aud"],
      host: "engine.example.com",
      resource_url: "https://engine.example.com/mcp",
      level: "people",
      session: "8760h",
    });
    expect(report.access?.aud).not.toBe(report.access?.status_aud);
  });

  it("makes the DNS record, the rules and the two applications as previewed", async () => {
    const fake = fresh();
    await run(fake);

    expect(fake.state.dnsRecords).toHaveLength(1);
    expect(fake.state.dnsRecords[0]).toMatchObject({
      type: "CNAME",
      name: "engine.example.com",
      content: "app-abc12.ondigitalocean.app",
      proxied: true,
    });

    const [signIn, admins] = fake.state.policies;
    expect(signIn).toMatchObject({
      decision: "allow",
      include: [
        { email: { email: "owner@example.com" } },
        { email: { email: "amy@example.com" } },
      ],
      exclude: [],
      require: [],
    });
    expect(admins).toMatchObject({
      decision: "allow",
      include: [{ email: { email: "owner@example.com" } }],
    });

    const otp = fake.state.identityProviders[0];
    expect(otp).toMatchObject({ type: "onetimepin" });
    const [engineApp, adminApp] = fake.state.apps;
    expect(engineApp).toMatchObject({
      type: "self_hosted",
      domain: "engine.example.com",
      allowed_idps: [otp?.["id"]],
      policies: [{ id: signIn?.["id"], precedence: 1 }],
      oauth_configuration: {
        enabled: true,
        dynamic_client_registration: {
          enabled: true,
          allowed_uris: [
            "https://claude.ai/api/mcp/auth_callback",
            "https://claude.com/api/mcp/auth_callback",
          ],
        },
      },
    });
    expect(adminApp).toMatchObject({
      domain: "engine.example.com/status",
      destinations: [
        { type: "public", uri: "engine.example.com/status" },
        { type: "public", uri: "engine.example.com/setup" },
      ],
      allowed_idps: [otp?.["id"]],
      policies: [{ id: admins?.["id"], precedence: 1 }],
      mfa_config: {
        mfa_disabled: false,
        allowed_authenticators: ["totp", "biometrics", "security_key"],
      },
    });
  });

  it("switches on the account's second factor without losing other settings", async () => {
    const fake = fresh();
    await run(fake);
    expect(fake.state.organization).toMatchObject({
      auth_domain: "acme.cloudflareaccess.com",
      name: "Acme",
      login_design: { header_text: "Hello" },
      mfa_config: {
        allowed_authenticators: ["totp", "biometrics", "security_key"],
      },
    });
    // It is not made mandatory for the account's other applications.
    expect(fake.state.organization).not.toHaveProperty(
      "mfa_required_for_all_apps",
    );
  });

  it.each([
    [
      "owner",
      { level: "owner", emails: [] },
      [{ email: { email: "owner@example.com" } }],
    ],
    [
      "domain",
      { level: "domain", emails: [], domains: ["example.org"] },
      [
        { email: { email: "owner@example.com" } },
        { email_domain: { domain: "example.org" } },
      ],
    ],
  ] as const)(
    "writes the sign-in rule for the %s level",
    async (_n, over, include) => {
      const fake = fresh();
      const report = await run(fake, { ...INPUTS, ...over } as SetupInputs);
      expect(report.access?.level).toBe(over.level);
      expect(fake.state.policies[0]?.["include"]).toEqual(include);
    },
  );
});

describe("apply: outbound requests", () => {
  it("go only to the Cloudflare API, each with the token, a timeout and no redirects", async () => {
    const fake = fresh();
    await run(fake);
    expect(fake.requests.length).toBeGreaterThan(10);
    for (const r of fake.requests) {
      expect(r.url.startsWith(CLOUDFLARE_API_BASE), r.url).toBe(true);
      expect(new URL(r.url).host).toBe("api.cloudflare.com");
      expect(r.redirect).toBe("error");
      expect(r.hasTimeout).toBe(true);
      expect(r.authorization).toBe("Bearer " + GOOD_TOKEN);
    }
  });

  it("never put the token in a URL or a request body", async () => {
    const fake = fresh();
    await run(fake);
    for (const r of fake.requests) {
      expect(r.url).not.toContain(GOOD_TOKEN);
      expect(JSON.stringify(r.body ?? null)).not.toContain(GOOD_TOKEN);
    }
  });
});

describe("apply: a second run", () => {
  it("changes nothing and writes nothing", async () => {
    const fake = fresh();
    const first = await run(fake);
    const before = JSON.stringify(fake.state);
    const writesBefore = fake.writes().length;

    const second = await run(fake);
    expect(fake.writes().length).toBe(writesBefore);
    expect(JSON.stringify(fake.state)).toBe(before);
    expect(new Set(Object.values(statuses(second)))).toEqual(
      new Set(["unchanged"]),
    );
    expect(second.access).toEqual(first.access);
    expect(fake.state.apps).toHaveLength(4);
    expect(fake.state.policies).toHaveLength(4);
    expect(fake.state.dnsRecords).toHaveLength(1);
    expect(fake.state.identityProviders).toHaveLength(1);
  });

  it("with a different list updates the one rule and duplicates nothing", async () => {
    const fake = fresh();
    const first = await run(fake);
    const second = await run(fake, {
      ...INPUTS,
      emails: ["amy@example.com", "zed@example.com"],
    });
    expect(statuses(second)).toMatchObject({
      engine_policy: "updated",
      engine_app: "unchanged",
      admin_policy: "unchanged",
      admin_app: "unchanged",
      tick_policy: "unchanged",
      tick_app: "unchanged",
      hooks_policy: "unchanged",
      hooks_app: "unchanged",
      dns: "unchanged",
    });
    expect(fake.state.policies).toHaveLength(4);
    expect(fake.state.apps).toHaveLength(4);
    expect(fake.state.policies[0]?.["include"]).toHaveLength(3);
    // The same applications: the AUD tags do not change.
    expect(second.access?.aud).toBe(first.access?.aud);
  });

  it("repairs an application that was changed by hand, keeping fields it does not manage", async () => {
    const fake = fresh();
    await run(fake);
    const app = fake.state.apps[0] as Record<string, unknown>;
    const aud = app["aud"];
    app["oauth_configuration"] = { enabled: false };
    app["custom_deny_message"] = "Ask the owner";
    app["policies"] = [];

    const report = await run(fake);
    expect(statuses(report).engine_app).toBe("updated");
    const repaired = fake.state.apps[0] as Record<string, unknown>;
    expect(repaired).toMatchObject({
      aud,
      custom_deny_message: "Ask the owner",
      oauth_configuration: { enabled: true },
      policies: [{ id: fake.state.policies[0]?.["id"], precedence: 1 }],
    });
    expect(fake.state.apps).toHaveLength(4);
  });

  it("rewrites a rule that carries anything that weakens sign-in", async () => {
    for (const extra of [
      { mfa_config: { mfa_disabled: true } },
      { session_duration: "720h" },
      { require: [{ everyone: {} }] },
      { exclude: [{ email: { email: "owner@example.com" } }] },
      { decision: "bypass" },
      { approval_required: true },
    ]) {
      const fake = fresh();
      await run(fake);
      const rule = fake.state.policies[1] as Record<string, unknown>;
      Object.assign(rule, extra);

      const report = await run(fake);
      expect(statuses(report).admin_policy, JSON.stringify(extra)).toBe(
        "updated",
      );
      // Written back with exactly the wanted fields: the extra is gone.
      const { id, ...written } = fake.state.policies[1] as Record<
        string,
        unknown
      >;
      expect(id).toBe(rule["id"]);
      expect(written).toEqual({
        name: "KB Engine administrators: engine.example.com",
        decision: "allow",
        include: [{ email: { email: "owner@example.com" } }],
        exclude: [],
        require: [],
        session_duration: "12h",
      });
      // ...and the run after that has nothing left to do.
      expect(statuses(await run(fake)).admin_policy).toBe("unchanged");
    }
  });

  it("rewrites an application that carries anything that loosens sign-in", async () => {
    for (const extra of [
      { cors_headers: { allow_all_origins: true, allow_credentials: true } },
      { options_preflight_bypass: true },
      { allow_authenticate_via_warp: true },
      { allow_iframe: true },
      { read_service_tokens_from_header: "X-Token" },
    ]) {
      const fake = fresh();
      await run(fake);
      Object.assign(fake.state.apps[0] as Record<string, unknown>, extra);

      const report = await run(fake);
      expect(statuses(report).engine_app, JSON.stringify(extra)).toBe(
        "updated",
      );
      const app = fake.state.apps[0] as Record<string, unknown>;
      for (const key of Object.keys(extra)) expect(app).not.toHaveProperty(key);
      expect(statuses(await run(fake)).engine_app).toBe("unchanged");
    }
  });

  it("puts the second factor back on the admin pages if it was switched off", async () => {
    const fake = fresh();
    await run(fake);
    const admin = fake.state.apps[1] as Record<string, unknown>;
    admin["mfa_config"] = { mfa_disabled: true };
    const report = await run(fake);
    expect(statuses(report).admin_app).toBe("updated");
    expect(fake.state.apps[1]).toMatchObject({
      mfa_config: { mfa_disabled: false },
    });
  });

  it("detaches any other rule that was attached to the application", async () => {
    const fake = fresh();
    await run(fake);
    const app = fake.state.apps[0] as Record<string, unknown>;
    fake.state.policies.push({
      id: "11111111-2222-3333-4444-555555555555",
      name: "added by hand: everyone",
      decision: "allow",
      include: [{ everyone: {} }],
    });
    app["policies"] = [
      ...(app["policies"] as unknown[]),
      { id: "11111111-2222-3333-4444-555555555555", precedence: 2 },
    ];
    const report = await run(fake);
    expect(statuses(report).engine_app).toBe("updated");
    expect(fake.state.apps[0]?.["policies"]).toEqual([
      { id: fake.state.policies[0]?.["id"], precedence: 1 },
    ]);
  });
});

describe("apply: what is already there", () => {
  it("leaves an existing one-time PIN method and second-factor setting alone", async () => {
    const fake = fresh({
      organization: {
        auth_domain: "acme.cloudflareaccess.com",
        mfa_config: { allowed_authenticators: ["security_key"] },
      },
      identityProviders: [
        { id: "99999999-0000-0000-0000-000000000001", type: "onetimepin" },
      ],
    });
    const report = await run(fake);
    expect(statuses(report)).toMatchObject({
      organization: "unchanged",
      login_method: "unchanged",
    });
    expect(fake.state.identityProviders).toHaveLength(1);
    // The admin application asks for a factor the account actually allows.
    expect(fake.state.apps[1]).toMatchObject({
      mfa_config: { allowed_authenticators: ["security_key"] },
    });
  });

  const ELSEWHERE = {
    id: "c".repeat(32),
    type: "CNAME",
    name: "engine.example.com",
    content: "old.example.net",
    proxied: false,
  };

  it("will not repoint a CNAME that goes somewhere else, unless asked", async () => {
    const fake = fresh({ dnsRecords: [ELSEWHERE] });
    const report = await run(fake);
    expect(statuses(report)).toMatchObject({
      dns: "failed",
      engine_policy: "not_run",
    });
    expect(noteOf(report, "dns")).toMatch(/already points somewhere else/);
    expect(noteOf(report, "dns")).toMatch(/Replace what is already there/);
    expect(fake.state.dnsRecords[0]).toMatchObject({
      content: "old.example.net",
    });
    const dnsWrites = fake
      .writes()
      .filter((w) => w.path.includes("dns_records"));
    expect(dnsWrites).toHaveLength(0);
    expect(report.access).toBeNull();
  });

  it("repoints it when asked to replace what is there", async () => {
    const fake = fresh({ dnsRecords: [ELSEWHERE] });
    const report = await run(fake, { ...INPUTS, replaceExisting: true });
    expect(statuses(report).dns).toBe("updated");
    expect(fake.state.dnsRecords).toHaveLength(1);
    expect(fake.state.dnsRecords[0]).toMatchObject({
      id: "c".repeat(32),
      content: "app-abc12.ondigitalocean.app",
      proxied: true,
    });
  });

  it("repoints its own record without being asked", async () => {
    const fake = fresh();
    await run(fake);
    const report = await run(fake, {
      ...INPUTS,
      origin: "app-new99.ondigitalocean.app",
    });
    expect(statuses(report).dns).toBe("updated");
    expect(fake.state.dnsRecords[0]).toMatchObject({
      content: "app-new99.ondigitalocean.app",
    });
  });

  it("switches the proxy on for a record that already points at the app", async () => {
    const fake = fresh({
      dnsRecords: [{ ...ELSEWHERE, content: "app-abc12.ondigitalocean.app" }],
    });
    const report = await run(fake);
    expect(statuses(report).dns).toBe("updated");
    expect(fake.state.dnsRecords[0]).toMatchObject({ proxied: true });
  });

  it("will not take over an application it did not make, unless asked", async () => {
    const theirs = {
      id: "77777777-0000-0000-0000-000000000001",
      aud: "f".repeat(64),
      type: "self_hosted",
      name: "An application made by hand",
      domain: "engine.example.com",
      policies: [],
    };
    const fake = fresh();
    fake.state.apps.push({ ...theirs });
    const refused = await run(fake);
    expect(statuses(refused)).toMatchObject({
      engine_app: "failed",
      admin_policy: "not_run",
    });
    expect(noteOf(refused, "engine_app")).toMatch(/that setup did not make/);
    expect(fake.state.apps[0]).toEqual(theirs);
    expect(refused.access).toBeNull();

    const taken = await run(fake, { ...INPUTS, replaceExisting: true });
    expect(statuses(taken).engine_app).toBe("updated");
    expect(fake.state.apps[0]).toMatchObject({
      id: theirs.id,
      aud: theirs.aud,
      name: "KB Engine: engine.example.com",
    });
    expect(taken.access?.aud).toBe(theirs.aud);
  });

  it("will not replace DNS records of another kind", async () => {
    const fake = fresh({
      dnsRecords: [
        {
          id: "d".repeat(32),
          type: "A",
          name: "engine.example.com",
          content: "192.0.2.1",
        },
      ],
    });
    const report = await run(fake);
    expect(statuses(report)).toMatchObject({
      dns: "failed",
      engine_policy: "not_run",
      admin_app: "not_run",
      tick_policy: "not_run",
      tick_app: "not_run",
      hooks_policy: "not_run",
      hooks_app: "not_run",
    });
    expect(noteOf(report, "dns")).toMatch(/already has DNS records/);
    expect(fake.state.dnsRecords).toHaveLength(1);
    expect(report.access).toBeNull();
  });
});

describe("apply: the token", () => {
  it("that Cloudflare does not accept stops everything before any change", async () => {
    const fake = fresh();
    const report = await run(
      fake,
      INPUTS,
      "a-token-cloudflare-does-not-know-0000001",
    );
    expect(statuses(report).token).toBe("failed");
    expect(noteOf(report, "token")).toMatch(/did not accept this token/);
    expect(new Set(Object.values(statuses(report)))).toEqual(
      new Set(["failed", "not_run"]),
    );
    expect(fake.writes()).toHaveLength(0);
    expect(report.access).toBeNull();
  });

  it.each([
    ["apps", /Access: Apps and Policies/],
    ["organization", /Access: Organizations, Identity Providers, and Groups/],
    ["dns", /DNS/],
  ] as const)(
    "that cannot read %s is refused by name before any change",
    async (area, named) => {
      const fake = fresh({ denied: [area] });
      const report = await run(fake);
      expect(statuses(report).token).toBe("failed");
      expect(noteOf(report, "token")).toMatch(named);
      expect(fake.writes()).toHaveLength(0);
      expect(report.access).toBeNull();
    },
  );

  it("that can read but not write is caught at the first write, which names the permission", async () => {
    const fake = fresh({ readOnly: ["apps"] });
    const report = await run(fake);
    expect(statuses(report)).toEqual({
      token: "unchanged",
      organization: "updated",
      login_method: "created",
      dns: "created",
      engine_policy: "failed",
      engine_app: "not_run",
      admin_policy: "not_run",
      admin_app: "not_run",
      tick_policy: "not_run",
      tick_app: "not_run",
      hooks_policy: "not_run",
      hooks_app: "not_run",
    });
    expect(noteOf(report, "engine_policy")).toMatch(
      /needs: Account - Access: Apps and Policies - Write/,
    );
    expect(report.access).toBeNull();
  });

  it("that reaches more than one zone works, with a warning", async () => {
    const fake = fresh({
      extraZones: [
        {
          id: "e".repeat(32),
          name: "example.org",
          account: { id: "a".repeat(32) },
        },
      ],
    });
    const report = await run(fake);
    expect(report.access).not.toBeNull();
    expect(report.warnings.join(" ")).toMatch(/more than one zone/);
  });

  it("for a zone that does not hold the hostname is refused", async () => {
    const fake = fresh({ zoneName: "example.org" });
    const report = await run(fake);
    expect(noteOf(report, "token")).toMatch(/cannot see a Cloudflare zone/);
    expect(fake.writes()).toHaveLength(0);
  });
});

describe("apply: Cloudflare fails part-way", () => {
  it.each([
    [400, "bad request"],
    [409, "conflict"],
    [500, "internal error"],
    [503, "unavailable"],
  ])(
    "a %i while creating the application gives a partial report",
    async (status, message) => {
      const fake = fresh();
      fake.failOn({ method: "POST", path: /\/access\/apps$/, status, message });
      const report = await run(fake);
      expect(statuses(report)).toEqual({
        token: "unchanged",
        organization: "updated",
        login_method: "created",
        dns: "created",
        engine_policy: "created",
        engine_app: "failed",
        admin_policy: "not_run",
        admin_app: "not_run",
        tick_policy: "not_run",
        tick_app: "not_run",
        hooks_policy: "not_run",
        hooks_app: "not_run",
      });
      expect(noteOf(report, "engine_app")).toContain(String(status));
      expect(report.access).toBeNull();
      // Nothing after the failed step was attempted.
      expect(fake.state.apps).toHaveLength(0);
      expect(fake.state.policies).toHaveLength(1);
    },
  );

  it("and the next run finishes the job without repeating finished steps", async () => {
    const fake = fresh();
    fake.failOn({
      method: "POST",
      path: /\/access\/apps$/,
      status: 500,
      times: 1,
    });
    expect((await run(fake)).access).toBeNull();

    const second = await run(fake);
    expect(statuses(second)).toEqual({
      token: "unchanged",
      organization: "unchanged",
      login_method: "unchanged",
      dns: "unchanged",
      engine_policy: "unchanged",
      engine_app: "created",
      admin_policy: "created",
      admin_app: "created",
      tick_policy: "created",
      tick_app: "created",
      hooks_policy: "created",
      hooks_app: "created",
    });
    expect(second.access).not.toBeNull();
    expect(fake.state.policies).toHaveLength(4);
    expect(fake.state.dnsRecords).toHaveLength(1);
  });

  it("a failure of the last step leaves no settings to store", async () => {
    // Let the first application through; fail the second.
    const again = fresh();
    let posts = 0;
    const fetch: typeof again.fetch = async (url, init) => {
      if (
        init.method === "POST" &&
        /\/access\/apps$/.test(new URL(url).pathname)
      ) {
        posts += 1;
        if (posts === 2)
          return new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 1, message: "no" }],
              result: null,
            }),
            { status: 500 },
          );
      }
      return again.fetch(url, init);
    };
    const client = createCloudflareClient({ token: GOOD_TOKEN, fetch });
    const report = await applyPlan(buildPlan(INPUTS), client);
    expect(statuses(report)).toMatchObject({
      engine_app: "created",
      admin_app: "failed",
      tick_policy: "not_run",
      tick_app: "not_run",
      hooks_policy: "not_run",
      hooks_app: "not_run",
    });
    expect(report.access).toBeNull();
  });

  it("stops starting new steps when it runs out of time", async () => {
    const fake = fresh();
    const clock = { now: 0 };
    const client = createCloudflareClient({
      token: GOOD_TOKEN,
      fetch: fake.fetch,
    });
    const report = await applyPlan(buildPlan(INPUTS), client, {
      now: () => (clock.now += 30_000),
      budgetMs: 70_000,
    });
    expect(Object.values(statuses(report))).toContain("failed");
    expect(report.steps.find((s) => s.status === "failed")?.note).toMatch(
      /ran out of time/,
    );
    expect(report.access).toBeNull();
  });
});

describe("apply: one deadline for the whole run", () => {
  it("makes no call, and waits for none, once the deadline has passed", async () => {
    const fake = fresh();
    const clock = { now: 1_000 };
    const client = createCloudflareClient({
      token: GOOD_TOKEN,
      fetch: async (url, init) => {
        clock.now += 20_000; // every call takes 20 seconds
        return fake.fetch(url, init);
      },
      deadline: 1_000 + 75_000,
      now: () => clock.now,
    });
    const report = await applyPlan(buildPlan(INPUTS), client, {
      now: () => clock.now,
      budgetMs: 75_000,
    });
    expect(report.access).toBeNull();
    expect(Object.values(statuses(report))).toContain("failed");
    // 75 seconds at 20 seconds a call: four calls start, the fifth never does.
    expect(fake.requests.length).toBeLessThanOrEqual(4);
  });
});

describe("apply: Zero Trust has never been opened", () => {
  it("gives a clear manual instruction and changes nothing", async () => {
    const fake = fresh({ organization: null });
    const report = await run(fake);
    expect(statuses(report)).toMatchObject({
      token: "unchanged",
      organization: "failed",
      login_method: "not_run",
      dns: "not_run",
    });
    expect(noteOf(report, "organization")).toMatch(
      /open Zero Trust once, pick a team name/,
    );
    expect(fake.writes()).toHaveLength(0);
    expect(report.access).toBeNull();
  });

  it("refuses a team domain that is not Cloudflare's", async () => {
    const fake = fresh({
      organization: { auth_domain: "keys.attacker.example" },
    });
    const report = await run(fake);
    expect(statuses(report).organization).toBe("failed");
    expect(report.access).toBeNull();
  });
});

describe("finding the zone", () => {
  it("tries the hostname and each parent, never a bare top-level domain", () => {
    expect(zoneCandidates("engine.sub.example.com")).toEqual([
      "engine.sub.example.com",
      "sub.example.com",
      "example.com",
    ]);
    expect(zoneCandidates("example.com")).toEqual(["example.com"]);
  });

  it("finds the zone id for a hostname two levels down", async () => {
    const fake = fresh();
    const report = await run(fake, { ...INPUTS, host: "kb.team.example.com" });
    expect(report.access?.host).toBe("kb.team.example.com");
    expect(
      fake.requests.some((r) =>
        r.path.startsWith("/zones/" + ZONE_ID + "/dns_records"),
      ),
    ).toBe(true);
  });
});
