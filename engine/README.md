# engine/ — the service

The web service of an Engine. It serves the connector Claude talks to
(`/mcp`), the status page (`/status`), the one-time setup page (`/setup`) and
`/health`. It signs people in through Cloudflare Access and reads the
database only through functions that filter by who is asking.

How it fits with the rest: [`docs/architecture.md`](../docs/architecture.md).
Sign-in and the setup page: [`docs/security.md`](../docs/security.md).
Every environment variable: [`docs/configuration.md`](../docs/configuration.md).

The Supabase project is chosen by `SUPABASE_URL` and its keys; the schema
inside it by `KB_SCHEMA` (default `workspace`). Code reaches the database only
through `db()` in `src/db.ts`.

## Local run

```bash
cp .env.example .env
# fill in the required variables (see the comments in the file)
npm install
npm run dev          # tsx watch src/index.ts
```

Health check: `curl http://localhost:8080/health`

With no sign-in settings the service starts in setup mode: only `/health` and
`/setup` answer.

## Test

```bash
# Unit and schema tests (no database needed)
npm test

# The fail-closed suite, against a real database
REAL_DB=1 SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_JWT_SECRET=... \
  npx vitest run tests/access/fail-closed.test.ts
```

`python -m kbe verify --phases verification` runs the second form with the
values from the local env file.

## Build

```bash
npm run build        # tsc -> dist/
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
```

## Deploy

The service is deployed as part of the Engine's DigitalOcean app, by
`python -m kbe deploy render` and `python -m kbe deploy apply`. The template
is `deploy/do-app-spec.template.yaml`. See
[`docs/build-manual.md`](../docs/build-manual.md), chapters 11 to 13.

## Things that must stay as they are

Each of these fixed a failure in an MCP client's OAuth handshake. Do not
remove them.

1. **CORS before auth.** `cors()` runs before `requireAuth` on `/mcp`, so a
   401 carries `Access-Control-Allow-Origin`. Without it a browser client
   sees a CORS error instead of the sign-in challenge.
2. **`app.all('/mcp', ...)`, not `app.post`.** MCP uses GET for streams and
   DELETE to end a session, as well as POST.
3. **Body limit before auth.** The 64 KB limit on `/mcp` is applied before
   `requireAuth`, so a large unauthenticated request is refused cheaply.
4. **Client registration needs an allowed redirect address.** Cloudflare
   refuses a client whose redirect address is not on the Access
   application's allowed list. That is a Cloudflare setting, made by the
   setup page; it cannot be fixed in code.

## Request path

```
Claude
  └─ Cloudflare Access (one-time PIN, Managed OAuth)
       └─ Cf-Access-Jwt-Assertion header (verified identity)
            └─ /mcp (Hono + MCP SDK)
                 ├─ verify the assertion (keys from the Access team domain)
                 ├─ match it to a person (as the kb_engine database role)
                 ├─ search         -> documents_search_by_oauth_subject
                 ├─ get_document   -> document_get
                 ├─ who_knows      -> documents_search_by_oauth_subject
                 ├─ get_wiki_page  -> wiki_page_get
                 ├─ report_issue   -> issue_report
                 ├─ page tools     -> page_save, entity_find, entity_rows,
                 │                    page_related, pages_search_by_oauth_subject,
                 │                    source_item_record, source_item_get
                 └─ admin_*        -> two-step admin functions (administrators only)
```

Every database function is `SECURITY DEFINER` with explicit grants. The
`kb_engine` role has no direct table access.
