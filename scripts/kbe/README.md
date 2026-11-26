# kbe — the setup command line

```
PYTHONPATH=scripts:. python -m kbe <group> <command>
```

Needs Python 3.10+ and `pip install -r pullers/requirements.txt`. Every command
has `--help`.

| Command | What it does |
|---|---|
| `kbe doctor [--json]` | Checks `git`, `gh` (and login), `doctl` (and login), `node` 22+, `python`, `psql` and `supabase`. Both database tools are needed: `psql` for `kbe db migrate`, `kbe verify`, `kbe people`, `kbe issues`, `kbe tokens` and `kbe support`; `supabase` for `kbe db deploy-functions`. Non-zero exit if a required one fails. |
| `kbe env check` | Says what each line of the local env file holds: `set`, `empty`, `still the example placeholder`, `wrapped in <...> (remove the brackets)` or `not in the file`, grouped by needed now, filled in by a later step, and optional. Names only: never a value or a length. Also says when `SUPABASE_ACCESS_TOKEN` does not start with `sbp_`, a `*_URL` does not start with `http`, or `KBE_DATABASE_URL` does not start with `postgres`. Non-zero exit when a value needed now is missing or mis-shaped, or any value is still wrapped in `<...>`. |
| `kbe db migrate [--schema NAME] [--dry-run] [--accept-changed FILE]` | Applies `supabase/migrations/*.sql` in filename order, each in its own transaction. Records each file, its checksum and the schema in the `kbe_migrations` table. Stops, changing nothing, if an applied file has changed, or if the database was migrated into another schema. |
| `kbe db adopt --through 0028 [--force] [--dry-run]` | For a database built before this tool: records migrations up to that number as applied without running them. |
| `kbe db deploy-functions [--project-ref REF] [--dry-run]` | Deploys the `embed` edge function with the `supabase` CLI. With a non-default schema it first sets the function's `KB_SCHEMA` secret. With the default schema it first removes a `KB_SCHEMA` secret the function still holds, if there is one. |
| `kbe db expose-schema [--project-ref REF] [--dry-run] [--check]` | Adds the Engine's schema to the project's exposed schemas (keeps the ones already there). Uses the Supabase Management API when `SUPABASE_ACCESS_TOKEN` is set; otherwise prints the dashboard steps. `--check` tests that the REST API serves the schema. |
| `kbe db render FILE [--schema NAME]` | Prints a SQL file as it would be applied to your schema. Changes nothing. |
| `kbe config validate <path>` | Checks an `engine.yaml` and prints every problem. |
| `kbe config apply <path> [--dry-run] [--yes] [--via auto\|api\|db]` | Validates, shows a diff against the config the database has, asks, then applies it. |
| `kbe repo init (--create OWNER/NAME \| --use URL-OR-OWNER/NAME) [--adopt] --engine-id ID --engine-name NAME --owner-email EMAIL [--owner-name N ...] [--topic ID=LABEL[:sensitive] ...] [--sources drive,fireflies,gmail] [--path DIR] [--dry-run] [--yes]` | Sets up the knowledge repo: creates it private with `gh` (or uses an existing empty one), copies `templates/knowledge-repo/`, writes a validated `.kb-engine/engine.yaml` from the answers, commits, pushes, clones to `--path` (default `~/knowledge-<engine id>`). `--adopt` adds only `.kb-engine/` to a repo that already has pages. |
| `kbe repo status [--path DIR]` | Clone present, clean, in sync with the remote, config valid. |
| `kbe deploy render [--host H] [--app-name N] [--region R] [--config PATH] [--source github:OWNER/REPO@BRANCH] [--cf-team-domain URL --cf-aud AUD [--cf-status-aud AUD]] [--server-mode \| --no-server-mode] [--skip-source-check] [--stdout]` | Writes `.kb-engine-local/do-app-spec.yaml` from `engine/deploy/do-app-spec.template.yaml`: the service, the hostname, every secret declared with no value, and — only with `--server-mode` (remembered; `--no-server-mode` turns it off) — one scheduled puller job per enabled source. First checks with `git ls-remote` that the branch to build from exists (by default the `stable` branch of the public repository) and stops if it does not; `--skip-source-check` leaves the check out. |
| `kbe deploy apply [--app-id ID] [--allow-remove] [--dry-run] [--yes]` | Creates the DigitalOcean app, or updates it. An update reads the live spec first and keeps every stored secret value, shows a diff of the rest, and asks. Then lists the app's secrets by name and where each value comes from. It cannot say which hold a value: DigitalOcean returns an encrypted text for every declared secret, set or not. Takes no secret value. A `doctl` failure shows `doctl`'s own error text, with every known credential masked. |
| `kbe deploy secrets push [--app-id ID] [--setup-code-from-clipboard] [--dry-run] [--yes]` | Sets the app's secrets from the local env file. Reads the live spec and, for every variable declared `type: SECRET` (app-wide, the service, each job), takes the value of the same name from the env file; `EMBED_TOKEN` is `KNOWLEDGE_EMBED_TOKEN` locally. Without `--yes` it previews, one line per secret: `will set` or `no local value, left as it is`. Never a value or a length. DigitalOcean does not reveal whether a secret already holds a value, so every secret with a local value is set, each time; it is safe to run again. Nothing but secret values changes. `--setup-code-from-clipboard` takes `SETUP_CODE` from the clipboard (macOS) and refuses anything that is not shaped like a setup code. Starts a new deployment. |
| `kbe deploy status [--json]`, `kbe deploy redeploy [--dry-run] [--yes]` | The app's deployment and last job runs; start a new deployment. |
| `kbe access setup [--host HOST] [--level owner\|people\|domain] [--emails LIST] [--domains LIST] [--replace] [--token-file PATH] [--legacy-format] [--app-id ID] [--wait-minutes N] [--dry-run] [--yes]` | Sets up Cloudflare sign-in with one command, through the app's own setup routes. Reads the hostname and the owner from the applied config; makes the setup code, sets it on the app and blanks it again, never showing it; prints a link that opens Cloudflare's token screen with the permissions filled in; reads the token from the clipboard (or `--token-file`), never showing it; prints the app's list of every Cloudflare change and asks (or applies with `--yes`). Afterwards it names any setting that still needs a click in Cloudflare (from what the app read back) and waits until the hostname asks for a sign-in. A second run finishes an interrupted one. For an Engine with no sign-in yet. |
| `kbe access init (--clipboard \| --out FILE \| --show) [--dry-run] [--yes]` | Makes the one-time setup code, stores only its hash, and hands the code over once for you to save as the app secret `SETUP_CODE`: to the clipboard, to a new file only you can read, or (with `--show`) printed. With none of the three it refuses and changes nothing. |
| `kbe access reopen (--clipboard \| --out FILE \| --show) [--dry-run] [--yes]` | A new code and an open setup page, also after a lockout. Same three choices. |
| `kbe access status [--json]` | Where setup stands (state, level, hostname, sign-in settings present or not). Shows no secret. |
| `kbe access adopt --team-domain URL --aud AUD --host HOST [--status-aud AUD] [--level owner\|people\|domain] [--dry-run] [--yes]` | For a deployment whose Cloudflare applications were made by hand: stores their non-secret values as the sign-in settings and marks setup complete. |
| `kbe sources list [--json]` | Enabled sources and each one's last run. |
| `kbe sources drive auth --client-secret FILE (--clipboard \| --out FILE)` | Google sign-in in the browser, read-only Drive access. The two values for the `puller-drive` secrets go to the clipboard or to a new 0600 file, never to the screen. |
| `kbe sources drive check`, `fireflies check`, `wiki check [--repo OWNER/NAME]` | One small read with the configured credential. Says pass or fail; prints no data. |
| `kbe sources gmail auth --client-secret FILE (--clipboard \| --out FILE)` | Only for an Engine that turns the optional Gmail source on (`sources.gmail.enabled: true`). Google sign-in in the browser, read-only Gmail access, as the mailbox the config names. The one value for the `puller-gmail` secret (`GMAIL_TOKEN_JSON_B64`) goes to the clipboard or to a new 0600 file, never to the screen. |
| `kbe sources gmail check` | Proves the stored Gmail sign-in works and is for the mailbox the config names, and says how many labels start with the tag prefix. Lists no thread and reads no mail. |
| `kbe people list`, `add EMAIL --name N [--role R]`, `grant EMAIL TOPIC`, `revoke EMAIL TOPIC`, `deactivate EMAIL`, `reactivate EMAIL` | People and topic grants, through the same two-step admin functions the connector uses: the database's preview, a yes, then the change. `--as EMAIL` names the administrator (default: the owner). |
| `kbe pages import FOLDER --owner EMAIL [--map FILE] [--topic TOPIC ...] [--skip DIR ...] [--json] [--apply] [--yes]` | One-time import of an OKF or Obsidian wiki as one person's pages. Without `--apply` it only reads the folder and reports what it would file (drawer, key, fallbacks), what it would skip, merge or split into linked parts (a body over 200,000 characters; nothing is cut) and why, how meeting attendees link, the `--map` refiles, merges and new pages, and which frontmatter keys it drops. Pages keep their created/updated dates (migration 0074). `--apply` asks, then saves each page through `page_import` over the direct connection; a key the person already holds is left alone. A meeting (key rule `source_id`) is matched by its key only, never by title (migration 0079), so each meeting of a recurring series is its own page. Pages get only the `--topic` topics the person holds. See `docs/operations.md`, "Importing an existing wiki". |
| `kbe pages import CHECKOUT --owner EMAIL --from-backup [--keep-topics] [--topic TOPIC ...] [--json] [--apply] [--yes]` | Restore one person's pages from a checkout of the nightly GitHub backup: each page keeps its key, identities, fields, sources, status and body; other people's pages are skipped; `--keep-topics` restores each page's own topics. Needs migration 0078. A plain import of a backup checkout is refused. See `docs/operations.md`, "Restoring pages from the backup". |
| `kbe issues list [--all] [--as EMAIL] [--json]`, `kbe issues show ID` | Reads the issue log: the open issues (or, with `--all`, closed ones too; the newest 200), and one issue with its detail. Read-only, administrators only. |
| `kbe tokens mint (--embed \| --handle HANDLE \| --email EMAIL) [--write-env] [--clipboard \| --out FILE] [--dry-run] [--yes]` | A new token for the service's embed principal or for a person. Only its hash goes to the database. The token goes into the local env file (`--write-env`), onto the clipboard or into a new file. There is no flag that prints it. Minting replaces that principal's old token. |
| `kbe support enable (--clipboard \| --out FILE \| --show) [--login NAME] [--dry-run] [--yes]`, `kbe support disable`, `kbe support status` | Read-only support access to the issue inbox. `enable` hands a connection string over once, the same three ways as the setup code. See `docs/care-plan.md`. |
| `kbe tags audit \| suggest \| apply \| authorize` | See `docs/tagging.md`. `apply --write` shows the plan and asks before it writes; `--yes` skips the question. |
| `kbe verify [--phases a,b] [--list] [--json]` | Runs the verify checks in `setup/manifest.yaml`. A skipped check counts as a failure. |

