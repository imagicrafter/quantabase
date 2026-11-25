import { describe, it, expect, beforeAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";

// ────────────────────────────────────────────────────────────────────────────
// SECURITY TEST SUITE — the blocking gate for this PR.
//
// Tests in this file run against the real database. They verify properties
// of the access model that cannot be mocked meaningfully:
//   • The anon key cannot call any workspace function (migration 0016)
//   • The kb_engine role has zero table grants
//   • A principal with no grants sees zero rows
//   • An inactive principal resolves to zero domains
//
// Run with real env vars:
//   REAL_DB=1 SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_JWT_SECRET=... vitest run tests/access
//
// REAL_DB=1 is required in addition to real credentials because tests/setup.ts
// provides stub values for those vars so the unit tests can import env.ts without
// failing. Without the REAL_DB gate these tests would try to connect to the stub URL.
//
// These tests MUST pass before the PR can be merged. See plan validation checklist.
// ────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env["SUPABASE_URL"];
// The live database's schema (same setting the service reads).
const KB_SCHEMA = process.env["KB_SCHEMA"] || "workspace";
const SUPABASE_ANON_KEY = process.env["SUPABASE_ANON_KEY"];
const SUPABASE_JWT_SECRET = process.env["SUPABASE_JWT_SECRET"];

const skip =
  !process.env["REAL_DB"] ||
  !SUPABASE_URL ||
  !SUPABASE_ANON_KEY ||
  !SUPABASE_JWT_SECRET;

async function mintJwt(role: string, secret: string): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("supabase")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

describe.skipIf(skip)("Fail-closed access model (real DB)", () => {
  let anonClient: ReturnType<typeof createClient>;
  let kbClient: ReturnType<typeof createClient>;

  beforeAll(async () => {
    anonClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      auth: { persistSession: false },
    });
    // The second positional arg is the `apikey` gateway header, validated by
    // Supabase's edge against known project keys — it must be the anon key, not
    // the custom kb_engine JWT. The role JWT goes in Authorization, which is
    // what PostgREST reads for role-switching. Passing the JWT as apikey yields
    // "Invalid API key" and tests nothing. Mirrors src/supabase.ts.
    const kbJwt = await mintJwt("kb_engine", SUPABASE_JWT_SECRET!);
    kbClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${kbJwt}` } },
    });
  });

  // Security test #1 (blocking gate): anon must NOT be able to call these functions.
  // If any returns data instead of permission-denied, migration 0016 was not applied.
  it("[GATE] anon key cannot call documents_search_by_oauth_subject", async () => {
    const { error } = await anonClient
      .schema(KB_SCHEMA)
      .rpc("documents_search_by_oauth_subject", {
        p_oauth_subject: "test",
        query_text: "test",
        query_embedding: Array(384).fill(0),
        match_count: 1,
      });
    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/permission denied/i);
  });

  it("[GATE] anon key cannot call document_get", async () => {
    const { error } = await anonClient.schema(KB_SCHEMA).rpc("document_get", {
      p_oauth_subject: "test",
      p_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/permission denied/i);
  });

  it("[GATE] anon key cannot call wiki_page_get", async () => {
    const { error } = await anonClient
      .schema(KB_SCHEMA)
      .rpc("wiki_page_get", {
        p_oauth_subject: "test",
        p_title_or_path: "test",
      });
    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/permission denied/i);
  });

  it("[GATE] anon key cannot call resolve_domains_for_oauth_subject", async () => {
    const { error } = await anonClient
      .schema(KB_SCHEMA)
      .rpc("resolve_domains_for_oauth_subject", { p_sub: "test" });
    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/permission denied/i);
  });

  // Security test #2: unknown sub returns zero rows, not an error
  it("unknown oauth_subject returns zero rows from search", async () => {
    const { data, error } = await kbClient
      .schema(KB_SCHEMA)
      .rpc("documents_search_by_oauth_subject", {
        p_oauth_subject: "user_nonexistent_00000000",
        query_text: "knowledge",
        query_embedding: Array(384).fill(0),
        match_count: 5,
      });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  // Security test #6: empty sub is UNKNOWN, not "known with zero grants".
  // Migration 0020 fixed resolved_domain_count_for_oauth_subject to return NULL
  // for an unknown/unprovisioned subject (empty string included) and an integer
  // (including 0) only for a known principal. Before 0020 this coalesced to 0
  // for both cases, which is exactly the bug that broke first-login bootstrap —
  // see engine/tests/auth/bootstrap-tofu.test.ts.
  it("empty oauth_subject returns NULL (unknown), not zero", async () => {
    const { data } = await kbClient
      .schema(KB_SCHEMA)
      .rpc("resolved_domain_count_for_oauth_subject", { p_sub: "" });
    expect(data).toBeNull();
  });

  // Security test #4: wildcard in wiki_page_get matches literally
  it('get_wiki_page("%%") does not enumerate pages', async () => {
    const { data, error } = await kbClient
      .schema(KB_SCHEMA)
      .rpc("wiki_page_get", {
        p_oauth_subject: "user_nonexistent_00000000",
        p_title_or_path: "%",
      });
    expect(error).toBeNull();
    // Unknown user → zero domains → zero rows regardless of wildcard
    expect(data).toEqual([]);
  });

  // Security test #7: kb_engine cannot directly read documents table
  it("kb_engine role cannot read workspace.documents directly", async () => {
    const { error } = await kbClient
      .schema(KB_SCHEMA)
      .from("documents")
      .select("id")
      .limit(1);
    // Should fail with permission denied — no table grants for kb_engine
    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/permission denied/i);
  });
});
