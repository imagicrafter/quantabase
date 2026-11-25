import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();

vi.mock("../../../src/supabase.js", () => ({
  supabase: { schema: () => ({ rpc: rpcMock }) },
}));

const { isAdministrator, clearAdminCache } =
  await import("../../../src/tools/admin/is-admin.js");

describe("isAdministrator (tool listing only)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    clearAdminCache();
  });

  it("is true only when the database says exactly true", async () => {
    rpcMock.mockResolvedValueOnce({ data: true, error: null });
    expect(await isAdministrator("a@example.com")).toBe(true);
    for (const data of [false, null, "true", 1, {}]) {
      clearAdminCache();
      rpcMock.mockResolvedValueOnce({ data, error: null });
      expect(await isAdministrator("a@example.com")).toBe(false);
    }
  });

  it("fails closed on a database error and does not remember it", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: "XX000" } });
    expect(await isAdministrator("a@example.com")).toBe(false);
    rpcMock.mockResolvedValueOnce({ data: true, error: null });
    expect(await isAdministrator("a@example.com")).toBe(true);
  });

  it("fails closed when the call throws", async () => {
    rpcMock.mockRejectedValueOnce(new Error("network down"));
    expect(await isAdministrator("a@example.com")).toBe(false);
  });

  it("remembers an answer for a minute, per email", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    expect(await isAdministrator("A@example.com", 1_000)).toBe(true);
    expect(await isAdministrator("a@example.com", 60_000)).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(1);

    rpcMock.mockResolvedValue({ data: false, error: null });
    expect(await isAdministrator("b@example.com", 2_000)).toBe(false);
    expect(await isAdministrator("a@example.com", 61_001)).toBe(false);
    expect(rpcMock).toHaveBeenCalledTimes(3);
  });
});