Every command that changes something outside this machine has `--dry-run` and
asks before it acts unless `--yes` is given. The question is only asked in a
terminal; a command run by a program is refused unless it passes `--yes`.

Four commands hand a new secret to a person: `kbe access init`,
`kbe access reopen`, `kbe support enable` and `kbe tokens mint`. None prints
it by default.
(`kbe deploy secrets push` makes none: it copies values from the env file to
the app and shows only names. `kbe access setup` makes the setup code and
uses it itself: it hands it to nobody and has no flag that shows it.) Each
takes `--clipboard` (the secret goes to the clipboard) or `--out FILE` (a new
file only you can read, mode 0600, never replaced). The first three also take
`--show`, which prints the secret once: that flag is for a person in their own
terminal, and is refused when the output is not a terminal. An assistant or a
program always uses `--clipboard` or `--out FILE`.
With no flag the command refuses before it changes anything.

The guided walk through these commands is the `kb-engine-setup` skill
(`.claude/skills/kb-engine-setup/SKILL.md`); the long form is
`docs/build-manual.md`.

## From nothing to a working Engine

In order. A step marked **(you)** needs a person; the rest can be run for you.

```
 1. python -m kbe doctor
 2. (you) fill in the local env file: Supabase URL, keys, database URL
          (replace the whole <...>, brackets included; a value left inside
          them counts as not set). Then: python -m kbe env check
 3. python -m kbe db migrate
 4. python -m kbe db expose-schema            # a new project, or a new KB_SCHEMA
 5. python -m kbe db deploy-functions
 6. python -m kbe repo init --create <owner/name> --engine-id ... --engine-name ... --owner-email ...
 7. python -m kbe config apply ~/knowledge-<id>/.kb-engine/engine.yaml
 8. python -m kbe deploy render --host <engine.example.com>
 9. python -m kbe deploy apply                # prints the secrets list and the app's own address
10. python -m kbe deploy secrets push --yes   # the app's secrets, from the env file
    (without --yes it only previews.
    The fallback: (you) enter them in the DigitalOcean dashboard)
11. python -m kbe deploy status               # wait for the deployment to be active
12. python -m kbe access setup --dry-run --level owner
13. python -m kbe access setup --yes --level owner
    (you) open the link it prints, create the Cloudflare token, copy it.
    The command does the rest: the setup code, the app's preview, the apply,
    and the clean-up. Neither the code nor the token is shown.
    The fallback is the setup page: `kbe access init --clipboard`, then
    `kbe deploy secrets push --setup-code-from-clipboard --yes`, then (you)
    open https://<the app's own address>/setup
14. python -m kbe access status               # setup: complete
15. python -m kbe sources drive auth ...      # per source; then `kbe sources <name> check`
16. python -m kbe deploy secrets push --yes   # the source secrets, from the env file; starts a deployment
17. python -m kbe people add ... ; python -m kbe people grant ...
18. python -m kbe sources list ; python -m kbe verify
```

