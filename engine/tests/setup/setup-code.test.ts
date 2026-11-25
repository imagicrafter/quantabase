import { describe, it, expect } from "vitest";
import {
  constantTimeEqual,
  parseLockState,
  verifySetupCode,
  type SetupCodeDeps,
} from "../../src/setup/setup-code.js";
import { createFakeDb } from "./fake-db.js";

const CODE = "a-setup-code-that-is-long-and-random-0001";
const MINUTE = 60_000;

function setup(
  expected: string | undefined | null = CODE,
  dbCode: string | null = CODE,
) {
  const clock = { now: 1_800_000_000_000 };
  const db = createFakeDb(dbCode, clock);
  const deps: SetupCodeDeps = {
    expected: expected ?? undefined,
    attemptCheck: db.attemptCheck,
    attemptFail: db.attemptFail,
    codeValid: db.codeValid,
  };
  return { clock, db, deps };
}

describe("the setup code", () => {
  it("accepts the right code, and spends nothing", async () => {
    const { deps, db } = setup();
    expect(await verifySetupCode(deps, CODE)).toEqual({ ok: true });
    expect(await verifySetupCode(deps, `  ${CODE}\n`)).toEqual({ ok: true });
    expect(db.calls.fail).toBe(0);
    expect(db.row.setup_state).toBe("open");
  });

  it.each([
    "wrong",
    "",
    "   ",
    undefined,
    null,
    42,
    ["a"],
    CODE.slice(0, -1),
    `${CODE}x`,
    CODE.toUpperCase(),
    "x".repeat(100_000),
  ])("refuses %j and counts it", async (given) => {
    const { deps, db } = setup();
    expect(await verifySetupCode(deps, given)).toMatchObject({
      ok: false,
      reason: "wrong",
    });
    expect(db.calls.fail).toBe(1);
    expect(db.calls.valid).toBe(0);
  });

  it("refuses everything when the app has no setup code", async () => {
    const { deps, db } = setup(null);
    expect(await verifySetupCode(deps, CODE)).toMatchObject({
      ok: false,
      reason: "not_configured",
    });
    expect(await verifySetupCode(deps, "")).toMatchObject({
      reason: "not_configured",
    });
    expect(db.calls.check + db.calls.fail + db.calls.valid).toBe(0);
  });

  it("locks after the fifth wrong code in 15 minutes, for an hour", async () => {
    const { deps, clock } = setup();
    for (let i = 0; i < 4; i += 1) {
      expect(await verifySetupCode(deps, "nope")).toMatchObject({
        reason: "wrong",
      });
      clock.now += MINUTE;
    }
    const fifth = await verifySetupCode(deps, "nope");
    expect(fifth).toMatchObject({ ok: false, reason: "locked" });
    expect(fifth.ok ? 0 : fifth.retryAfterSeconds).toBe(3600);

    // While locked, the right code is refused too, without being looked at.
    expect(await verifySetupCode(deps, CODE)).toMatchObject({
      reason: "locked",
    });
    clock.now += 59 * MINUTE;
    expect(await verifySetupCode(deps, CODE)).toMatchObject({
      reason: "locked",
    });
  });

  it("unlocks by itself after the hour, and counts from zero again", async () => {
    const { deps, clock } = setup();
    for (let i = 0; i < 5; i += 1) await verifySetupCode(deps, "nope");
    clock.now += 60 * MINUTE + 1;
    expect(await verifySetupCode(deps, CODE)).toEqual({ ok: true });
    for (let i = 0; i < 4; i += 1) {
      expect(await verifySetupCode(deps, "nope")).toMatchObject({
        reason: "wrong",
      });
    }
    expect(await verifySetupCode(deps, CODE)).toEqual({ ok: true });
  });

  it("does not lock when the wrong codes are spread out", async () => {
    const { deps, clock } = setup();
    for (let i = 0; i < 12; i += 1) {
      expect(await verifySetupCode(deps, "nope")).toMatchObject({
        reason: "wrong",
      });
      clock.now += 4 * MINUTE;
    }
    expect(await verifySetupCode(deps, CODE)).toEqual({ ok: true });
  });

  it("holds the limit against a burst of requests sent at once", async () => {
    const { deps, db } = setup();
    const burst = await Promise.all(
      Array.from({ length: 40 }, (_, i) => verifySetupCode(deps, `guess-${i}`)),
    );
    expect(burst.filter((r) => !r.ok && r.reason === "wrong")).toHaveLength(4);
    expect(burst.filter((r) => !r.ok && r.reason === "locked")).toHaveLength(
      36,
    );
    expect(db.calls.fail).toBe(5);
  });

  it("says 'closed' when the database holds another code or the window is shut", async () => {
    const other = setup(CODE, "the-database-holds-a-different-code-000001");
    expect(await verifySetupCode(other.deps, CODE)).toMatchObject({
      reason: "closed",
    });

    const shut = setup();
    shut.db.row.setup_state = "complete";
    expect(await verifySetupCode(shut.deps, CODE)).toMatchObject({
      reason: "closed",
    });

    const none = setup(CODE, null);
    expect(await verifySetupCode(none.deps, CODE)).toMatchObject({
      reason: "closed",
    });
  });

  it("fails closed when the database cannot be asked", async () => {
    const { deps } = setup();
    const down = () => Promise.reject(new Error("database down"));
    await expect(
      verifySetupCode({ ...deps, attemptCheck: down }, CODE),
    ).rejects.toThrow();
    await expect(
      verifySetupCode({ ...deps, attemptFail: down }, "nope"),
    ).rejects.toThrow();
    await expect(
      verifySetupCode({ ...deps, codeValid: down }, CODE),
    ).rejects.toThrow();
    // ...and a failure does not jam the queue for the next request.
    expect(await verifySetupCode(deps, CODE)).toEqual({ ok: true });
  });

  it("rejects a lock state it cannot read", () => {
    expect(() => parseLockState(null)).toThrow();
    expect(() => parseLockState({ locked: "no" })).toThrow();
    expect(() =>
      parseLockState({ locked: false, retry_after_seconds: -1 }),
    ).toThrow();
    expect(
      parseLockState({ locked: false, retry_after_seconds: 0, failures: 2 }),
    ).toEqual({
      locked: false,
      retry_after_seconds: 0,
    });
  });

  it("compares in constant time, on digests of equal length", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("", "abc")).toBe(false);
    expect(constantTimeEqual("a".repeat(5000), "abc")).toBe(false);
  });
});
