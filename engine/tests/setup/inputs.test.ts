import { describe, it, expect } from "vitest";
import {
  MAX_DOMAINS,
  MAX_EMAILS,
  SIGNED_INPUTS_TTL_MS,
  isEmail,
  isHostname,
  isSharedDomain,
  openSignedInputs,
  parseSetupForm,
  signInputs,
  type SetupInputs,
} from "../../src/setup/inputs.js";

const CODE = "a-setup-code-that-is-long-and-random-0001";
const NOW = 1_800_000_000_000;

const form = (over: Record<string, unknown> = {}) => ({
  host: "engine.example.com",
  origin: "app-abc12.ondigitalocean.app",
  level: "owner",
  owner_email: "owner@example.com",
  emails: "",
  domains: "",
  ...over,
});

type Fixed = { owner: string | null; origin: string | null };
const FREE: Fixed = { owner: null, origin: null };

function good(over: Record<string, unknown> = {}, fixed: Fixed = FREE) {
  const parsed = parseSetupForm(form(over), fixed);
  if (!parsed.ok) throw new Error(parsed.errors.join(" | "));
  return parsed.inputs;
}

function bad(over: Record<string, unknown>, fixed: Fixed = FREE) {
  const parsed = parseSetupForm(form(over), fixed);
  expect(parsed.ok, JSON.stringify(over)).toBe(false);
  return parsed.ok ? [] : parsed.errors;
}

describe("hostnames and emails are checked strictly", () => {
  it.each(["engine.example.com", "a.b.c.example.org", "kb-1.example.io"])(
    "accepts the hostname %s",
    (h) => expect(isHostname(h)).toBe(true),
  );

  it.each([
    "localhost",
    "example",
    "https://engine.example.com",
    "engine.example.com/path",
    "engine.example.com:8080",
    "-bad.example.com",
    "bad-.example.com",
    "bad..example.com",
    "engine.example.c",
    "engine.example.123",
    "Engine.Example.com",
    "engine example.com",
    "engine.example.com.",
    "*.example.com",
    "exa_mple.com",
    `${"a".repeat(64)}.example.com`,
    `${"a.".repeat(130)}com`,
    "",
  ])("refuses the hostname %j", (h) => expect(isHostname(h)).toBe(false));

  it.each([
    "pat@example.com",
    "pat.lee+kb@mail.example.org",
    "p_1%x@example.io",
  ])("accepts the email %s", (e) => expect(isEmail(e)).toBe(true));

  it.each([
    "pat",
    "@example.com",
    "pat@",
    "pat@example",
    "pat@@example.com",
    "pat lee@example.com",
    ".pat@example.com",
    "pat.@example.com",
    "pa..t@example.com",
    "Pat@example.com",
    "pat@example.com>",
    '"pat"@example.com',
    "pat@example.com\nx-injected: 1",
    "pat@*.example.com",
    `${"a".repeat(65)}@example.com`,
  ])("refuses the email %j", (e) => expect(isEmail(e)).toBe(false));
});

