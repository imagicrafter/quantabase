import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression test for a first sign-in bug:
//
//   resolved_domain_count_for_oauth_subject used to
//   coalesce BOTH "unknown subject" and "known subject, zero grants" to 0. That
//   made resolvePrincipal's `if (domainCount !== null)` check treat an unknown
//   subject as if it existed, return early, and skip the TOFU bootstrap path —
//   so first login never worked.
//
//   Migration 0020 fixes the DB function to return NULL for unknown and an
//   integer (including 0) for known. This test proves resolvePrincipal reaches
//   the bootstrap path when the count is null, and does NOT when it is 0.

const rpcMock = vi.fn();

vi.mock("../../src/supabase.js", () => ({
  supabase: {
    schema: () => ({
      rpc: rpcMock,
    }),
  },
}));

describe("resolvePrincipal TOFU bootstrap", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("an unknown subject (count NULL) reaches the bootstrap-by-email path", async () => {
    const { resolvePrincipal } = await import("../../src/auth/principal.js");

    rpcMock.mockImplementation((fn: string) => {
      if (fn === "resolved_domain_count_for_oauth_subject") {
        // Unknown subject: DB returns null, not 0.
        return Promise.resolve({ data: null, error: null });
      }
      if (fn === "claim_oauth_subject") {
        return Promise.resolve({
          data: [
            {
              id: "p1",
              handle: "owner",
              display_name: "Pat",
              role: "administrator",
              active: true,
            },
          ],
          error: null,
        });
      }
      throw new Error(`unexpected rpc: ${fn}`);
    });

    const principal = await resolvePrincipal(
      "new_sub_never_seen",
      "owner@example.com",
    );

    expect(principal.sub).toBe("new_sub_never_seen");
    expect(principal.email).toBe("owner@example.com");
    expect(rpcMock).toHaveBeenCalledWith(
      "claim_oauth_subject",
      expect.objectContaining({ p_oauth_subject: "new_sub_never_seen" }),
    );
  });

  it("a known subject with zero grants (count 0) does NOT reach bootstrap", async () => {
    const { resolvePrincipal } = await import("../../src/auth/principal.js");

    rpcMock.mockImplementation((fn: string) => {
      if (fn === "resolved_domain_count_for_oauth_subject") {
        // Known subject, zero grants: DB returns 0, not null.
        return Promise.resolve({ data: 0, error: null });
      }
      throw new Error(`unexpected rpc: ${fn} — bootstrap must not run`);
    });

    const principal = await resolvePrincipal(
      "known_sub_zero_grants",
      "watch-embed@example.com",
    );

    expect(principal.sub).toBe("known_sub_zero_grants");
    expect(rpcMock).not.toHaveBeenCalledWith(
      "claim_oauth_subject",
      expect.anything(),
    );
  });

  it("an unknown subject with no matching email is rejected forbidden", async () => {
    const { resolvePrincipal } = await import("../../src/auth/principal.js");

    rpcMock.mockImplementation((fn: string) => {
      if (fn === "resolved_domain_count_for_oauth_subject") {
        return Promise.resolve({ data: null, error: null });
      }
      if (fn === "claim_oauth_subject") {
        // No principal matched this email — claim returns zero rows.
        return Promise.resolve({ data: [], error: null });
      }
      throw new Error(`unexpected rpc: ${fn}`);
    });

    await expect(
      resolvePrincipal("stranger_sub", "stranger@example.com"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
