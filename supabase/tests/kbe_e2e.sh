#!/usr/bin/env bash
# End-to-end check of the `kbe` CLI against a throwaway local Postgres that
# has the Supabase roles (the same image apply_local.sh uses):
#
#   0. snapshot                 what is in `workspace` and `public` before
#   1. kbe db migrate           from empty: 0000 through the latest
#   2. every *_test.sql         in this folder, renamed for the schema
#   3. kbe config apply         config/engine.example.yaml --yes
#   4. topics and the owner administrator exist
#   5. kbe db migrate again     must be a no-op
#   6. kbe config apply again   must report no changes
#   7. kbe db adopt             must refuse (migrations are already recorded)
#   8. kbe verify               the phases that need only a database
#   8a. kbe access init/reopen  the setup code is stored as its hash only
#   8b. kbe access adopt        hand-made sign-in settings complete setup
#   8c. kbe people              add and grant, each needing a yes
#   8c4. kbe pages import       dry run saves nothing; apply files pages once
#   8c5. --from-backup          the backup fixture restores each owner's pages and links
#   8d. kbe support             the login reads the inbox and nothing else
#   9. another schema           migrate must refuse this database
#  10. nothing outside          (non-default schema only) the migrations left
#                               nothing in `workspace` or `public`
#
#   supabase/tests/kbe_e2e.sh                     # default schema (workspace)
#   KB_SCHEMA=kb_acme supabase/tests/kbe_e2e.sh   # the same flow, another schema
#   KEEP=1 supabase/tests/kbe_e2e.sh              # leave the container running
#   PYTHON=/path/to/python supabase/tests/kbe_e2e.sh
#
# both_schemas.sh runs it once for each. Needs Docker, psql and Python with
# pullers/requirements.txt installed. Touches nothing but its own container
# and a temp folder.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
IMAGE="${KB_TEST_PG_IMAGE:-public.ecr.aws/supabase/postgres:15.8.1.085}"
NAME="${KB_TEST_PG_NAME:-kb-engine-kbe-e2e}"
PYTHON="${PYTHON:-python3}"
DEFAULT_SCHEMA="workspace"
SCHEMA="${KB_SCHEMA:-$DEFAULT_SCHEMA}"
LOCAL_PW="local-only-$(date +%s)"
WORK="$(mktemp -d)"
LOCAL_FILE="$WORK/local.env"
OTHER_FILE="$WORK/other.env"
# The CLI must take the schema from the local file, as a deployment does.
unset KB_SCHEMA

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    docker stop "$NAME" >/dev/null 2>&1 || true
    docker container rm "$NAME" >/dev/null 2>&1 || true
  fi
  for leftover in "$LOCAL_FILE" "$OTHER_FILE" "$WORK/state.json" "$WORK/out.txt" \
    "$WORK/code2.txt" "$WORK/support.txt" "$WORK/token.txt" \
    "$WORK/vault/people/Sam Reader.md" "$WORK/vault/concepts/Idea.md"; do
    [ -f "$leftover" ] && rm "$leftover"
  done
  rmdir "$WORK/vault/people" "$WORK/vault/concepts" "$WORK/vault" 2>/dev/null || true
  rmdir "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "FAILED: $*" >&2
  exit 1
}

echo "== schema: $SCHEMA"
docker container rm --force "$NAME" >/dev/null 2>&1 || true
docker run --detach --name "$NAME" -e POSTGRES_PASSWORD="$LOCAL_PW" \
  --publish 127.0.0.1::5432 "$IMAGE" >/dev/null

admin_psql() {
  docker exec -i -e PGPASSWORD="$LOCAL_PW" "$NAME" \
    psql --quiet --no-psqlrc -v ON_ERROR_STOP=1 -h 127.0.0.1 -U supabase_admin -d postgres "$@"
}
admin_sql() { admin_psql --tuples-only --no-align "$@"; }

for _ in $(seq 1 60); do
  if admin_sql -c "select 1 from pg_roles where rolname = 'authenticator'" 2>/dev/null | grep -q 1; then
    break
  fi
  sleep 1
done

PORT="$(docker port "$NAME" 5432/tcp | head -n 1 | sed 's/.*://')"
[ -n "$PORT" ] || fail "could not find the container's port"

