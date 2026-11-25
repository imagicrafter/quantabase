-- 0021_grant_kb_engine_to_authenticator.sql
--
-- Grants the `authenticator` role (the role PostgREST connects to Postgres as)
-- membership in `kb_engine`, so PostgREST can actually perform the
-- `SET ROLE kb_engine` that a `{"role": "kb_engine"}` JWT requests.
--
-- BUG FOUND 2026-08-18 during the first real end-to-end test against production
-- (claude.ai -> Cloudflare Access -> engine -> Supabase): migration 0018 created
-- the `kb_engine` role and granted it EXECUTE on the OAuth-path functions, but
-- never granted `authenticator` membership in it. Without that membership,
-- PostgREST cannot switch into `kb_engine` for a request carrying the kb_engine
-- JWT — Postgres silently falls back, and every RPC call fails with
-- "permission denied for function ...", which surfaces in the engine as
-- "Database role misconfigured — kb_engine lacks execute" (principal.ts).
--
-- This is additive only: it does not change what `kb_engine` itself may do
-- (still six function grants, zero table grants — unaffected). It only allows
-- PostgREST to assume the role a correctly-signed kb_engine JWT already asks for.

grant kb_engine to authenticator;


-- ROLLBACK -------------------------------------------------------------------
-- revoke kb_engine from authenticator;
