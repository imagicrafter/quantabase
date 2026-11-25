#!/usr/bin/env bash
# The whole local proof, twice: once with the default schema (`workspace`) and
# once with another name. Each run starts from an empty database, migrates,
# runs every *_test.sql, applies config/engine.example.yaml and verifies; the
# second run also proves nothing was created outside the chosen schema.
#
#   supabase/tests/both_schemas.sh
#   KB_OTHER_SCHEMA=kb_demo PYTHON=/path/to/python supabase/tests/both_schemas.sh
#
# Needs Docker, psql and Python with pullers/requirements.txt installed.
# Containers are removed when each run ends.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OTHER="${KB_OTHER_SCHEMA:-kb_acme}"

for name in workspace "$OTHER"; do
  echo "######## schema: $name"
  if [ "$name" = "workspace" ]; then
    (unset KB_SCHEMA; "$HERE/apply_local.sh")
    (unset KB_SCHEMA; "$HERE/kbe_e2e.sh")
  else
    KB_SCHEMA="$name" "$HERE/apply_local.sh"
    KB_SCHEMA="$name" "$HERE/kbe_e2e.sh"
  fi
done
echo "both schemas: all checks passed (workspace, $OTHER)"