describe("the form, level by level", () => {
  it("owner only: just the owner, no lists", () => {
    expect(good()).toEqual({
      host: "engine.example.com",
      origin: "app-abc12.ondigitalocean.app",
      level: "owner",
      ownerEmail: "owner@example.com",
      emails: [],
      domains: [],
      replaceExisting: false,
      session: "8760h",
    });
  });

  it("sign-in length: 1 year unless another offered length is chosen", () => {
    expect(good().session).toBe("8760h");
    expect(good({ session: "24h" }).session).toBe("24h");
    expect(good({ session: "720h" }).session).toBe("720h");
    expect(bad({ session: "99999h" }).join(" ")).toMatch(/sign-in length/i);
  });

  it("replaces what is already there only when the box is ticked", () => {
    expect(good({ replace: "yes" }).replaceExisting).toBe(true);
    for (const replace of ["", "no", "true", "on", ["yes", "no"], undefined]) {
      expect(good({ replace }).replaceExisting).toBe(false);
    }
  });

  it("lower-cases and trims what is typed", () => {
    const inputs = good({
      host: "  Engine.Example.COM ",
      owner_email: " Owner@Example.com ",
    });
    expect(inputs.host).toBe("engine.example.com");
    expect(inputs.ownerEmail).toBe("owner@example.com");
  });

  it("named people: a sorted list without repeats or the owner", () => {
    const inputs = good({
      level: "people",
      emails:
        "zed@example.com, Amy@example.com\nowner@example.com; amy@example.com",
    });
    expect(inputs.emails).toEqual(["amy@example.com", "zed@example.com"]);
    expect(inputs.domains).toEqual([]);
  });

  it("named people needs at least one other person", () => {
    expect(bad({ level: "people", emails: "" }).join()).toMatch(/at least one/);
    expect(
      bad({ level: "people", emails: "owner@example.com" }).join(),
    ).toMatch(/at least one/);
  });

  it("company domain: a list of domains", () => {
    const inputs = good({
      level: "domain",
      domains: "Example.org\nexample.com",
    });
    expect(inputs.domains).toEqual(["example.com", "example.org"]);
    expect(inputs.emails).toEqual([]);
  });

  it("company domain needs a domain, and refuses public email providers", () => {
    expect(bad({ level: "domain" }).join()).toMatch(/at least one/);
    expect(bad({ level: "domain", domains: "gmail.com" }).join()).toMatch(
      /public email provider/,
    );
    expect(
      bad({ level: "domain", domains: "example.com outlook.com" }).join(),
    ).toMatch(/public email provider/);
  });

  it.each([
    "hotmail.co.uk",
    "outlook.de",
    "yahoo.co.jp",
    "gmail.co",
    "protonmail.ch",
    "qq.com",
    "163.com",
    "mail.ru",
    "tuta.io",
    "co.uk",
    "com.au",
    "github.io",
    "ondigitalocean.app",
    "cloudflareaccess.com",
  ])("refuses %s as a company domain", (domain) => {
    expect(isSharedDomain(domain)).toBe(true);
    expect(bad({ level: "domain", domains: domain }).length).toBeGreaterThan(0);
  });

  it.each([
    "example.com",
    "example.co.uk",
    "mail.example.com",
    "live.example.org",
    "yahoo-fans.example.com",
  ])("accepts %s as a company domain", (domain) => {
    expect(isSharedDomain(domain)).toBe(false);
    expect(good({ level: "domain", domains: domain }).domains).toEqual([
      domain,
    ]);
  });

  it("ignores the lists of a level that was not chosen", () => {
    const inputs = good({
      level: "owner",
      emails: "x@example.com",
      domains: "example.org",
    });
    expect(inputs.emails).toEqual([]);
    expect(inputs.domains).toEqual([]);
  });

  it("caps the lists", () => {
    const many = Array.from(
      { length: MAX_EMAILS + 1 },
      (_, i) => `p${i}@example.com`,
    );
    expect(bad({ level: "people", emails: many.join("\n") }).join()).toMatch(
      /at most/,
    );
    const domains = Array.from(
      { length: MAX_DOMAINS + 1 },
      (_, i) => `d${i}.example.com`,
    );
    expect(
      bad({ level: "domain", domains: domains.join("\n") }).join(),
    ).toMatch(/at most/);
  });

  it("refuses bad values without repeating them back", () => {
    const errors = bad({
      level: "people",
      emails: "ok@example.com <script>alert(1)</script>@example.com",
    });
    expect(errors.join()).toMatch(/not valid/);
    expect(errors.join()).not.toContain("script");
  });

  it.each([
    { host: "not a host" },
    { host: "" },
    { origin: "https://app.example.net" },
    { level: "everyone" },
    { level: "" },
    { owner_email: "nope" },
    { host: "same.example.com", origin: "same.example.com" },
    { host: ["engine.example.com", "evil.example.com"] },
  ])("refuses %j", (over) => {
    expect(bad(over).length).toBeGreaterThan(0);
  });

  it("uses the config's owner and ignores the form's", () => {
    const inputs = good(
      { owner_email: "intruder@example.net" },
      { owner: "Real.Owner@example.com", origin: null },
    );
    expect(inputs.ownerEmail).toBe("real.owner@example.com");
  });

  it("uses the address the page was reached on and ignores the form's", () => {
    const fixed = { owner: null, origin: "App-Real1.ondigitalocean.app" };
    const inputs = good({ origin: "attacker.example.net" }, fixed);
    expect(inputs.origin).toBe("app-real1.ondigitalocean.app");
    // An unusable address is an error; the form's value is never a fallback.
    for (const origin of ["", "localhost", "127.0.0.1", "bad host"]) {
      const errors = bad(
        { origin: "attacker.example.net" },
        { owner: null, origin },
      );
      expect(errors.join()).toMatch(/own address is not valid/);
    }
  });
});

