# Build manual

The long form of setting up an Engine, one chapter per phase of
`setup/manifest.yaml`, in the order a new setup reaches them. Each chapter
says what the phase is for, who acts, the commands, what the check proves,
and what goes wrong.

Two shorter forms exist:

- [`SETUP.md`](../SETUP.md): one page to skim before starting.
- The `kb-engine-setup` skill (`.claude/skills/kb-engine-setup/SKILL.md`):
  Claude Code leads a person through these chapters step by step. It also
  has the questions to answer before starting and a troubleshooting table.

## Conventions

Commands run from the repository root, with the Python of a virtual
environment that has `pullers/requirements.txt` installed:

```
python3 -m venv .venv
.venv/bin/pip install -r pullers/requirements.txt
export PYTHONPATH=scripts:.
python -m kbe --help
```

- **Credentials** are read from one local file, `.env` (git-ignored). Copy
  `.env.example` and fill it in. No command prints a value from it.
  [configuration.md](configuration.md) lists every variable.
- **Progress** is kept in `.kb-engine-local/state.json` (git-ignored, no
  secrets): which phases passed and non-secret answers such as the hostname.
- **Checks.** `python -m kbe verify --phases <id>` runs a phase's checks.
  `python -m kbe verify --list` lists the phases. SQL checks run in a
  transaction that is rolled back. A check that cannot run is reported as
  skipped, and a skip counts as a failure.
- **Changes outside this machine** have `--dry-run`, and ask before acting
  unless `--yes` is given.
- **Who acts.** "Person" means a human must do it: a dashboard, a browser
  sign-in, or a command that shows a secret. "Either" means a person or an
  agent such as Claude Code.

## What you need first

| Account | Used for |
|---|---|
| Supabase, one project | The database and the embed function |
| DigitalOcean, with billing | The app (service and jobs) and the summary model |
| Cloudflare, with a domain on it and Zero Trust opened once | Sign-in and the hostname |
| GitHub | The private knowledge repo |
| Google, with a Cloud project, the Drive API on and a "Desktop app" OAuth client | The Drive source, if used |
| Fireflies, with an API key | The meetings source, if used |

Decide before starting: the Engine's id and name, the owner's email (it
cannot be changed later), the topics and which are sensitive (a sensitive
topic cannot be unlocked later), the sources, the hostname, who may sign in,
and the schema name (`workspace` unless there is a reason).

The phases, and the chapter for each:

| # | Phase | Who | Needs |
|---|---|---|---|
| 1 | `prereqs` | either | |
| 2 | `bronze` | agent | 1 |
| 3 | `silver` | agent | 2 |
| 4 | `gold` | either | 3 |
| 5 | `retrieval` | agent | 4 |
| 6 | `access_control` | agent | 3 |
| 7 | `curation_loop` | agent | 4 |
| 8 | `knowledge_repo` | either | 1 |
| 9 | `config` | either | 2, 8 |
| 10 | `distill_embed` | agent | 9 |
| 11 | `deployment` | either | 9 |
| 12 | `mcp_engine` | agent | 6, 11 |
| 13 | `access_setup` | person | 12 |
| 14 | `sources` | either | 9 |
| 15 | `ingestion` | agent | 10, 13, 14 |
| 16 | `authentication` | person | 13 |
| 17 | `tagging` | either | 15 |
| 18 | `verification` | agent | 7, 15, 16, 17 |

Chapters 2 to 7 are all done by one command, `kbe db migrate`. They are
separate phases because each proves a different property of the database.

---

## 1. Prerequisites (`prereqs`)

**For:** the tools every later step calls.

```
python -m kbe doctor
```

It checks `git`, `gh` and its login, `doctl` and its login, Node.js 22 or
newer, Python 3.10 or newer, and `psql` or `supabase`. Docker is optional
(local database tests only). It reports pass or fail and never shows an
account name.

`doctor` accepts either database tool. A full setup needs both: `psql` for
every database command, and the `supabase` command line for
`kbe db deploy-functions`.

