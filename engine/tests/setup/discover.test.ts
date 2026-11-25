import { describe, it, expect } from "vitest";
import { createCloudflareClient } from "../../src/setup/cloudflare-client.js";
import { discover, SetupStepError } from "../../src/setup/discover.js";
import {
  createFakeCloudflare,
  GOOD_TOKEN,
  ZONE_ID,
  type FakeOptions,
} from "./fake-cloudflare.js";

const HOST = "engine.example.com";

function run(options: FakeOptions = {}) {
  const fake = createFakeCloudflare(options);
  const client = createCloudflareClient({
    token: GOOD_TOKEN,
    fetch: fake.fetch,
  });
  return { fake, found: discover(client, HOST) };
}

const verifyCalls = (requests: readonly { url: string }[]) =>
  requests
    .map((r) => new URL(r.url).pathname)
    .filter((p) => p.endsWith("/tokens/verify"));

describe("token verification (as seen on a live account)", () => {
  it("a token owned by the user is verified on the user route", async () => {
    const { found } = run();
    await expect(found).resolves.toMatchObject({ zoneId: ZONE_ID });
  });

  it("a 401 on the user route is not a bad token when the account route says active", async () => {
    const { fake, found } = run({ tokenOwner: "account" });
    await expect(found).resolves.toMatchObject({ zoneId: ZONE_ID });
    const calls = verifyCalls(fake.requests);
    expect(calls[0]).toBe("/client/v4/user/tokens/verify");
    expect(calls[1]).toMatch(/^\/client\/v4\/accounts\/[^/]+\/tokens\/verify$/);
  });

  it("a token the account route calls disabled is refused", async () => {
    const { found } = run({ tokenOwner: "account-disabled" });
    await expect(found).rejects.toThrow(/did not accept this token/);
  });
});

/** The error discover() threw, for a closer look. */
async function failure(options: FakeOptions): Promise<SetupStepError> {
  const { found } = run(options);
  const err = await found.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SetupStepError);
  return err as SetupStepError;
}

describe("which check failed, in words and in the details", () => {
  it("a token that cannot list zones names Zone Read (empty list)", async () => {
    const err = await failure({ zoneListEmpty: true });
    expect(err.message).toMatch(/Zone - Zone - Read/);
    expect(err.code).toBe("zone_not_found");
    expect(err.details.join("\n")).toMatch(/zones\?name=example\.com: no match/);
  });

  it("a token that is refused the zone list names Zone Read, with Cloudflare's code", async () => {
    const err = await failure({ denied: ["zone"] });
    expect(err.message).toMatch(/Zone - Zone - Read/);
    expect(err.details.join("\n")).toMatch(/403.*10000/);
  });

  it("an active token refused the zone with 9109 suggests the token's start date and Zone Read", async () => {
    // 2026-11-20 cold start: verify said active, every zone call said 403
    // [9109]; the token had a start date in the future.
    const err = await failure({ denied: ["zone"], deniedCode: 9109 });
    expect(err.message).toMatch(/start date/i);
    expect(err.message).toMatch(/Zone - Zone - Read/);
    expect(err.details.join("\n")).toMatch(/403.*9109/);
  });

  it("a plain 403 without 9109 does not talk about start dates", async () => {
    const err = await failure({ denied: ["zone"] });
    expect(err.message).not.toMatch(/start date/i);
  });

  it("a token neither verify route accepts lists both routes' answers", async () => {
    const err = await failure({ tokenOwner: "account-disabled" });
    expect(err.code).toBe("token_inactive");
    const details = err.details.join("\n");
    expect(details).toMatch(/user\/tokens\/verify: 401 \[1000\]/);
    expect(details).toMatch(/accounts\/\.\.\.\/tokens\/verify: status disabled/);
  });

  it("a missing permission names the area and the refused check", async () => {
    const err = await failure({ denied: ["organization"] });
    expect(err.code).toBe("missing_permission");
    expect(err.message).toMatch(/Access: Organizations/);
    expect(err.details.join("\n")).toMatch(/organizations: 403 \[10000\]/);
  });

  it("never puts the token in a message or a detail", async () => {
    for (const options of [
      { zoneListEmpty: true },
      { denied: ["zone" as const] },
      { tokenOwner: "account-disabled" as const },
      { denied: ["apps" as const] },
    ]) {
      const err = await failure(options);
      expect(err.message + err.details.join("")).not.toContain(GOOD_TOKEN);
    }
  });
});