The jobs do nothing until step 13 is done: nothing is indexed before sign-in
is set up (`pullers/access_gate.py` has the exact rule). A deployment whose
Cloudflare applications were made by hand uses `kbe access adopt` in place of
steps 10 and 13.

Secrets that need a token minted first: `EMBED_TOKEN` and
`KNOWLEDGE_EMBED_TOKEN` are one value, made by
`python -m kbe tokens mint --embed --write-env --clipboard` after step 3 (the
migrations create the embed principal). It writes the token into the local
env file, where `kbe deploy secrets push` takes it from for both names, and
puts it on the clipboard. Run it once: each run replaces the token.

## Which project, which schema

- **The project** is chosen by `SUPABASE_URL` and the keys next to it (and
  `KBE_DATABASE_URL` for the direct connection).
- **The schema** inside it is chosen by one setting, `KB_SCHEMA`. Leave it out
  and everything uses `workspace`: an existing deployment needs no change, and
  its migrations are applied byte for byte as the files are written.
- To use another name, set the same `KB_SCHEMA` in four places: the local env
  file (this CLI and the jobs), the service's environment, each deployed job's
  environment, and the embed function (`kbe db deploy-functions` sets it).
- The name must be lowercase letters, digits and underscores (63 at most, not
  starting with a digit), and not `public`, `auth`, `storage`, `extensions`,
  another Supabase schema, or `pg_*`. A bad name stops the program. It is
  never swapped for the default.