Then make `.env` from `.env.example`. The person fills in the Supabase
values: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`,
`SUPABASE_SERVICE_ROLE_KEY`, `KBE_DATABASE_URL`, `KNOWLEDGE_EMBED_URL`, and
`KB_SCHEMA` if not the default.

Clear every line that is not filled in yet: delete the `<your-...>`
placeholder and leave the line empty after the `=`. A placeholder left in
place counts as a value.

**Check:** `kbe doctor` exits 0.

## 2. Raw captures (`bronze`)

**For:** building the database. This command does the work of chapters 2
to 7.

```
python -m kbe db migrate --dry-run
python -m kbe db migrate
```

Every file in `supabase/migrations/` is applied in filename order, each in
its own transaction, and recorded with its checksum in `kbe_migrations`.
The first file creates the schema and the vector extension, so the files
apply to an empty database.

- **An existing database** built before this tool is marked first:
  `python -m kbe db adopt --through NNNN`, then `kbe db migrate` for the
  rest.
- **Another schema name.** With `KB_SCHEMA` set, each file is rewritten for
  that name as it is applied.
- **Serving the schema.** The service, the jobs and `kbe config apply`
  reach the database through the project's REST API, which serves only the
  schemas on the project's "exposed schemas" list. A new Supabase project
  does not list `workspace`, so do this on every new setup, whatever the
  schema is called:

  ```
  python -m kbe db expose-schema
  python -m kbe db expose-schema --check
  ```

  With `SUPABASE_ACCESS_TOKEN` in `.env` the first command makes the change
  and keeps the schemas already listed; without it, it prints the dashboard
  steps. `--check` works once a config has been applied (chapter 9).
- One database holds one Engine. A database migrated into one schema refuses
  a migrate into another.

**Check:** the constraint that limits `raw_captures.source` to known sources
exists, and `kbe db migrate --dry-run` says nothing is left to apply.

**Raw captures** hold each item as the source gave it. Documents are built
from them, so a document can be rebuilt without asking the source again.

## 3. Documents (`silver`)

**For:** the table every search reads.

**Check:** inserting a document with an empty topic list fails. A document
with no topic would be visible to nobody or, worse, treated as visible to
all by some later mistake. The database refuses it. Untagged documents get
the topic `unclassified` instead.

## 4. Approval (`gold`)

**For:** letting a person's judgement outrank the machine's.

A document starts unreviewed. A reviewer can approve it, ask for a new
summary, exclude it, or correct its topics. See
[manual.md](manual.md#6-review-and-approval).

**Check:** two documents identical in every way but review status are
inserted (and rolled back); the approved one must score higher in search.

## 5. Retrieval (`retrieval`)

**For:** search that fails closed.

**Check:** a search with a token nobody holds returns zero rows and no
error. An unknown caller learns nothing, including whether anything exists.

## 6. Access control (`access_control`)

**For:** the rule that the service can read only through functions that
filter by who is asking.

**Checks:**

- The `kb_engine` role holds zero table grants.
- A sensitive topic is never part of what an administrator sees
  automatically. It has to be granted by name.

See [architecture.md](architecture.md#the-two-database-roles) and
[roles.md](roles.md).

## 7. The curation loop (`curation_loop`)

**For:** applying review decisions exactly once.

**Checks:** a review batch can hold a document only once, and no review item
is marked applied without a decision. Together these make applying a batch
a second time harmless.

## 8. The knowledge repo (`knowledge_repo`)

**For:** the private GitHub repository that holds the wiki pages and the
Engine's one config file, `.kb-engine/engine.yaml`.

```
python -m kbe repo init --create acme/knowledge --engine-id acme --engine-name "Acme's Quantabase" --owner-email owner@example.com --owner-name "Pat Owner" --topic consulting=Consulting --topic properties="Rental Properties" --topic private=Private:sensitive --sources drive,fireflies --dry-run
```

Run it with `--dry-run` first, then without. It builds the config from the
flags and validates it before anything is created. Then it creates the
private repository with `gh`, clones it to `~/knowledge-<engine id>` (or
`--path`), copies the starter vault from `templates/knowledge-repo/`, writes
the config, commits and pushes.

- `--use owner/name` uses an existing empty repository.
- `--use owner/name --adopt` keeps a repository's content and adds only the
  config file. The repository's default branch must be `main`.
- `:sensitive` after a topic's label locks it. `unclassified` is added by
  the Engine and may not be listed.

Keys the flags do not cover (a source's default topic, Fireflies channels,
the tag prefix, the status page) are edited in the file afterwards. Every
key is in [configuration.md](configuration.md). After an edit:

```
python -m kbe config validate ~/knowledge-acme/.kb-engine/engine.yaml
```

then commit and push. Add `KNOWLEDGE_WIKI_ROOT=<path of the clone>` to
`.env` so local checks read this clone.

**Check:** `kbe repo status`: the clone exists, has nothing uncommitted,
matches `origin/main`, and its config is valid.

## 9. The config (`config`)

**For:** putting the config where the service and the jobs read it: the
database.

```
python -m kbe config apply ~/knowledge-acme/.kb-engine/engine.yaml --dry-run
python -m kbe config apply ~/knowledge-acme/.kb-engine/engine.yaml
```

It validates the file, shows a diff against what the database holds (topics
added, removed or changed; sources turned on or off; the owner), asks, and
applies it all or not at all. The first apply creates the owner as the
first administrator and creates the topics.

Later changes are made the same way. The wiki job also applies a changed,
valid file on its daily run. An invalid file is rejected whole, an issue is
logged, and the last good config stays in force.

The database refuses three things: unlocking a sensitive topic, changing
the owner once an administrator exists, and removing a topic that documents
or grants still use.

**Checks:** a config is stored; the owner is an active administrator;
nobody but the owner is granted `unclassified`; and a dry-run apply of the
file in the knowledge repo reports no changes.

## 10. Summaries and vectors (`distill_embed`)

**For:** the two things done to every document: a short summary, and a
vector for search.

Deploy the embed function:

```
python -m kbe db deploy-functions
```

It needs the `supabase` command line and a login (`supabase login`, or
`SUPABASE_ACCESS_TOKEN` in `.env`). With a non-default schema it first
tells the function which schema to use. The function can be deployed any
time after chapter 2; the guided setup does it straight after the database.

The function accepts a call only with the token of an active person or
service record. The database already has a record for the service, named
`kb-engine`, which can embed and read nothing. Make its token:

```
python -m kbe tokens mint --embed --write-env --clipboard
```

The token is written to `.env` as `KNOWLEDGE_EMBED_TOKEN` and
`KNOWLEDGE_TOKEN_KB_ENGINE`, and copied to the clipboard. It is never
printed; the command has no flag that prints it. The same value is later
set on the app as `EMBED_TOKEN` on the service and `KNOWLEDGE_EMBED_TOKEN`
on each job (`python -m kbe deploy secrets push` takes it from `.env`). Running the command
again replaces the token, and the old one stops working.

Summaries are written by the model named in `models.distill` (by default a
model on DigitalOcean serverless inference). Its key, `DO_INFERENCE_KEY`,
goes in `.env` and on each job.

**Check:** the embed function returns a 384-number vector for the stored
token. A machine that also embeds locally should run
`python -m knowledge.verify_embedding_alignment` (from `scripts/`) to prove
both produce the same vectors; a deployment that only uses the function has
nothing to compare.

## 11. Deployment (`deployment`)

**For:** the DigitalOcean app: one service and one scheduled job per
enabled source.

```
python -m kbe deploy render --host engine.example.com --server-mode
python -m kbe deploy apply --dry-run
python -m kbe deploy apply
```

`render` fills `engine/deploy/do-app-spec.template.yaml` from the config
and writes `.kb-engine-local/do-app-spec.yaml`. Every secret is declared
with no value. `apply` creates the app with `doctl` and lists the app's
secrets by name and by where each value comes from. No `kbe` command takes a
secret value as an argument.

- The app builds from the public repository's `stable` branch. To build
  from your own copy: `--source github:<owner>/<repo>@<branch>` (authorise
  the repository in DigitalOcean first).
- Default region `nyc`; default app name `<engine id>-kb-engine`.
- The first deploy fails until the secrets are entered. That is expected.
- On a later `apply`, the live spec is read first and every stored secret
  value is kept. A change that would delete a component is refused without
  `--allow-remove`.

**The secrets** are set from the local env file:

```
python -m kbe deploy secrets push
python -m kbe deploy secrets push --yes
```

The first line previews, one line per secret and by name only: `will set`
or `no local value, left as it is`. The second sets them and starts a new
deployment. Nothing but secret values changes. DigitalOcean does not reveal
whether a secret already holds a value (it returns an encrypted text for
every declared secret, set or not), so the push sets every secret that has a
local value, each time. It is safe to run again.
`EMBED_TOKEN` on the service takes `KNOWLEDGE_EMBED_TOKEN` from the file.
`SETUP_CODE` is not kept in the file and is not set here:
`python -m kbe access setup` (chapter 13) makes it and sets it by itself.
(For the setup page instead, add `--setup-code-from-clipboard` right after
`python -m kbe access init --clipboard`.) The fallback for any secret is the DigitalOcean dashboard (the
app, Settings, the component, Environment Variables, as Encrypted).

**The person** confirms the billing estimate: one service on the smallest
instance size plus the scheduled jobs. The source credentials in the last
three rows can wait until chapter 14.

| Component | Secrets |
|---|---|
| `kb-engine` | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, `EMBED_TOKEN`, `SETUP_CODE` |
| each `puller-<source>` | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, `KNOWLEDGE_EMBED_URL`, `KNOWLEDGE_EMBED_TOKEN`, and the model key (`DO_INFERENCE_KEY`) |
| `puller-wiki` | `GITHUB_TOKEN` |
| `puller-drive` | `DRIVE_TOKEN_JSON_B64`, `DRIVE_TOKEN_CLIENT_JSON_B64` |
| `puller-fireflies` | `FIREFLIES_API_KEY`, and `GITHUB_TOKEN` when it writes meeting pages |
| `puller-gmail` (only when the Gmail source is on) | `GMAIL_TOKEN_JSON_B64` |

The service-role key and the database connection string are never entered
there.

**Checks:** the rendered spec validates with `doctl`, and no secret in it
carries a value.

## 12. The service (`mcp_engine`)

**For:** a running service that can reach the database.

```
python -m kbe deploy redeploy
python -m kbe deploy status
```

`status` shows the active deployment, the app's own address
(`<name>.ondigitalocean.app`) and each job's last run.

**Checks:**

- `/health` on the app's own address answers `{"ok": true}`. The check uses
  that address because the Engine's hostname is behind Cloudflare, which
  asks for a sign-in first.
- The REST API serves the Engine's schema.

At this point the service is in setup mode: only `/health` and `/setup`
answer; everything else returns `503 setup not complete`.

## 13. Sign-in (`access_setup`)

**For:** deciding who can reach the Engine, before anything is indexed.

Two secrets are involved, the setup code and a one-time Cloudflare API
token. Neither is given to an agent, and neither is ever printed.

### The usual way: one command

```
python -m kbe access setup --dry-run --level owner
python -m kbe access setup --yes --level owner
```

`--level` is `owner`, `people` (with `--emails a@x.com,b@x.com`) or `domain`
(with `--domains x.com`). The hostname and the owner come from the applied
config. The level and its lists are remembered in the local state file, so
a second run needs no flags.

What is left for the person: open one link, click Create in Cloudflare and
copy the token, and say yes.

The first line changes nothing: it shows the choices and what the command
will do. The second does this:

1. Makes a setup code in memory, stores its hash in the database, and sets
   the code as `SETUP_CODE` on the app. The code is never shown. This
   starts a deployment, which the command follows until it is live.
2. Prints a link that opens Cloudflare's "create token" screen with the
   four permissions filled in (three at Write, Zone at Read). On the
   screen's Policies cards the person sets what the link cannot (the
   pencil on each card: their one account, Specific zone for the domain;
   Expiration Custom or 7 days), creates the token and copies it.
3. Reads the token from the clipboard. It is refused if it is not shaped
   like a Cloudflare API token or if it is a value from the local env file.
   `--token-file PATH` reads it from a file instead (machines without
   `pbpaste`). A token in the old form (40 characters, no `cfut_` in
   front) is taken only with `--legacy-format`.
4. Asks the app for its plan and prints it: the app's own list of every
   change in Cloudflare. With `--yes` it then applies; without, in a
   terminal, it asks once.
5. Blanks `SETUP_CODE` on the app, clears the clipboard, and prints the
   same lines as `kbe access status`.
6. Says what the app read back from Cloudflare: one line when Managed
   OAuth, Claude's redirect addresses and the second factor are all in
   place, otherwise one line for each that is not, with where to click.
7. Waits until the hostname asks for a sign-in. A new hostname answers
   "not found" (404) for a minute or two; the command asks again every ten
   seconds, for up to four minutes, and says so.

Zero Trust must have been opened once on the Cloudflare account, so that it
has a team name. If it has not, the first step in Cloudflare stops, nothing
is created, and the command says what to do: go to
`https://one.dash.cloudflare.com`, choose the account, pick a team name and
the free plan, and run the command again.

