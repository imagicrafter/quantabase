// Provide minimal stub env vars so src/env.ts does not throw during import in
// tests that only exercise schema validation and do not call real services.
// Tests that need real credentials (tests/access/fail-closed.test.ts) check for
// their own env vars and skip themselves when absent.
// These values must match what test requests send so the host check and auth
// middleware behave correctly. env.ts parses process.env once at import time;
// vi.stubEnv in beforeEach is too late to affect cached module constants.
process.env["SUPABASE_URL"] ??= "https://example.supabase.co";
process.env["SUPABASE_JWT_SECRET"] ??= "test-secret-at-least-32-chars-long!!";
process.env["SUPABASE_ANON_KEY"] ??=
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test";
process.env["EMBED_TOKEN"] ??= "test-embed-token";
process.env["CF_ACCESS_TEAM_DOMAIN"] ??= "https://test.cloudflareaccess.com";
process.env["CF_ACCESS_AUD"] ??= "test-aud-tag";
process.env["OAUTH_RESOURCE_URL"] ??= "https://engine.example.com/mcp";
process.env["EXPECTED_HOST"] ??= "engine.example.com";
// The setup page's one-time code. Routes under test take theirs by injection;
// this one is what the logger scrubs from every line.
process.env["SETUP_CODE"] ??= "env-setup-code-0123456789abcdef0123456789";