- Migration files are written for `workspace`. For another schema,
  `kbe db migrate` changes the name as it applies each file (qualified names,
  `create schema`, grants, pinned `search_path`, and strings used as a schema
  name; comments are left alone). If a file uses the name in a way the tool
  does not recognise, it refuses before running anything. The recorded
  checksum is always that of the file as written.
- One database holds one Engine. A database migrated into one schema refuses
  a migrate into another.
- A new schema must be served by the REST API: run `kbe db expose-schema`,
  then `kbe db expose-schema --check` (also a `kbe verify` check).

New setup, another schema, in order: set `KB_SCHEMA` → `kbe db migrate` →
`kbe db expose-schema` → `kbe config apply` → `kbe db deploy-functions` →
set `KB_SCHEMA` on the service and the jobs.

Local proof for both cases (Docker): `supabase/tests/both_schemas.sh`.

## Credentials and local state

- **Credentials** come from one local, git-ignored env file: the repo's `.env`
  by default, or `--env-file PATH`, or `KBE_ENV_FILE`. See `.env.example`. The
  file is read into memory; nothing is exported into the process, and no value
  is ever printed. A child program (`psql`, `supabase`) gets what it needs
  through its own environment, never on its command line.
- **Local state** is `.kb-engine-local/state.json` (git-ignored, mode 0600):
  which setup phases are done, and non-secret answers such as hostnames and
  repo names. It refuses to store anything that looks like a secret.