The Cloudflare calls are made by the app, through the same two routes the
setup page uses, behind the same code check and lockout. The command only
carries the choices, the code and the token to the app, over HTTPS, at the
app's `ondigitalocean.app` address.

If a run stops part way, run it again. It makes a new setup code and
finishes the job; what Cloudflare already has is left alone. If sign-in is
already set up, it says so and changes nothing. `--replace` takes over a
DNS record or an application for the hostname that setup did not make.

The command works on a new Engine only. Once sign-in exists, the setup
routes are behind the admin sign-in: use "Changing it later" below.

### The fallback: the setup page

The same, by hand, in a browser.

1. **The setup code.** The person runs:

   ```
   python -m kbe access init --clipboard
   ```

   It makes a long random code, stores only its hash in the database, and
   puts the code on the clipboard (or, with `--out FILE`, into a new file
   only its owner can read). It prints the code only with `--show`, which is
   for a person in their own terminal and is refused anywhere else. With
   none of the three flags it refuses and changes nothing. The person saves
   the code as the secret `SETUP_CODE` on
   the `kb-engine` component and lets the app redeploy. The command needs
   only the database, so it can be run with chapter 11 and the code entered
   together with the other secrets.

2. **The Cloudflare token.** The setup page has the same link to
   Cloudflare's token screen, on the form and again next to the token box
   on the apply step, and says what to set there: four permissions (DNS and
   the two Access ones at Write, Zone at Read), narrowed with each Policies
   card's pencil to the one account and the one domain (Specific zone),
   with a Custom or 7-day expiry.

