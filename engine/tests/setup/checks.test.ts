import { describe, it, expect } from "vitest";
import { applyPlan } from "../../src/setup/apply.js";
import { resultPage } from "../../src/setup/page-plan.js";
import { readBack, type Check } from "../../src/setup/checks.js";
import {
  createCloudflareClient,
  type CloudflareClient,
} from "../../src/setup/cloudflare-client.js";
import type { SetupInputs } from "../../src/setup/inputs.js";
import { buildPlan, CLAUDE_REDIRECT_URIS } from "../../src/setup/plan.js";
import { createFakeCloudflare, GOOD_TOKEN } from "./fake-cloudflare.js";

// After a successful setup the app reads the two applications back and says
// which of the settings that most often need a manual click are not in place.
// Reads only: these tests also prove no write is made for it.

const INPUTS: SetupInputs = {
  host: "engine.example.com",
  origin: "app-abc12.ondigitalocean.app",
  level: "owner",
  ownerEmail: "owner@example.com",
  emails: [],
  domains: [],
  replaceExisting: false,
};
const PLAN = buildPlan(INPUTS);
const ACCOUNT = "0".repeat(32);

type Obj = Record<string, unknown>;

const ENGINE_APP: Obj = {
  type: "self_hosted",
  domain: "engine.example.com",
  oauth_configuration: {
    enabled: true,
    dynamic_client_registration: {
      enabled: true,
      allowed_uris: [...CLAUDE_REDIRECT_URIS],
    },
  },
};
const ADMIN_APP: Obj = {
  type: "self_hosted",
  domain: "engine.example.com/status",
  mfa_config: { mfa_disabled: false, allowed_authenticators: ["totp"] },
};

function stub(apps: readonly Obj[] | Error) {
  const calls: string[] = [];
  const refuse = async () => {
    calls.push("write");
    throw new Error("a check must not write");
  };
  const client: CloudflareClient = {
    get: async () => {
      calls.push("get");
      return {};
    },
    list: async (path) => {
      calls.push("list " + path.join("/"));
      if (apps instanceof Error) throw apps;
      return [...apps];
    },
    send: refuse,
  };
  return { client, calls };
}

const states = (checks: readonly Check[]) =>
  Object.fromEntries(checks.map((c) => [c.id, c.state]));

describe("the read-back after setup", () => {
  it("finds everything in place after a real run, and writes nothing for it", async () => {
    const fake = createFakeCloudflare();
    const client = createCloudflareClient({
      token: GOOD_TOKEN,
      fetch: fake.fetch,
    });
    const report = await applyPlan(PLAN, client);
    expect(report.access).not.toBeNull();
    expect(states(report.checks ?? [])).toEqual({
      managed_oauth: "ok",
      claude_redirects: "ok",
      second_factor: "ok",
    });
    const writes = fake.writes().length;
    await readBack(client, fake.state.apps[0] ? accountOf(fake) : "", PLAN);
    expect(fake.writes()).toHaveLength(writes);
  });

  it("is not run when a step failed", async () => {
    const fake = createFakeCloudflare();
    fake.failOn({ method: "POST", path: /dns_records$/, status: 500 });
    const client = createCloudflareClient({
      token: GOOD_TOKEN,
      fetch: fake.fetch,
    });
    const report = await applyPlan(PLAN, client);
    expect(report.access).toBeNull();
    expect(report.checks ?? []).toEqual([]);
  });

  it("makes one list call and no write", async () => {
    const { client, calls } = stub([ENGINE_APP, ADMIN_APP]);
    const checks = await readBack(client, ACCOUNT, PLAN);
    expect(calls).toEqual([`list accounts/${ACCOUNT}/access/apps`]);
    expect(checks.every((c) => c.state === "ok")).toBe(true);
  });

  it("names Managed OAuth when it is off, with where to click", async () => {
    const off = { ...ENGINE_APP, oauth_configuration: { enabled: false } };
    const checks = await readBack(stub([off, ADMIN_APP]).client, ACCOUNT, PLAN);
    expect(states(checks)["managed_oauth"]).toBe("missing");
    const fix = checks.find((c) => c.id === "managed_oauth")?.fix ?? "";
    expect(fix).toContain("KB Engine: engine.example.com");
    expect(fix).toMatch(/Zero Trust, Access controls, Applications/);
    expect(fix).toMatch(/Managed OAuth/);
  });

  it("names a missing Claude redirect address", async () => {
    const one = {
      ...ENGINE_APP,
      oauth_configuration: {
        enabled: true,
        dynamic_client_registration: {
          enabled: true,
          allowed_uris: [CLAUDE_REDIRECT_URIS[0]],
        },
      },
    };
    const checks = await readBack(stub([one, ADMIN_APP]).client, ACCOUNT, PLAN);
    expect(states(checks)).toMatchObject({
      managed_oauth: "ok",
      claude_redirects: "missing",
    });
    const fix = checks.find((c) => c.id === "claude_redirects")?.fix ?? "";
    expect(fix).toContain(CLAUDE_REDIRECT_URIS[1]);
    expect(fix).not.toContain(CLAUDE_REDIRECT_URIS[0]);
    expect(fix).toMatch(/Allowed redirect URIs/);
  });

  it("names the second factor when the admin application does not ask for one", async () => {
    for (const mfa of [
      undefined,
      { mfa_disabled: true, allowed_authenticators: ["totp"] },
      { mfa_disabled: false, allowed_authenticators: [] },
    ]) {
      const admin = { ...ADMIN_APP, mfa_config: mfa };
      const checks = await readBack(
        stub([ENGINE_APP, admin]).client,
        ACCOUNT,
        PLAN,
      );
      expect(states(checks)["second_factor"]).toBe("missing");
      expect(checks.find((c) => c.id === "second_factor")?.fix).toContain(
        "KB Engine admin pages: engine.example.com",
      );
    }
  });

  it("says it could not check, and does not throw, when the read fails", async () => {
    const secret = "token-like-text-in-an-error";
    const checks = await readBack(
      stub(new Error(secret)).client,
      ACCOUNT,
      PLAN,
    );
    expect(checks.map((c) => c.state)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
    expect(JSON.stringify(checks)).not.toContain(secret);
  });

  it("counts an application it cannot find as missing", async () => {
    const checks = await readBack(stub([]).client, ACCOUNT, PLAN);
    expect(checks.every((c) => c.state === "missing")).toBe(true);
  });
});

describe("the result page", () => {
  const check = (state: Check["state"]): Check => ({
    id: "managed_oauth",
    state,
    title: "Managed OAuth <on>",
    fix: "Click here & there.",
  });

  it("shows what is not in place, escaped, and nothing when all is well", () => {
    const page = (checks: Check[]) =>
      resultPage(
        { steps: [], warnings: [], checks },
        true,
        "https://e/mcp",
        "v",
      );
    expect(page([check("ok")])).not.toContain("Needs a click in Cloudflare");
    const missing = page([check("missing")]);
    expect(missing).toContain("Needs a click in Cloudflare");
    expect(missing).toContain("Managed OAuth &lt;on&gt;");
    expect(missing).toContain("Click here &amp; there.");
    expect(page([check("unknown")])).toContain("Could not be checked");
  });
});

function accountOf(fake: ReturnType<typeof createFakeCloudflare>): string {
  const seen = fake.requests
    .map((r) => /accounts\/([a-f0-9]{32})\//.exec(r.url)?.[1])
    .find((id) => id);
  return seen ?? "";
}
