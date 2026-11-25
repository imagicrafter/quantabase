import { describe, expect, it, vi } from "vitest";

const schemaMock = vi.hoisted(() => vi.fn(() => ({ rpc: vi.fn() })));

vi.mock("../src/supabase.js", () => ({
  supabase: { schema: schemaMock },
}));

describe("db()", () => {
  it("scopes the client to the configured schema", async () => {
    const { db } = await import("../src/db.js");
    const { env } = await import("../src/env.js");
    db();
    expect(schemaMock).toHaveBeenCalledWith(env.KB_SCHEMA);
    expect(env.KB_SCHEMA).toBe("workspace");
  });
});