3. **The page.** The person opens `https://<the app's own address>/setup`,
   enters the code, checks the hostname (filled in from the config), chooses
   who may sign in, reads the preview of every change, pastes the token and
   applies.

Afterwards the person deletes the token in Cloudflare and removes
`SETUP_CODE` from the app.

### What setup makes

Setup then creates, in Cloudflare: the DNS record for the hostname, a
sign-in rule, an application for the whole hostname with Managed OAuth on
(so Claude can connect), an administrators rule, and a second application
for `/status` and `/setup` that needs a second factor. It stores the
non-secret results in the database and closes. The token is used for that
one request and is not kept. [security.md](security.md) has every detail,
including what has not been proven against a live Cloudflare account.

Who may sign in, at one of three levels:

| Level | Who |
|---|---|
| Owner only | The owner's email |
| Named people | The owner and a list of emails |
| Company domain | The owner and anyone with an email at the listed domains |

All three use a one-time code sent by email. No other sign-in method is
available yet.

Afterwards the person deletes the token in Cloudflare (with an end date it
also stops working by itself).

- **Lockout.** Five wrong codes in 15 minutes lock the page for an hour.
  `python -m kbe access reopen` makes a new code and clears the lock, and so
  does running `python -m kbe access setup` again.
- **Changing it later.** `kbe access reopen`, a new `SETUP_CODE`, a fresh
  token, and the page again. The settings in force stay until the new setup
  finishes.