# The CLI reads the database URL and the schema from a local file, never from
# its arguments. The default deployment sets no schema at all.
umask 077
printf 'KBE_DATABASE_URL=postgresql://postgres:%s@127.0.0.1:%s/postgres\n' \
  "$LOCAL_PW" "$PORT" > "$LOCAL_FILE"
if [ "$SCHEMA" != "$DEFAULT_SCHEMA" ]; then
  printf 'KB_SCHEMA=%s\n' "$SCHEMA" >> "$LOCAL_FILE"
fi
printf 'KBE_DATABASE_URL=postgresql://postgres:%s@127.0.0.1:%s/postgres\nKB_SCHEMA=kb_some_other\n' \
  "$LOCAL_PW" "$PORT" > "$OTHER_FILE"

kbe_with() {
  local file="$1"
  shift
  (cd "$ROOT" && PYTHONPATH="$ROOT/scripts:$ROOT" KBE_STATE_FILE="$WORK/state.json" \
    "$PYTHON" -m kbe --env-file "$file" "$@")
}
kbe() { kbe_with "$LOCAL_FILE" "$@"; }

# Everything in `workspace` and `public` that is not part of an extension
# (pgvector lives in `public`; its own objects are not the Engine's).
outside() {
  admin_sql <<'SQL'
select coalesce(string_agg(item, E'\n' order by item), '') from (
  select 'schema ' || nspname as item from pg_namespace where nspname = 'workspace'
  union all
  select 'relation ' || n.nspname || '.' || c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('workspace', 'public')
     and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass
                      and d.objid = c.oid and d.deptype = 'e')
  union all
  select 'function ' || n.nspname || '.' || p.proname || '('
         || pg_get_function_identity_arguments(p.oid) || ')'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('workspace', 'public')
     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
                      and d.objid = p.oid and d.deptype = 'e')
  union all
  select 'type ' || n.nspname || '.' || t.typname
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
   where n.nspname in ('workspace', 'public')
     -- an extension's type, or the array type Postgres makes for it
     and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass
                      and d.objid in (t.oid, t.typelem) and d.deptype = 'e')
) found;
SQL
}

nothing_outside() {
  [ "$SCHEMA" != "$DEFAULT_SCHEMA" ] || return 0
  local now
  now="$(outside)"
  if [ "$now" != "$baseline" ]; then
    diff <(printf '%s\n' "$baseline") <(printf '%s\n' "$now") >&2 || true
    fail "$1: something was created in workspace or public"
  fi
  echo "   nothing outside $SCHEMA ($1)"
}

expected="$(find "$ROOT/supabase/migrations" -name '[0-9][0-9][0-9][0-9]_*.sql' | wc -l | tr -d ' ')"

echo "== 0. snapshot before migrating"
baseline="$(outside)"

echo "== 1. migrate from empty"
kbe db migrate --dry-run | tee "$WORK/out.txt"
grep -q "Dry run: $expected to apply" "$WORK/out.txt" || fail "dry run did not list $expected files"
[ "$(admin_sql -c "select to_regclass('$SCHEMA.kbe_migrations') is null")" = "t" ] \
  || fail "a dry run created the tracking table"
kbe db migrate | tee "$WORK/out.txt"
grep -q "Applied $expected migration(s)." "$WORK/out.txt" || fail "not every migration was applied"
[ "$(admin_sql -c "select count(*) from $SCHEMA.kbe_migrations")" = "$expected" ] \
  || fail "tracking table does not hold $expected rows"
[ "$(admin_sql -c "select min(filename) from $SCHEMA.kbe_migrations")" = "0000_prelude.sql" ] \
  || fail "0000_prelude.sql was not recorded"
[ "$(admin_sql -c "select string_agg(distinct kb_schema, ',') from $SCHEMA.kbe_migrations")" = "$SCHEMA" ] \
  || fail "the tracking table does not record the schema $SCHEMA"
[ "$(admin_sql -c "select to_regclass('$SCHEMA.documents') is not null")" = "t" ] \
  || fail "$SCHEMA.documents does not exist"
# Every function that pins a search_path pins it to this schema.
wrong_path="$(admin_sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(p.proconfig) as setting where n.nspname = '$SCHEMA' and setting like 'search_path=%' and setting not like 'search_path=$SCHEMA, %' and setting <> 'search_path=$SCHEMA'")"
[ "$wrong_path" = "0" ] || fail "$wrong_path function(s) in $SCHEMA pin another search_path"
nothing_outside "after migrate"

