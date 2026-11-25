#!/usr/bin/env bash
# Apply every migration, in order, to a throwaway local Postgres that has the
# Supabase roles, then run the SQL checks in this folder.
# (0000_prelude.sql creates the schema, pgvector and the trigger function the
# rest need. To test the `kbe` CLI doing the same job, see kbe_e2e.sh.)
#
#   supabase/tests/apply_local.sh            # start, apply, test, remove
#   KEEP=1 supabase/tests/apply_local.sh     # leave the container running
#   KB_SCHEMA=kb_acme PYTHON=/path/to/python supabase/tests/apply_local.sh
#
# With the default schema every file goes to psql exactly as written. With
# KB_SCHEMA set to another name each file is renamed first by `kbe db render`
# (that needs Python with pullers/requirements.txt installed).
#
# Needs Docker. Touches nothing but its own container.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MIGRATIONS="$HERE/../migrations"
PYTHON="${PYTHON:-python3}"
DEFAULT_SCHEMA="workspace"
SCHEMA="${KB_SCHEMA:-$DEFAULT_SCHEMA}"
IMAGE="${KB_TEST_PG_IMAGE:-public.ecr.aws/supabase/postgres:15.8.1.085}"
NAME="${KB_TEST_PG_NAME:-kb-engine-migration-test}"
LOCAL_PW="local-only-$(date +%s)"

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    docker stop "$NAME" >/dev/null 2>&1 || true
    docker container rm "$NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker container rm --force "$NAME" >/dev/null 2>&1 || true
docker run --detach --name "$NAME" -e POSTGRES_PASSWORD="$LOCAL_PW" "$IMAGE" >/dev/null

# Migrations run as `postgres`, as they do on a hosted project. The checks run
# as the superuser so they can `set role` to each service role.
run_sql_as() {
  local user="$1"
  shift
  docker exec -i -e PGPASSWORD="$LOCAL_PW" "$NAME" \
    psql --quiet --no-psqlrc -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$user" -d postgres "$@"
}
run_sql() { run_sql_as postgres "$@"; }

for _ in $(seq 1 60); do
  if run_sql -c "select 1 from pg_roles where rolname = 'authenticator'" 2>/dev/null | grep -q 1; then
    break
  fi
  sleep 1
done

# The file as written for the default schema; renamed for any other.
render() {
  if [ "$SCHEMA" = "$DEFAULT_SCHEMA" ]; then
    cat "$1"
  else
    (cd "$ROOT" && PYTHONPATH="$ROOT/scripts:$ROOT" "$PYTHON" -m kbe db render "$1" --schema "$SCHEMA")
  fi
}

echo "schema: $SCHEMA"
count=0
for file in "$MIGRATIONS"/[0-9][0-9][0-9][0-9]_*.sql; do
  echo "apply $(basename "$file")"
  render "$file" | run_sql
  count=$((count + 1))
done
echo "applied $count migrations"

for file in "$HERE"/*_test.sql; do
  echo "test  $(basename "$file")"
  render "$file" | run_sql_as supabase_admin
done
echo "all SQL checks passed ($SCHEMA)"