- **Applications made by hand.** A deployment whose Cloudflare applications
  already exist skips the page:
  `python -m kbe access adopt --team-domain https://<team>.cloudflareaccess.com --aud <AUD> --status-aud <AUD> --host engine.example.com`.
  [`engine/deploy/cloudflare-access-setup.md`](../engine/deploy/cloudflare-access-setup.md)
  describes making them by hand.

**Checks:** `kbe access status` reports setup complete with both
applications stored; the hostname does not answer `/mcp` without a sign-in;
the app's own address no longer serves `/mcp`.

## 14. Sources (`sources`)

**For:** a working credential for each enabled source, on this machine and
on its job.

| Source | Credential | Check |
|---|---|---|
| Wiki | `GITHUB_TOKEN`: a fine-grained token for the knowledge repo only, Contents read and write | `python -m kbe sources wiki check` |
| Fireflies | `FIREFLIES_API_KEY` | `python -m kbe sources fireflies check` |
| Drive | Two values made by a browser sign-in (below) | `python -m kbe sources drive check` |
| Gmail (optional) | One value made by a browser sign-in (below) | `python -m kbe sources gmail check` |

The Drive sign-in is the person's:

```
python -m kbe sources drive auth --client-secret ~/Downloads/client_secret.json --out ~/drive-secrets.env
```