echo "== 2. the SQL checks, renamed for $SCHEMA"
# They expect a migrated database with no config yet, and roll back what they do.
for file in "$HERE"/*_test.sql; do
  echo "test  $(basename "$file")"
  kbe db render "$file" | admin_psql
done

echo "== 3. apply the example config"
kbe config validate config/engine.example.yaml
snapshot() {
  admin_sql -c "select (select count(*) from $SCHEMA.principals) || '/' || coalesce((select string_agg(domain, ',' order by domain) from $SCHEMA.domains), '')"
}
before="$(snapshot)"
kbe config apply config/engine.example.yaml --dry-run
[ "$before" = "$(snapshot)" ] || fail "a dry run changed topics or principals"
kbe config apply config/engine.example.yaml --yes

echo "== 4. topics and owner exist"
topics="$(admin_sql -c "select string_agg(domain, ',' order by domain) from $SCHEMA.domains")"
[ "$topics" = "consulting,private,properties,unclassified" ] || fail "topics are: $topics"
owner="$(admin_sql -c "select role || ':' || active from $SCHEMA.principals where email = 'owner@example.com'")"
[ "$owner" = "administrator:true" ] || fail "owner principal is: $owner"
grant="$(admin_sql -c "select string_agg(p.email, ',') from $SCHEMA.access_grants g join $SCHEMA.principals p on p.id = g.principal_id where g.domain = 'unclassified'")"
[ "$grant" = "owner@example.com" ] || fail "unclassified is granted to: $grant"

echo "== 5. migrate again is a no-op"
kbe db migrate | tee "$WORK/out.txt"
grep -q "Nothing to apply" "$WORK/out.txt" || fail "second migrate was not a no-op"

echo "== 6. apply again reports no changes"
kbe config apply config/engine.example.yaml --yes | tee "$WORK/out.txt"
grep -q "No changes" "$WORK/out.txt" || fail "second apply was not a no-op"

echo "== 7. adopt refuses a database that is already tracked"
if kbe db adopt --through 0028 2>"$WORK/out.txt"; then
  fail "adopt did not refuse"
fi
grep -q "already has" "$WORK/out.txt" || fail "adopt refused for the wrong reason"

echo "== 8. verify the database phases"
kbe verify --phases bronze,silver,gold,retrieval,access_control

echo "== 8a. access: the setup code is stored as a hash only"
settings() { admin_sql -c "select $1 from $SCHEMA.engine_settings"; }
kbe access status | tee "$WORK/out.txt"
grep -Eq "^setup: +open" "$WORK/out.txt" || fail "a new Engine is not in the open state"
grep -Eq "^setup code: +not set" "$WORK/out.txt" || fail "a new Engine already has a setup code"
grep -Eq "^sign-in settings: +missing" "$WORK/out.txt" || fail "a new Engine has sign-in settings"
kbe access init --dry-run >/dev/null
[ "$(settings "setup_code_hash is null")" = "t" ] || fail "a dry run stored a setup code"
if kbe access init --out "$WORK/never.txt" >/dev/null 2>&1 </dev/null; then
  fail "access init went ahead without a yes"
fi
[ ! -e "$WORK/never.txt" ] || fail "an unconfirmed init wrote a code file"
[ "$(settings "setup_code_hash is null")" = "t" ] || fail "an unconfirmed init stored a setup code"
if kbe access init --yes >/dev/null 2>"$WORK/out.txt"; then
  fail "access init made a code without being told where to put it"
fi
grep -q -- "--clipboard" "$WORK/out.txt" || fail "access init did not name the ways to receive the code"
[ "$(settings "setup_code_hash is null")" = "t" ] || fail "an init with nowhere to put the code stored one"
# --show prints the code, so it is refused when no person is at a terminal
# (here the output goes to a file, as it does for a program or an assistant).
if kbe access init --yes --show >"$WORK/out.txt" 2>"$WORK/err.txt"; then
  fail "access init --show printed a code with no terminal to print it on"
fi
grep -q "person is at the terminal" "$WORK/err.txt" || fail "--show was refused for the wrong reason"
[ "$(settings "setup_code_hash is null")" = "t" ] || fail "a refused --show stored a setup code"
kbe access init --yes --out "$WORK/code1.txt" > "$WORK/out.txt"
code="$(sed -n 's/^SETUP_CODE=//p' "$WORK/code1.txt")"
[ -n "$code" ] || fail "access init did not hand over a setup code"
if grep -q -- "$code" "$WORK/out.txt"; then fail "--out also printed the setup code"; fi
: > "$WORK/code1.txt"
[ "$(settings "setup_code_hash = encode(sha256(convert_to('$code', 'UTF8')), 'hex')")" = "t" ] \
  || fail "the stored hash is not the SHA-256 of the code handed over"
[ "$(settings "setup_state")" = "open" ] || fail "setup is not open after init"
if grep -q -- "$code" "$WORK/state.json"; then fail "the setup code is in the state file"; fi
: > "$WORK/out.txt"
kbe access status | tee "$WORK/out.txt"
grep -Eq "^setup code: +set" "$WORK/out.txt" || fail "status does not show the code as set"
grep -Eq "^setup: +open" "$WORK/out.txt" || fail "status does not show setup as open"
if kbe access init --yes --out "$WORK/code1b.txt" 2>"$WORK/out.txt"; then fail "a second init did not refuse"; fi
grep -q "already set" "$WORK/out.txt" || fail "a second init refused for the wrong reason"
kbe access reopen --yes --out "$WORK/code2.txt" > "$WORK/out.txt"
code2="$(sed -n 's/^SETUP_CODE=//p' "$WORK/code2.txt")"
[ "$(stat -f '%Lp' "$WORK/code2.txt" 2>/dev/null || stat -c '%a' "$WORK/code2.txt")" = "600" ] \
  || fail "the setup code file is readable by others"
if [ -n "$code2" ] && grep -q -- "$code2" "$WORK/out.txt"; then fail "--out also printed the setup code"; fi
: > "$WORK/out.txt"
: > "$WORK/code2.txt"
[ -n "$code2" ] && [ "$code2" != "$code" ] || fail "reopen did not give a new code"
[ "$(settings "setup_code_hash = encode(sha256(convert_to('$code2', 'UTF8')), 'hex')")" = "t" ] \
  || fail "reopen did not store the new code's hash"

echo "== 8b. access adopt: settings made by hand complete setup"
adopt() {
  kbe access adopt --team-domain https://example-team.cloudflareaccess.com \
    --aud example-aud-tag-for-the-connector --status-aud example-aud-tag-for-admin-pages \
    --host engine.example.com --level owner "$@"
}
if adopt >/dev/null 2>&1 </dev/null; then fail "access adopt went ahead without a yes"; fi
[ "$(settings "setup_state")" = "open" ] || fail "an unconfirmed adopt changed the setup state"
adopt --yes
[ "$(settings "setup_state || '/' || (setup_code_hash is null) || '/' || (access->>'host') || '/' || (access->>'resource_url')")" \
  = "complete/true/engine.example.com/https://engine.example.com/mcp" ] \
  || fail "adopt did not store the settings and complete setup"
kbe access status | tee "$WORK/out.txt"
grep -Eq "^setup: +complete" "$WORK/out.txt" || fail "status does not show setup as complete"
grep -Eq "^sign-in settings: +present" "$WORK/out.txt" || fail "status does not show sign-in settings"
adopt --yes | tee "$WORK/out.txt"
grep -q "No changes" "$WORK/out.txt" || fail "a second adopt was not a no-op"
nothing_outside "after access"

echo "== 8c. people: add and grant, each with a confirmation"
granted() {
  admin_sql -c "select coalesce(string_agg(g.domain, ',' order by g.domain), '') from $SCHEMA.access_grants g join $SCHEMA.principals p on p.id = g.principal_id where p.email = 'reader@example.com'"
}
if kbe people add reader@example.com --name "Sam Reader" >/dev/null 2>&1 </dev/null; then
  fail "people add went ahead without a yes"
fi
[ "$(admin_sql -c "select count(*) from $SCHEMA.principals where email = 'reader@example.com'")" = "0" ] \
  || fail "an unconfirmed add created a person"
kbe people add reader@example.com --name "Sam Reader" --yes | tee "$WORK/out.txt"
grep -q "^Done" "$WORK/out.txt" || fail "people add did not report the change"
kbe people grant reader@example.com consulting --dry-run >/dev/null
[ "$(granted)" = "" ] || fail "a dry run granted a topic"
kbe people grant reader@example.com consulting --yes
[ "$(granted)" = "consulting" ] || fail "the topic was not granted: $(granted)"
if kbe people grant reader@example.com private --yes 2>/dev/null; then
  fail "a sensitive topic was granted without --sensitive-ack"
fi
if kbe people grant reader@example.com properties --yes --as reader@example.com 2>/dev/null; then
  fail "a reader was allowed to grant a topic"
fi
[ "$(granted)" = "consulting" ] || fail "a refused grant changed the grants: $(granted)"
kbe people list | tee "$WORK/out.txt"
grep -q "^reader@example.com  reader  \[consulting\]" "$WORK/out.txt" || fail "people list is wrong"
[ "$(admin_sql -c "select count(*) from $SCHEMA.admin_confirmations where used_at is not null")" = "2" ] \
  || fail "the two applied changes did not each spend one confirmation code"

echo "== 8c2. people: a deactivated person comes back with the same topics, after a yes"
active() { admin_sql -c "select active from $SCHEMA.principals where email = 'reader@example.com'"; }
kbe people deactivate reader@example.com --yes >/dev/null
[ "$(active)" = "f" ] || fail "deactivate did not switch the person off"
if kbe people reactivate reader@example.com >/dev/null 2>&1 </dev/null; then
  fail "people reactivate went ahead without a yes"
fi
[ "$(active)" = "f" ] || fail "an unconfirmed reactivate changed the person"
kbe people reactivate reader@example.com --dry-run | tee "$WORK/out.txt"
grep -q "consulting" "$WORK/out.txt" || fail "the reactivate preview does not name the topics that come back"
kbe people reactivate reader@example.com --yes >/dev/null
[ "$(active)" = "t" ] || fail "reactivate did not switch the person back on"
[ "$(granted)" = "consulting" ] || fail "reactivate changed the grants: $(granted)"
if kbe people reactivate reader@example.com --yes 2>/dev/null; then
  fail "reactivating an active person did not refuse"
fi

echo "== 8c3. tokens: only the hash is stored and the token is never printed"
if kbe tokens mint --embed --yes >/dev/null 2>&1; then fail "tokens mint ran with nowhere to put the token"; fi
kbe tokens mint --embed --out "$WORK/token.txt" --yes > "$WORK/out.txt"
token="$(sed -n 's/^KNOWLEDGE_EMBED_TOKEN=//p' "$WORK/token.txt")"
[ -n "$token" ] || fail "tokens mint wrote no token"
if grep -q -- "$token" "$WORK/out.txt"; then fail "tokens mint printed the token"; fi
[ "$(admin_sql -c "select token_hash = encode(sha256(convert_to('$token', 'UTF8')), 'hex') from $SCHEMA.principals where handle = 'kb-engine'")" = "t" ] \
  || fail "the stored hash is not the SHA-256 of the minted token"
: > "$WORK/token.txt"

echo "== 8c4. pages import: a dry run first, then apply once; a second run changes nothing"
mkdir -p "$WORK/vault/people" "$WORK/vault/concepts"
printf -- '---\ntype: person\nemail: reader@example.com\nrelated: ["[[Idea]]"]\n---\nKnows [[Idea]].\n' \
  > "$WORK/vault/people/Sam Reader.md"
printf -- '---\ntype: concept\ndescription: An idea\n---\nBody.\n' > "$WORK/vault/concepts/Idea.md"
pages_for() { admin_sql -c "select count(*) from $SCHEMA.pages p join $SCHEMA.principals o on o.id = p.owner_principal_id where o.email = 'reader@example.com'"; }
kbe pages import "$WORK/vault" --owner reader@example.com --topic consulting | tee "$WORK/out.txt"
grep -q "Would file 2 pages" "$WORK/out.txt" || fail "the import dry run did not plan 2 pages"
[ "$(pages_for)" = "0" ] || fail "a dry run saved pages"
kbe pages import "$WORK/vault" --owner reader@example.com --topic consulting --apply --yes | tee "$WORK/out.txt"
grep -q "Done: 2 created, 0 already there" "$WORK/out.txt" || fail "the import did not create 2 pages"
[ "$(pages_for)" = "2" ] || fail "the pages are not in the database"
[ "$(admin_sql -c "select count(*) from $SCHEMA.page_links l join $SCHEMA.pages p on p.id = l.page_id where p.key = 'reader@example.com' and l.target_key = 'concept:idea'")" -ge 1 ] \
  || fail "the [[Idea]] link does not point at the imported page's key"
kbe pages import "$WORK/vault" --owner reader@example.com --topic consulting --apply --yes | tee "$WORK/out.txt"
grep -q "Done: 0 created, 2 already there" "$WORK/out.txt" || fail "a second import changed pages"

echo "== 8c5. pages import --from-backup: the nightly backup restores each owner's pages as they were"
FIXTURE="$ROOT/scripts/kbe/tests/fixtures/backup_roundtrip"
kbe people grant owner@example.com consulting --yes >/dev/null
if kbe pages import "$FIXTURE/vault" --owner owner@example.com --apply --yes >/dev/null 2>&1; then
  fail "a plain import of a backup folder went ahead"
fi
for who in owner@example.com reader@example.com; do
  kbe pages import "$FIXTURE/vault" --owner "$who" --from-backup --keep-topics --apply --yes | tee "$WORK/out.txt"
  grep -q "0 matched an existing page (left alone), 0 refused" "$WORK/out.txt" \
    || fail "the restore for $who did not file every page"
done
# Links as the database rebuilt them = the links the backed-up pages had.
restored_links() {
  admin_sql -c "select o.email || '|' || p.key || '|' || l.target_key || '|' || l.reason
    from $SCHEMA.page_links l join $SCHEMA.pages p on p.id = l.page_id
    join $SCHEMA.principals o on o.id = p.owner_principal_id
    where o.email = 'owner@example.com'
       or (o.email = 'reader@example.com' and p.key in ('concept:idempotent-import', 'alex@example.com'))
    order by 1"
}
expected_links="$("$PYTHON" -c '
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
rows = sorted("|".join((p["owner"], p["key"], l["target_key"], l["reason"])) for p in data["pages"] for l in p["links"])
print("\n".join(rows))' "$FIXTURE/pages.json")"
[ "$(restored_links)" = "$expected_links" ] || fail "restored links differ: $(restored_links)"
restored_pages="$(admin_sql -c "select o.email || '|' || p.key || '|' || md5(p.body) || '|' || array_to_string(p.topics, ',') || '|' || p.status from $SCHEMA.pages p join $SCHEMA.principals o on o.id = p.owner_principal_id where p.key in ('meeting:ff-abc123', 'meeting:ff-def456', 'concept:idempotent-import', 'project:widget-rollout') order by 1")"
expected_pages="$("$PYTHON" -c '
import json, sys, hashlib
data = json.load(open(sys.argv[1], encoding="utf-8"))
keys = {"meeting:ff-abc123", "meeting:ff-def456", "concept:idempotent-import", "project:widget-rollout"}
rows = sorted("|".join((p["owner"], p["key"], hashlib.md5(p["body"].encode()).hexdigest(), ",".join(p["topics"]), p["status"]))
              for p in data["pages"] if p["key"] in keys)
print("\n".join(rows))' "$FIXTURE/pages.json")"
[ "$restored_pages" = "$expected_pages" ] || fail "restored pages differ: $restored_pages"
kbe pages import "$FIXTURE/vault" --owner owner@example.com --from-backup --apply --yes | tee "$WORK/out.txt"
grep -q "Done: 0 created, 6 already there" "$WORK/out.txt" || fail "a second restore changed pages"

echo "== 8d. support: the login reads the inbox and nothing else"
HOST_PSQL="$(cd "$ROOT" && PYTHONPATH="$ROOT/scripts:$ROOT" "$PYTHON" -c 'from kbe import pg; print(pg.find_psql())')"
admin_sql -c "insert into $SCHEMA.issues (category, title, source, dedupe_key) values ('source_failure', 'wiki run failed', 'wiki', 'run-wiki')" >/dev/null
admin_sql -c "insert into $SCHEMA.documents (source, external_id, source_hash, title, body, domains) values ('wiki', 'kbe-e2e-support', 'x', 'Private title', 'Private body', array['unclassified'])" >/dev/null
kbe issues list | tee "$WORK/out.txt"
grep -q "open  source_failure  wiki  wiki run failed" "$WORK/out.txt" || fail "issues list does not show the open issue"
issue_id="$(cut -d' ' -f1 "$WORK/out.txt" | head -1)"
kbe issues show "$issue_id" | tee "$WORK/out.txt"
grep -q "^wiki run failed" "$WORK/out.txt" || fail "issues show does not show the issue"
if kbe issues list --as reader@example.com >/dev/null 2>&1; then
  fail "a reader could list the issues"
fi
kbe support status | tee "$WORK/out.txt"
grep -q "support login: none" "$WORK/out.txt" || fail "support is on before it was enabled"
if kbe support enable --out "$WORK/never.txt" >/dev/null 2>&1 </dev/null; then fail "support enable went ahead without a yes"; fi
if kbe support enable --yes --show >/dev/null 2>&1; then fail "support enable --show printed with no terminal"; fi
if kbe support enable --yes >/dev/null 2>&1; then fail "support enable made a login with nowhere to put its string"; fi
kbe support enable --yes --out "$WORK/support.txt" > "$WORK/out.txt"
support_url="$(sed -n 's/^SUPPORT_DATABASE_URL=//p' "$WORK/support.txt")"
if grep -q "postgresql://" "$WORK/out.txt"; then fail "--out also printed the connection string"; fi
: > "$WORK/out.txt"
: > "$WORK/support.txt"
[ -n "$support_url" ] || fail "support enable did not show a connection string"
# This container speaks no TLS; a hosted database does, and the string asks for it.
support_url="${support_url%\?sslmode=*}?sslmode=disable"
as_support() { "$HOST_PSQL" --no-psqlrc --quiet --tuples-only --no-align -v ON_ERROR_STOP=1 "$support_url" "$@"; }
[ "$(as_support -c "select title from $SCHEMA.v_support_inbox where source = 'wiki'")" = "wiki run failed" ] \
  || fail "the support login cannot read the inbox"
as_support -c "select $SCHEMA.issue_set_status(id, 'in_progress') from $SCHEMA.v_support_inbox" >/dev/null \
  || fail "the support login cannot mark an issue"
for hidden in documents principals access_grants engine_settings issues domains raw_captures; do
  if as_support -c "select count(*) from $SCHEMA.$hidden" >/dev/null 2>"$WORK/out.txt"; then
    fail "the support login can read $SCHEMA.$hidden"
  fi
  grep -q "permission denied" "$WORK/out.txt" || fail "reading $hidden failed for the wrong reason"
done
for call in "engine_settings_public()" "engine_config_get()" "engine_access_status()" \
            "admin_people_list('owner@example.com')"; do
  if as_support -c "select $SCHEMA.$call" >/dev/null 2>"$WORK/out.txt"; then
    fail "the support login can run $call"
  fi
  grep -q "permission denied" "$WORK/out.txt" || fail "$call failed for the wrong reason"
done
if kbe support enable --yes --out "$WORK/support2.txt" 2>"$WORK/out.txt"; then fail "a second support login was created"; fi
kbe support status | tee "$WORK/out.txt"
grep -q "support login: kb_support_login" "$WORK/out.txt" || fail "status does not show the login"
kbe support disable --yes
if as_support -c "select 1" >/dev/null 2>&1; then fail "the support login still works after disable"; fi
[ "$(admin_sql -c "select count(*) from pg_roles where rolname = 'kb_support_login'")" = "0" ] \
  || fail "the support login was not dropped"
if [ -f "$WORK/state.json" ] && grep -q "kb_support_login:" "$WORK/state.json"; then
  fail "the support connection string is in the state file"
fi
nothing_outside "after support"

echo "== 9. migrate refuses another schema on this database"
if kbe_with "$OTHER_FILE" db migrate --dry-run 2>"$WORK/out.txt"; then
  fail "migrate into a second schema did not refuse"
fi
grep -q "holds an Engine in the schema \"$SCHEMA\"" "$WORK/out.txt" \
  || fail "migrate refused for the wrong reason"

echo "== 10. nothing outside the schema"
nothing_outside "at the end"
if [ "$SCHEMA" != "$DEFAULT_SCHEMA" ]; then
  [ "$(admin_sql -c "select to_regnamespace('$DEFAULT_SCHEMA') is null")" = "t" ] \
    || fail "a schema named $DEFAULT_SCHEMA exists"
fi

echo "kbe end-to-end ($SCHEMA): all checks passed"
