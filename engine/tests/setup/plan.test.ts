import { describe, it, expect } from "vitest";
import { sessionSentence, type SetupInputs } from "../../src/setup/inputs.js";
import {
  buildPlan,
  CLAUDE_REDIRECT_URIS,
  signInRules,
  type ApplicationStep,
  type PolicyStep,
} from "../../src/setup/plan.js";

const base: SetupInputs = {
  host: "engine.example.com",
  origin: "app-abc12.ondigitalocean.app",
  level: "owner",
  ownerEmail: "owner@example.com",
  emails: [],
  domains: [],
  replaceExisting: false,
};

const step = <T>(inputs: SetupInputs, id: string) =>
  buildPlan(inputs).steps.find((s) => s.id === id) as T;

describe("the plan", () => {
  it("lists the same steps, in the same order, for every level", () => {
    for (const inputs of [
      base,
      { ...base, level: "people" as const, emails: ["amy@example.com"] },
      { ...base, level: "domain" as const, domains: ["example.org"] },
    ]) {
      expect(buildPlan(inputs).steps.map((s) => s.id)).toEqual([
        "organization",
        "login_method",
        "dns",
        "engine_policy",
        "engine_app",
        "admin_policy",
        "admin_app",
        "tick_policy",
        "tick_app",
        "hooks_policy",
        "hooks_app",
      ]);
    }
  });

  it("is pure: the same inputs give the same plan, and the inputs are untouched", () => {
    const inputs = {
      ...base,
      level: "people" as const,
      emails: ["amy@example.com"],
    };
    const frozen = JSON.stringify(inputs);
    expect(buildPlan(inputs)).toEqual(buildPlan(inputs));
    expect(JSON.stringify(inputs)).toBe(frozen);
  });

  it("names the connector address", () => {
    expect(buildPlan(base).connectorUrl).toBe("https://engine.example.com/mcp");
  });

  it("owner only: one email may sign in", () => {
    expect(signInRules(base)).toEqual([
      { email: { email: "owner@example.com" } },
    ]);
    expect(step<PolicyStep>(base, "engine_policy").lines.join(" ")).toContain(
      "Only owner@example.com",
    );
  });

  it("named people: the owner and each listed email", () => {
    const inputs = {
      ...base,
      level: "people" as const,
      emails: ["amy@example.com", "zed@example.com"],
    };
    expect(signInRules(inputs)).toEqual([
      { email: { email: "owner@example.com" } },
      { email: { email: "amy@example.com" } },
      { email: { email: "zed@example.com" } },
    ]);
  });

  it("company domain: each domain, and always the owner", () => {
    const inputs = {
      ...base,
      level: "domain" as const,
      domains: ["example.org", "example.net"],
    };
    expect(signInRules(inputs)).toEqual([
      { email: { email: "owner@example.com" } },
      { email_domain: { domain: "example.org" } },
      { email_domain: { domain: "example.net" } },
    ]);
  });

  it("points the hostname at the app, proxied", () => {
    expect(step(base, "dns")).toMatchObject({
      kind: "dns",
      name: "engine.example.com",
      target: "app-abc12.ondigitalocean.app",
    });
  });

  it("the connector application covers the whole hostname with Managed OAuth", () => {
    const app = step<ApplicationStep>(base, "engine_app");
    expect(app.domain).toBe("engine.example.com");
    expect(app.secondFactor).toBe(false);
    expect(app.policy).toBe("engine_policy");
    expect(app.body).toMatchObject({
      type: "self_hosted",
      domain: "engine.example.com",
      oauth_configuration: {
        enabled: true,
        dynamic_client_registration: {
          enabled: true,
          allowed_uris: [...CLAUDE_REDIRECT_URIS],
        },
      },
    });
    expect(app.body).not.toHaveProperty("mfa_config");
    expect(app.lines.join(" ")).toContain(
      "https://claude.ai/api/mcp/auth_callback",
    );
  });

  it("allows only exact Claude redirect addresses: https, no wildcards", () => {
    for (const uri of CLAUDE_REDIRECT_URIS) {
      expect(uri.startsWith("https://")).toBe(true);
      expect(uri).not.toContain("*");
    }
  });

  it("the second application guards /status and /setup with a second factor, for the owner only", () => {
    const inputs = {
      ...base,
      level: "domain" as const,
      domains: ["example.org"],
    };
    const app = step<ApplicationStep>(inputs, "admin_app");
    expect(app.domain).toBe("engine.example.com/status");
    expect(app.secondFactor).toBe(true);
    expect(app.policy).toBe("admin_policy");
    expect(app.body).toMatchObject({
      destinations: [
        { type: "public", uri: "engine.example.com/status" },
        { type: "public", uri: "engine.example.com/setup" },
      ],
      mfa_config: { mfa_disabled: false },
    });
    expect(app.body).not.toHaveProperty("oauth_configuration");
    // Whatever the level, only the owner opens the admin pages.
    expect(step<PolicyStep>(inputs, "admin_policy").include).toEqual([
      { email: { email: "owner@example.com" } },
    ]);
  });

  it("writes the session length on each rule, matching its application: main 1 year by default, admin 12h", () => {
    const length = (id: string) =>
      step<ApplicationStep>(base, id).body["session_duration"];
    expect(step<PolicyStep>(base, "engine_policy").sessionDuration).toBe("8760h");
    expect(length("engine_app")).toBe("8760h");
    expect(step<PolicyStep>(base, "admin_policy").sessionDuration).toBe("12h");
    expect(length("admin_app")).toBe("12h");
    expect(step<ApplicationStep>(base, "admin_app").body["mfa_config"]).toMatchObject({ session_duration: "12h" });
    expect(step<ApplicationStep>(base, "engine_app").lines.join(" ")).toMatch(/sessions last 1 year/);
  });

  it("uses the chosen main sign-in length; the admin pages stay 12h with a second factor", () => {
    const month = { ...base, session: "720h" as const };
    expect(step<ApplicationStep>(month, "engine_app").body["session_duration"]).toBe("720h");
    expect(step<PolicyStep>(month, "engine_policy").sessionDuration).toBe("720h");
    expect(step<ApplicationStep>(month, "engine_app").lines.join(" ")).toMatch(/sessions last 30 days/);
    expect(step<ApplicationStep>(month, "admin_app").body["session_duration"]).toBe("12h");
    expect(step<ApplicationStep>(month, "admin_app").secondFactor).toBe(true);
  });

  it("sets the connector's OAuth approval to the same length as a sign-in (default 1 year)", () => {
    const grant = (inputs: typeof base) =>
      (step<ApplicationStep>(inputs, "engine_app").body["oauth_configuration"] as { grant: Record<string, string> }).grant;
    expect(grant(base)).toEqual({ access_token_lifetime: "15m", session_duration: "8760h" });
    expect(grant({ ...base, session: "720h" as const }).session_duration).toBe("720h");
    expect(grant({ ...base, session: "24h" as const }).session_duration).toBe("24h");
    expect(buildPlan(base).session).toBe("8760h");
    expect(step<ApplicationStep>(base, "engine_app").lines.join(" ")).toMatch(/connector re-approves every 1 year/);
  });

  it("says both lengths in one sentence, and never guesses an unrecorded one", () => {
    expect(sessionSentence("8760h")).toBe("You stay signed in for 1 year; Claude's connector re-approves every 1 year.");
    expect(sessionSentence("720h")).toBe("You stay signed in for 30 days; Claude's connector re-approves every 30 days.");
    expect(sessionSentence(undefined)).toMatch(/not recorded/);
    expect(sessionSentence("999h")).toMatch(/not recorded/);
  });

  it("takes over what is already there only when asked, and says which in words", () => {
    type Takeover = { replaceExisting: boolean; lines: string[] };
    const off = buildPlan(base);
    const on = buildPlan({ ...base, replaceExisting: true });
    for (const id of ["dns", "engine_app", "admin_app"]) {
      const a = off.steps.find((s) => s.id === id) as unknown as Takeover;
      const b = on.steps.find((s) => s.id === id) as unknown as Takeover;
      expect(a.replaceExisting).toBe(false);
      expect(b.replaceExisting).toBe(true);
      expect(a.lines.join(" ")).toMatch(/setup stops and changes nothing/);
      expect(b.lines.join(" ")).toMatch(/repointed here|taken over/);
    }
  });

  it("warns, for the company-domain level, that everyone at the domain gets in", () => {
    const inputs = {
      ...base,
      level: "domain" as const,
      domains: ["example.org"],
    };
    const lines = (i: SetupInputs) =>
      step<PolicyStep>(i, "engine_policy").lines.join(" ");
    expect(lines(inputs)).toMatch(
      /Anyone who can receive email at those domains/,
    );
    expect(lines(base)).not.toMatch(/Anyone who can receive email/);
  });

  it("gives every rule and application a different name", () => {
    const names = buildPlan(base)
      .steps.map((s) =>
        s.kind === "policy"
          ? s.name
          : s.kind === "application"
            ? s.body["name"]
            : null,
      )
      .filter(Boolean);
    expect(new Set(names).size).toBe(8);
  });

  it("lets only the timer path skip sign-in, and only through a bypass rule", () => {
    const plan = buildPlan(base);
    const policy = plan.steps.find((s) => s.id === "tick_policy");
    const app = plan.steps.find((s) => s.id === "tick_app");
    expect(policy).toMatchObject({ kind: "policy", decision: "bypass", include: [{ everyone: {} }] });
    expect(app).toMatchObject({
      kind: "application",
      policy: "tick_policy",
      domain: `${base.host}/internal/curator/tick`,
      secondFactor: false,
    });
    // No other rule is a bypass but the Fireflies webhook's, and no other application uses this rule.
    for (const s of plan.steps) {
      if (s.kind === "policy" && s.id !== "tick_policy" && s.id !== "hooks_policy") expect(s.decision ?? "allow").toBe("allow");
      if (s.kind === "application" && s.id !== "tick_app") expect(s.policy).not.toBe("tick_policy");
    }
  });

  it("lets Fireflies reach only its webhook path, through its own bypass rule", () => {
    const plan = buildPlan(base);
    const policy = plan.steps.find((s) => s.id === "hooks_policy");
    const app = plan.steps.find((s) => s.id === "hooks_app");
    expect(policy).toMatchObject({ kind: "policy", decision: "bypass", include: [{ everyone: {} }] });
    expect(app).toMatchObject({
      kind: "application",
      policy: "hooks_policy",
      domain: `${base.host}/hooks/fireflies`,
      secondFactor: false,
      body: { destinations: [{ type: "public", uri: `${base.host}/hooks/fireflies` }] },
    });
    // The path is narrow: not /hooks, not the host, and no other application uses the rule.
    for (const s of plan.steps) {
      if (s.kind === "application" && s.id !== "hooks_app") expect(s.policy).not.toBe("hooks_policy");
    }
    const hookPath = (app as { domain: string }).domain.slice(base.host.length);
    expect(hookPath).toBe("/hooks/fireflies");
  });

  it("every step says in words what it will do", () => {
    for (const s of buildPlan(base).steps) {
      expect(s.title.length).toBeGreaterThan(5);
      expect(s.lines.length).toBeGreaterThan(0);
    }
  });
});