It asks for read-only access and writes `DRIVE_TOKEN_JSON_B64` and
`DRIVE_TOKEN_CLIENT_JSON_B64` to a new file only the person can read
(`--clipboard` copies them one at a time instead). They go into `.env` and
onto the `puller-drive` job; then the file is deleted.

The Gmail sign-in works the same way, and is needed only when
`sources.gmail.enabled` is `true`. The person signs in as the mailbox the
config names (by default the owner's):

```
python -m kbe sources gmail auth --client-secret ~/Downloads/client_secret.json --out ~/gmail-secret.env
```

It asks for read-only access and writes one value, `GMAIL_TOKEN_JSON_B64`,
which goes into the local env file and onto the `puller-gmail` job. Only
threads that carry a tag label are read, and a thread is shown to people
other than the mailbox's owner only after it is approved. See
[security.md](security.md#9-mail-the-gmail-source).

A check makes one small read and prints `ok` or `FAILED` with a reason. It
never prints what the source returned.

After the source credentials are in `.env`:
`python -m kbe deploy secrets push --yes` sets them on the jobs and starts a
new deployment. If they were entered in the dashboard instead:
`python -m kbe deploy redeploy`.

**Check:** every enabled source's credential makes one read.

## 15. Ingestion (`ingestion`)

**For:** the first documents.

The jobs run once a day from 11:00 UTC, 20 minutes apart. A job does
nothing until sign-in is set up. To run one now from this machine:

```
python -m pullers.runner --source wiki --dry-run
python -m pullers.runner --source wiki
python -m kbe sources list
```

Before or after this, add any people who should see results (they see
nothing until granted a topic):

```
python -m kbe people add reader@example.com --name "Sam Reader"
python -m kbe people grant reader@example.com consulting
python -m kbe people list
```

Each change shows the database's own preview and asks. At the "owner only"
and "named people" levels a new person must also be added to the
Cloudflare sign-in rule; the Engine cannot do that.

**Checks:** the wiki connector passes its contract test on the local clone;
an audit-only pass over the wiki writes nothing; every enabled source has
run and its last run succeeded.

## 16. Connecting Claude (`authentication`)

**For:** proving a real sign-in works end to end.

In Claude: Settings, Connectors, Add custom connector, with the address

```
https://engine.example.com/mcp
```

The address must end in `/mcp`. Claude opens the Cloudflare sign-in; the
person enters their email and the code sent to it. The first sign-in ties
that Cloudflare identity to the person's record in the database.

**Checks:** a client can register with Cloudflare for Claude's redirect
address; the owner's record has an identity pinned from a first sign-in.

## 17. Tagging (`tagging`)

**For:** deciding who sees what. Until something is tagged it is
`unclassified` and only the owner sees it.

```
python -m kbe tags audit
```

[tagging.md](tagging.md) explains where a tag goes in each source. The
`kb-engine-tagging` skill proposes topics for untagged items into a file,
shows it, and writes only after a yes.

**Checks:** the audit runs; every live document records how its topics were
decided; `unclassified` exists and is sensitive.

## 18. Verification (`verification`)

**For:** the checks of the access model against the live database.

```
(cd engine && npm ci)
python -m kbe verify
```

No token is minted for this, and the Engine needs no document of its own.

**Checks:**

- The fail-closed suite: the anonymous key can call no Engine function, the
  service's role holds no table grants, a person with no grants sees no
  rows, an inactive person resolves to no topics. None may be skipped.
- The role-boundary suite: asked over the live REST API, the anonymous role
  may run no read function and the service's role may read no table.
- The token-path check (in the `access_control` phase): it makes its own
  sensitive topic, three people and one document, proves that the person
  with the grant finds the document and that nobody else does (a person
  with a valid token and no grant, an administrator without a grant by
  name, an unknown token), and rolls everything back.

When `kbe verify` passes with nothing skipped, the Engine is set up.
[operations.md](operations.md) covers what comes after.