describe("signed inputs", () => {
  const inputs: SetupInputs = good({
    level: "people",
    emails: "amy@example.com",
  });

  it("open again unchanged", () => {
    const signed = signInputs(inputs, CODE, NOW);
    expect(
      openSignedInputs(signed.payload, signed.signature, CODE, NOW + 1000),
    ).toEqual({
      ok: true,
      inputs,
    });
  });

  it("carry neither the setup code nor anything derived from it in the clear", () => {
    const signed = signInputs(inputs, CODE, NOW);
    const clear = Buffer.from(signed.payload, "base64url").toString("utf8");
    expect(clear).not.toContain(CODE);
    expect(signed.signature).not.toContain(CODE);
  });

  it("are refused when a single character of the payload changes", () => {
    const signed = signInputs(inputs, CODE, NOW);
    const altered = JSON.parse(
      Buffer.from(signed.payload, "base64url").toString("utf8"),
    );
    altered.inputs.emails = ["attacker@example.net"];
    const payload = Buffer.from(JSON.stringify(altered)).toString("base64url");
    expect(openSignedInputs(payload, signed.signature, CODE, NOW)).toEqual({
      ok: false,
      reason: "tampered",
    });
  });

  it("are refused with a wrong, missing or malformed signature", () => {
    const signed = signInputs(inputs, CODE, NOW);
    const flipped =
      (signed.signature[0] === "0" ? "1" : "0") + signed.signature.slice(1);
    for (const sig of [
      flipped,
      "",
      "zz",
      signed.signature.slice(2),
      undefined,
      5,
      ["x"],
    ]) {
      expect(openSignedInputs(signed.payload, sig, CODE, NOW).ok).toBe(false);
    }
    expect(openSignedInputs(undefined, signed.signature, CODE, NOW).ok).toBe(
      false,
    );
    expect(openSignedInputs("", signed.signature, CODE, NOW).ok).toBe(false);
  });

  it("are refused when signed with another setup code", () => {
    const signed = signInputs(
      inputs,
      "some-other-setup-code-0123456789abcdef",
      NOW,
    );
    expect(
      openSignedInputs(signed.payload, signed.signature, CODE, NOW).ok,
    ).toBe(false);
  });

  it("expire", () => {
    const signed = signInputs(inputs, CODE, NOW);
    expect(
      openSignedInputs(
        signed.payload,
        signed.signature,
        CODE,
        NOW + SIGNED_INPUTS_TTL_MS + 1,
      ),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("are validated again after the signature checks out", () => {
    // Correctly signed, but holding values the form would never have let through.
    const signed = signInputs(
      {
        ...inputs,
        host: "evil.example.net/path",
        domains: ["gmail.com"],
      } as SetupInputs,
      CODE,
      NOW,
    );
    expect(
      openSignedInputs(signed.payload, signed.signature, CODE, NOW),
    ).toEqual({
      ok: false,
      reason: "tampered",
    });
  });
});