## A new database

```
python -m kbe doctor
python -m kbe db migrate --dry-run     # see what would run
python -m kbe db migrate
python -m kbe config apply path/to/engine.yaml
python -m kbe verify --phases bronze,silver,gold,retrieval,access_control
```

## A database that already exists

```
python -m kbe db adopt --through 0028  # record what it already has
python -m kbe db migrate               # run the rest
```

## How `config apply` reaches the database

It calls `workspace.engine_config_get()` and `workspace.engine_config_apply()`
as the `kb_ingest` role — the pullers' identity — one of two ways:

- **api**: the project's REST API with a five-minute `kb_ingest` token, as the
  pullers connect. Needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_JWT_SECRET`.
- **db**: `KBE_DATABASE_URL` with `set local role kb_ingest`. If that login may
  not take the role (a local test database), it runs as the login and says so.

`--via auto` (the default) uses **api** when its three values are set.

## Layout

One module per command group; each has `register(groups)` and is listed in
`cli.GROUPS`. To add a group, write the module and add it there.

| Module | Holds |
|---|---|
| `cli.py`, `__main__.py` | argument parsing and dispatch |
| `context.py` | paths, output, the process runner, the yes/no prompt |
| `secrets.py`, `state.py` | the env file; the local state file |
| `env_check.py` | `kbe env check`; the one table of which name is needed when |
| `secret_out.py` | handing a new secret over: clipboard, a 0600 file, or `--show` |
| `env_names.py` | which settings names the Python code reads (for the example-file test) |
| `proc.py`, `pg.py` | running programs; `psql` and the tracking table |
| `doctor.py` | `kbe doctor` |
| `db.py`, `migrations.py` | `kbe db`; which files to run (no I/O) |
| `config_cmd.py`, `config_diff.py`, `config_store.py` | `kbe config`; the diff (no I/O); the two ways in |
| `verify.py`, `manifest.py` | `kbe verify`; reading `setup/manifest.yaml` |
| `repo.py`, `repo_config.py`, `repo_scaffold.py` | `kbe repo`; answers to an `engine.yaml` (no I/O); the `gh` and `git` calls |
| `deploy.py`, `deploy_render.py`, `deploy_merge.py`, `deploy_doctl.py` | `kbe deploy`; template to spec (no I/O); keeping live secret values on an update (no I/O); the `doctl` calls |
| `deploy_push.py`, `deploy_secrets.py` | `kbe deploy secrets push`; which secrets to set and the spec that sets them (no I/O), with the one table of app-secret to env-file names |
| `access.py` | `kbe access` |
| `sources.py`, `sources_drive.py`, `sources_gmail.py`, `sources_checks.py`, `sources_state.py`, `ingest_client.py` | `kbe sources`; the database client that acts as the pullers do |
| `people.py`, `support.py` | `kbe people`; `kbe support` |
| `issues.py`, `tokens.py` | `kbe issues`; `kbe tokens` |
| `tags.py`, `tag_audit.py`, `tag_suggest.py`, `tag_apply.py` | `kbe tags audit / suggest / apply / authorize` (see `docs/tagging.md`) |
| `tag_writers.py`, `tag_clients.py` | writing a tag back to a wiki page, a Drive description or a Gmail label; the Google clients for it |

## Tests

```
PYTHONPATH=scripts:. python -m pytest scripts/kbe -q
supabase/tests/kbe_e2e.sh      # needs Docker and psql; uses a throwaway database
```
