---
name: kb-engine-setup
description: Walk a person through setting up their own knowledge Engine from this repository, start to finish - accounts, database, knowledge repo, config, deployment, Cloudflare sign-in, sources, people, first run, connecting Claude and tagging. Use when someone says "set up the engine", "set up my knowledge base", "deploy kb-engine", "install this", "get started", "help me configure this", "continue my setup", "where did we leave off", or opens this repository with no Engine yet. Also use to resume a setup that stopped part way.
---

# Setting up an Engine

You are leading a person through the setup. Assume they are not technical.
Explain each step in one or two plain sentences before you run it, say what
you are about to do, and say what you need from them. Go one step at a time.

Read `CLAUDE.md` first. Its rules apply to every step here. The four that
matter most:

- You never ask for, see or repeat a secret. The person types secrets into
  the local env file or the hosting dashboard. The one Cloudflare token goes
  from their clipboard straight into `kbe access setup`.
- You never open the env file (`.env`).
- A command that makes a secret (`kbe access init`, `kbe access reopen`,
  `kbe support enable`, `kbe tokens mint`) is always run with `--clipboard`
  or `--out FILE`. The secret goes to the person's clipboard or to a file
  only they can read, and never onto the screen. You never use `--show`
  (the command refuses it when no person is at the terminal), and you never
  read a file that `--out` wrote.
- A failed or skipped check stops the walk until it is fixed.

## How to run commands

Run everything from the root of this repository. The command line is `kbe`:

```
PYTHONPATH=scripts:. python -m kbe <group> <command>
```

The blocks below leave out the `PYTHONPATH=scripts:.` prefix to stay
readable. Add it to every `python` command, and use the Python of the
virtual environment made in step 1 (`.venv/bin/python`).

A command that changes something outside this machine asks "are you sure"
only when a person runs it in a terminal. When you run it, it cannot ask: it
stops and tells you to pass `--yes`. So for every such command:

1. Run it with `--dry-run` and show the person what it would do.
2. Ask for a yes.
3. Run it again with `--yes`.

The `kbe db` commands (`migrate`, `deploy-functions`, `expose-schema`) have
no `--yes` and do not ask. They act as soon as they are run without
`--dry-run`. Get the person's yes in the chat first.

Each block below starts from the repository root. Where a command has to run
in a subfolder it is written in brackets, `(cd scripts && ...)`, so the
folder does not change for the next command.

## Words to explain when they come up

| Word | Say |
|---|---|
| Schema | A named area inside the database. The Engine keeps everything in one |
| Connection string | The address and password a program uses to reach the database, in one line. Supabase shows it under Connect |
| Project ref | The first part of the Supabase project URL, before `.supabase.co` |
| Token, key | A long password made for a program instead of a person |
| Encrypted (in DigitalOcean) | A tick box next to a variable. Once saved, the value can be replaced but not read back |
| Component | One part of the app in DigitalOcean: the service `kb-engine`, or one job named `puller-<source>` |
| Second factor | A second proof when signing in: an authenticator app or a security key |
| Managed OAuth | The Cloudflare setting that lets Claude sign in on the person's behalf |
| AUD tag | An id Cloudflare gives each sign-in application. Not a secret |
| Bronze, silver, gold | Names of the database layers in the check output: raw copies, documents, approved documents |

## What the person ends up with

- A private knowledge repository on GitHub (Markdown pages, usable as an
  Obsidian vault) that also holds the Engine's config file.
- A database (Supabase) that holds the index of everything the Engine reads.
- One small app on DigitalOcean: the service Claude talks to, plus one
  scheduled job per source that reads the source once a day.
- Sign-in through Cloudflare: people sign in with a code emailed to them.
- A connector address, `https://<their hostname>/mcp`, to add to Claude.

### What it costs to run

There is no licence fee. The person pays their own providers. Do not quote
prices; tell them to check each provider's current pricing page:

| Provider | What is billed |
|---|---|
| DigitalOcean App Platform | One service on the smallest instance size, plus one scheduled job per enabled source (billed for the time it runs) |
| DigitalOcean serverless inference | The model calls that write the summaries, by usage |
| Supabase | One project. An existing project can be used |
| Cloudflare | Zero Trust has a free plan with a user limit. The domain must already be on Cloudflare |
| GitHub, Google, Fireflies | Their existing accounts |

DigitalOcean shows a billing estimate before the first deploy finishes. The
person must look at it (step 8).

## Before starting: accounts and tools

Go through this list with the person. Do not start until each one they need
exists.

| Needed | Why |
|---|---|
| **Supabase** account and a project | Holds the database. They choose: a new project, or one they already have. The Engine keeps everything in one schema (a named area of the database), `workspace` by default |
| **DigitalOcean** account with billing set up | Runs the service and the daily jobs |
| **Cloudflare** account with a domain on it | Sign-in, and the Engine's hostname (for example `engine.example.com`) |
| **Zero Trust opened once** on that Cloudflare account | Sign-in needs a team name, and an account gets one the first time Zero Trust is opened. Ask now: "Have you ever opened Zero Trust in Cloudflare?" If not, they go to `https://one.dash.cloudflare.com`, choose the account, and pick a team name and the free plan. Two minutes, no cost. Without it step 10 stops (it says so, and creates nothing) |
| **GitHub** account | Holds the private knowledge repository |
| **Google** account (only for the Drive source) | The Drive files to read. Needs a Google Cloud project with the Drive API on and an OAuth client of type "Desktop app" |
| **Fireflies** API key (only for the meetings source) | Reads meeting transcripts |
| **DigitalOcean inference key** | The model that writes the summaries. (An Anthropic API key works instead if the config says so) |

Tools on this machine: `git`, `gh` (logged in), `doctl` (logged in), Node.js
22 or newer, Python 3.10 or newer, `psql`, and the `supabase` command line.
`kbe doctor` checks them in step 1 and prints how to install or log in to
each one that fails. It accepts `psql` *or* `supabase`, but a full setup
needs both: `psql` for the database steps and `supabase` to deploy the embed
function. On macOS with Homebrew: `brew install libpq` for `psql`, and
`brew install supabase/tap/supabase` for `supabase`.

## The interview

Ask these before running anything that creates something. Ask one small
batch at a time and wait for the answers. Write the answers down in the chat
as a short summary and get a yes on the summary.

**Batch 1: the Engine and its owner**
1. A short id for the Engine: lower-case letters, digits and dashes (for
   example `acme`). It names the app and the local folder.
2. A display name (for example "Acme's Quantabase").
3. The owner's email. The owner is the first administrator and the only
   person who can see untagged material. It cannot be changed later.
4. How the owner's name appears in meeting notes (one or more spellings).

**Batch 2: topics**
5. The topics. A topic decides who can see a document. Ask for a short id and
   a label for each (for example `consulting` = Consulting, `properties` =
   Rental Properties).
6. Which topics are sensitive. A sensitive topic is never given to anyone
   automatically, administrators included; it is granted by name. A topic
   made sensitive cannot be unlocked later. Explain that `unclassified`
   always exists, holds everything untagged, and only the owner sees it.

**Batch 3: sources**
7. Which sources to turn on. The wiki (the knowledge repository) is always
   on. Optional: Google Drive, Fireflies and Gmail. Gmail reads one
   mailbox (by default the owner's) and only the threads that carry a tag
   label; nothing else in the mailbox is read. Leave it off unless they ask
   for it.
8. For each source: a default topic for untagged items, or none. Recommend
   none. With none, untagged items are `unclassified` and only the owner sees
   them. A default topic makes every untagged item in that source visible to
   everyone who holds that topic, so it needs an explicit yes.

**Batch 4: where it lives**
9. The hostname, for example `engine.example.com`. It must be on a domain in
   their Cloudflare account and must not be in use.
10. Who may sign in: **owner only**, **named people** (a list of emails), or
    **company domain** (anyone with an email at domains they list). They
    You pass this to `kbe access setup` in step 10, so they are not asked
    again.
11. The knowledge repository: create a new private one (give `owner/name`),
    or use one that exists. An existing one that already has pages is kept as
    it is and only the config file is added.
12. The Supabase project: new or existing. And the schema name: leave the
    default `workspace` unless they have a reason (for example the project
    already has a `workspace` schema used by something else).
13. The DigitalOcean region. The default is `nyc`; offer the one nearest to
    them (for example `fra`, `lon`, `sfo`). The app is named
    `<engine id>-kb-engine` unless they want another name.

## The steps

Each step says who acts, the command, the check, and what to do if it fails.
The check names the manifest phase to verify:

```
python -m kbe verify --phases <phase>
```

`python -m kbe verify --list` shows every phase.

### 1. Tools (you)

```
python3 -m venv .venv
.venv/bin/pip install -r pullers/requirements.txt
python -m kbe doctor
```

Check: `python -m kbe verify --phases prereqs`.

If a line says FAIL, it also says how to fix it. `gh auth login` and
`doctl auth init` need the person: ask them to run those in their own
terminal, then run `kbe doctor` again. Also confirm `psql --version` and
`supabase --version` both work.

### 2. The local env file (the person)

Copy the template. Do not open the copy afterwards.

```
cp .env.example .env
```

Ask the person to open `.env` in their own editor and fill in these, from
the Supabase dashboard:

| Name | Where to find it |
|---|---|
| `SUPABASE_URL` | Project Settings, API: Project URL |
| `SUPABASE_ANON_KEY` | Project Settings, API: anon key |
| `SUPABASE_JWT_SECRET` | Project Settings, API: JWT secret |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings, API: service role key. Used on this machine only, never deployed |
| `KBE_DATABASE_URL` | The Connect button: the direct connection string, with the database password filled in |
| `KNOWLEDGE_EMBED_URL` | `https://<project-ref>.supabase.co/functions/v1/embed`, where the project ref is the first part of the project URL |
| `KB_SCHEMA` | Only if they chose a schema other than `workspace` |

Say this about the placeholders, because it is the most common mistake: each
value in the template is shown as `<...>`, for example `<your-anon-key>`.
They replace the whole `<...>`, brackets included, with the real value. A
value left inside the brackets (`<the-real-key>`) counts as not filled in.

Every other line can stay as it is: a line that still shows its `<...>`
placeholder, and a line with nothing after the `=`, both count as not set.
They fill those lines in during later steps. The file has a comment above
each line saying what it is. They tell you when it is saved.

How to explain the Supabase values: in the Supabase dashboard, the project's
settings have an API page (the URL and the keys) and the top bar has a
Connect button (the connection string; they replace `[YOUR-PASSWORD]` in it
with the database password they chose when creating the project).

Check: when they say the file is saved, run

```
python -m kbe env check
```

It reads the file for you and says, for each name, one of: `set`, `empty`,
`still the example placeholder`, `wrapped in <...> (remove the brackets)` or
`not in the file`. It shows names only, never a value or a length, so its
output is safe to show the person. It also says when a URL or the database
connection string does not start the way it should. It fails when a value
needed now is missing, or when any value is still wrapped in `<...>`. Read
the "To fix" line to the person, let them edit the file, and run it again
until it says there is nothing to fix. Do not open the file to look.

### 3. The database (you)

```
python -m kbe db migrate --dry-run
python -m kbe db migrate
```

The dry run lists the files that would be applied. Show the count, get a
yes, then apply.

Then let the project's API serve the Engine's schema. Do this on every new
setup, with the default schema name too: a new Supabase project does not
serve `workspace` until it is added.

```
python -m kbe db expose-schema --dry-run
python -m kbe db expose-schema
```

With a Supabase access token in the env file (`SUPABASE_ACCESS_TOKEN`) the
command makes the change and keeps every schema already listed. Without one
it prints the dashboard clicks instead: the person does them (Project
Settings, Data API, Exposed schemas, add the schema name, Save) and tells you
when it is saved. If the schema is already listed, the command says so.

The proof that it worked is `python -m kbe db expose-schema --check`. It
reads the stored config, so it can only pass after step 6; run it there.

Check: `python -m kbe verify --phases bronze,silver,gold,retrieval,access_control,curation_loop`.

If it fails:
- "psql is not installed": install the Postgres client.
- A connection error: `KBE_DATABASE_URL` is wrong. The person fixes it.
- "was migrated into another schema": the database already holds an Engine
  under a different schema name. Stop and ask which is right.

### 4. The embed function (you; the person logs in once)

The embed function turns text into the numbers search uses.

```
python -m kbe db deploy-functions --dry-run
python -m kbe db deploy-functions
```

If it says "not logged in", the person runs `supabase login` in their own
terminal, then you run it again.

There is no check yet: the function is tested in step 7, once its token
exists (`distill_embed`).

### 5. The knowledge repository (you)

Build the command from the interview. One `--topic` per topic; add
`:sensitive` for a sensitive one. `--sources` lists the optional sources.

```
python -m kbe repo init --create acme/knowledge --engine-id acme --engine-name "Acme's Quantabase" --owner-email owner@example.com --owner-name "Pat Owner" --topic consulting=Consulting --topic properties="Rental Properties" --topic private=Private:sensitive --sources drive,fireflies --dry-run
```

Show the plan, get a yes, run it again with `--yes` in place of `--dry-run`.

- To use an existing empty repository: `--use owner/name` in place of
  `--create`.
- To use one that already has pages: `--use owner/name --adopt`. Only
  `.kb-engine/engine.yaml` is added.
- The clone lands in `~/knowledge-<engine id>` unless `--path` says
  otherwise. Tell the person they can open that folder as a vault in
  Obsidian.

If the person chose default topics (interview question 8), or wants the
status page's connector address filled in, edit
`~/knowledge-<engine id>/.kb-engine/engine.yaml` now (see
`docs/configuration.md` for every key), then:

```
python -m kbe config validate ~/knowledge-acme/.kb-engine/engine.yaml
```

Commit and push the change in the knowledge repository.

Then ask the person to add one line to `.env` so local checks read their
clone: `KNOWLEDGE_WIKI_ROOT=` followed by the full path of the clone.

Check: `python -m kbe verify --phases knowledge_repo`.

If it fails: "not empty" means the repository has content; use `--adopt`.
"already exists and is not empty" means the local folder is taken; pass
another `--path`.

### 6. Apply the config (you)

The service and the jobs read the config from the database, so it has to be
applied there.

```
python -m kbe config apply ~/knowledge-acme/.kb-engine/engine.yaml --dry-run
python -m kbe config apply ~/knowledge-acme/.kb-engine/engine.yaml --yes
```

Show the diff from the dry run (topics, sources, owner) and get a yes.

If it fails saying the schema must be one of a list, the schema is not
exposed yet: go back to the `expose-schema` part of step 3.

```
python -m kbe db expose-schema --check
```

Check: `python -m kbe verify --phases config`.

### 7. The embed token (you)

The service and the jobs need a token to call the embed function. This
command makes it, writes it into `.env` (as `KNOWLEDGE_EMBED_TOKEN` and
`KNOWLEDGE_TOKEN_KB_ENGINE`) and puts it on the person's clipboard. It does
not print it, and has no flag that would.

```
python -m kbe tokens mint --embed --write-env --clipboard --dry-run
python -m kbe tokens mint --embed --write-env --clipboard --yes
```

The token is the value of `EMBED_TOKEN` on the service and of
`KNOWLEDGE_EMBED_TOKEN` on every job. Step 9 sets both from `.env`, so the
person does not have to paste it anywhere. Tell them it is also on their
clipboard, in case they want it in their password manager. If the clipboard
is not available on this machine, use `--out <new file>` in place of
`--clipboard`; the person opens that file, you do not.

Do not run this command again later without a reason: each run replaces the
token, and the old one stops working everywhere it was pasted.

Check: `python -m kbe verify --phases distill_embed`.

### 8. Create the app (you; the person checks the bill)

`render` first checks that the branch the app builds from exists. If it
stops with "The branch `stable` does not exist", tell the person: no release
has been published on the `stable` branch of the public repository yet, so
the app cannot build from it. The way forward is a repository and branch
that do exist, named with `--source` (see below). Do not pass
`--skip-source-check` to get past this: the build would fail later.

```
python -m kbe deploy render --host engine.example.com --region nyc --server-mode
python -m kbe deploy apply --dry-run
python -m kbe deploy apply --yes
```

`render` writes the app's description to `.kb-engine-local/do-app-spec.yaml`
and lists the secrets it declares (names only). `apply` creates the app. Tell
the person before the `--yes`: this creates a billed app.

- The first deploy fails until the secrets are set. That is expected.
- The app builds from the `stable` branch of the public repository. To build
  from the person's own copy instead, add
  `--source github:<owner>/<repo>@<branch>` to `render` (the repository must
  be authorised in DigitalOcean).
- `apply` prints the app's own address (`<name>.ondigitalocean.app`) or says
  it is assigned after the first deploy. `python -m kbe deploy status` shows
  it later.

Ask the person to open the app in the DigitalOcean dashboard and confirm the
billing estimate shows one service on the smallest size plus the scheduled
jobs.

Check: `python -m kbe verify --phases deployment`.

### 9. The secrets (both)

The setup code is not part of this step any more. `kbe access setup` in
step 10 makes it, puts it on the app and uses it itself. Nobody handles it.

**The inference key (the person).** The jobs need a key for the model that
writes the summaries. In the DigitalOcean dashboard, the serverless inference
page has "model access keys"; they create one and put it into `.env` as
`DO_INFERENCE_KEY`. Run `python -m kbe env check` to confirm it reads `set`.

**The secrets (you run it).** One command sets the app's secrets from
`.env`, so nobody types them into the dashboard and nobody pastes one into
the chat:

```
python -m kbe deploy secrets push
python -m kbe deploy secrets push --yes
```

The first line is a preview: one line per secret, by name, saying `will
set` or `no local value, left as it is`. It never shows a value or a length.
Show it to the person and ask for a yes. The second line sets them. It
changes nothing in the app but secret values, and it starts a new
deployment; say so before the `--yes`.

- DigitalOcean does not reveal whether a secret already holds a value: it
  returns an encrypted text for every declared secret, also for one nobody
  has set. So the push sets every secret that has a value in `.env`, each
  time, and nothing can list which secrets are "set" on the app. Setting a
  secret to the value it already has changes nothing, so the command is safe
  to run again. Do not read `[set]` or "already set" into any output.
- `SETUP_CODE` shows `no local value, left as it is`. That is right: step 10
  takes care of it. (The flag `--setup-code-from-clipboard` still exists for
  the fallback in step 10, where a person types the code into the setup
  page.)
- `no local value, left as it is` is also expected for the source secrets
  now (`GITHUB_TOKEN`, the Drive, Fireflies and Gmail values). They come in
  step 11, which runs this command again. Anything else in that list needs a
  value in `.env` first: `python -m kbe env check` shows which lines are
  empty.

What it sets, and from where:

| Component | Secret | Comes from |
|---|---|---|
| `kb-engine` (the service) | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET` | The same names in `.env` |
| `kb-engine` | `EMBED_TOKEN` | `KNOWLEDGE_EMBED_TOKEN` in `.env` (step 7) |
| `kb-engine` | `SETUP_CODE` | Step 10 (`kbe access setup`), not this command |
| every `puller-<source>` job | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, `KNOWLEDGE_EMBED_URL`, `KNOWLEDGE_EMBED_TOKEN` | The same names in `.env` |
| every `puller-<source>` job | `DO_INFERENCE_KEY` (or `ANTHROPIC_API_KEY`) | The same name in `.env` |
| `puller-wiki` | `GITHUB_TOKEN` | Step 11 |
| `puller-drive` | `DRIVE_TOKEN_JSON_B64`, `DRIVE_TOKEN_CLIENT_JSON_B64` | Step 11 |
| `puller-fireflies` | `FIREFLIES_API_KEY`, and `GITHUB_TOKEN` | Step 11 |
| `puller-gmail` (only when Gmail is on) | `GMAIL_TOKEN_JSON_B64` | Step 11 |

The service-role key is never sent to the app: no component declares it.

**The fallback: the dashboard.** If the command cannot be used, the person
enters the same values by hand. In the DigitalOcean dashboard: the app,
Settings, pick the component, Environment Variables, edit, and enter each
value as Encrypted. The table above says which value goes where. Saving
starts a new deployment.

If they chose a schema other than `workspace`, the rendered spec already
carries `KB_SCHEMA` on every component.

Follow the deployment:

```
python -m kbe deploy status
```

Wait until `deploy status` shows the active deployment as `ACTIVE`. If no
deployment started, run `python -m kbe deploy redeploy --yes`.

No command can say which secrets hold a value on the app; the platform does
not reveal it. What can be checked: `python -m kbe deploy secrets push`
without `--yes` shows which secrets have a local value to send (`will set`)
and which have none. If one that is needed shows `no local value, left as
it is`, put it in `.env` and push again.

Check: `python -m kbe verify --phases mcp_engine`.

### 10. Sign-in (`kbe access setup`; the person makes one token)

This is where sign-in is created. One command does it. What is left for the
person: open one link, click Create in Cloudflare and copy the token, and
say yes.

You never see the token. The person copies it and the command reads it from
their clipboard. It is never printed, and you never ask for it.

Zero Trust must have been opened once on the Cloudflare account (the
accounts list at the top). If it was missed, the command says so before it
creates anything, and says what to click; then run it again.

**1. Show what it will do.** Pass the level from interview question 10 (and
the emails or domains that go with it). The hostname and the owner come from
the config applied in step 6.

```
python -m kbe access setup --dry-run --level owner
python -m kbe access setup --dry-run --level people --emails amy@example.com,bob@example.com
python -m kbe access setup --dry-run --level domain --domains example.com
```

Use the one line that fits. It prints the hostname, the owner, who may sign
in, and what the command will do. It changes nothing. Show it to the person,
and tell them what the app will then make in Cloudflare: a DNS record for
the hostname, two sign-in rules, and two sign-in applications (the one for
`/status` and `/setup` asks for a second factor). Ask for a yes.

**2. Run it.** The same line with `--yes` in place of `--dry-run`:

```
python -m kbe access setup --yes --level owner
```

It takes several minutes, because it waits for a deployment. Run it so that
you can read its output while it runs (in the background). It does this:

1. Makes a new setup code, stores its hash, and puts the code on the app as
   `SETUP_CODE`. The code is never shown. A deployment starts.
2. Prints a link to Cloudflare. **Give the person that link as soon as it
   appears**, with the lines printed under it. The link opens Cloudflare's
   "create token" screen with the four permissions filled in. Cloudflare's
   screen shows them as **Policies** cards: "Zone policy: DNS Write, Zone
   Read" and "Account policy: Access: Apps and Policies Write, Access:
   Organizations, Identity Providers, and Groups Write" (older screens say
   Edit, not Write). On that screen they set what the link cannot: the
   pencil on the Account policy card to narrow it to their one account, the
   pencil on the Zone policy card to pick Specific zone (the domain of the
   hostname), and Expiration (Custom, or 7 days). They check all four
   permissions are listed (without Zone Read setup cannot find the zone),
   create the token and copy it. They paste it nowhere.
3. Waits until the deployment is live, then picks the token up from the
   clipboard by itself.
4. Asks the app for its list of every change in Cloudflare, prints it, and
   has the app make the changes.
5. Takes `SETUP_CODE` off the app again, clears the clipboard, and prints
   the same lines as `kbe access status`.

It must say `Setup is complete.` Tell the person the token can now be
deleted in Cloudflare (My Profile, API Tokens); with an end date it also
stops working by itself.

After that line the command does two more things by itself:

- It says what the app read back from Cloudflare. Either one line,
  `Checked in Cloudflare: Managed OAuth is on, ...`, or one line for each
  setting that is not in place, starting `Needs a click in Cloudflare:` and
  ending with where to click. Read each such line to the person as it is;
  they make the click. Nothing else is needed for it.
- It waits until the hostname asks for a sign-in. A new hostname answers
  "not found" (404, "error code: 1043") for a minute or two. The command
  asks again every ten seconds and prints `Not ready yet`. That is not a
  failure: wait for `Sign-in is working.` If it gives up after four
  minutes, setup is still complete; it says what to check.

**If the person would rather answer the question themselves,** they run
`python -m kbe access setup --level owner` (no `--yes`) in their own
terminal. It does the same, shows the app's list, and asks once before it
changes Cloudflare.

**If it stops part way,** run the same line again. It makes a new setup
code (the old one stops working) and finishes the job: what was already
made in Cloudflare is left alone. After a failed step the token is still on
the clipboard, so the person does nothing more unless the message says the
token was the problem. If it says sign-in is already there, it changed
nothing: go on.

- A hostname or application that already exists in Cloudflare and was not
  made by setup is left alone, and the run stops. Add `--replace` only when
  the person says the existing one should be taken over.
- On a machine without `pbpaste` (not macOS), add `--token-file <path>`: the
  person saves the token in a new file only they can read, and deletes it
  afterwards. You never open that file.
- The command says so when the app runs a version from before this command.
  Then run `python -m kbe deploy redeploy --yes`, wait for `ACTIVE`, and
  start again.

Check: `python -m kbe verify --phases access_setup`. Sign-in takes a minute
or two to start working; the check asks again by itself.

**The fallback: the setup page.** If the command cannot be used, the person
does the same in a browser, by hand:

1. You run `python -m kbe access init --clipboard --yes` (after a dry run and
   a yes), then at once
   `python -m kbe deploy secrets push --setup-code-from-clipboard --yes`.
   The code goes from the clipboard to the app; ask the person to keep it in
   their password manager too, because the page asks for it twice.
2. When `python -m kbe deploy status` shows `ACTIVE`, they open
   `https://<the app's own address>/setup`: the `ondigitalocean.app`
   address, not their hostname.
3. The page has the same Cloudflare link. They enter the setup code, check
   the hostname, choose who may sign in, read the preview, paste the token
   and apply.
4. You run `python -m kbe access status`. It must say `setup: complete` and
   `sign-in settings: present`.
5. They delete the token in Cloudflare and remove `SETUP_CODE` from the
   `kb-engine` component in the dashboard.

**May need a manual click.** The setup was built from Cloudflare's
documentation. Most of its calls have since been checked against a live
account; a few have not (see `docs/security.md`, section 7), the token link
among them. The three settings that most often need a click (Managed OAuth
on the hostname application, Claude's redirect addresses on the allowed
list, the second factor on `/status`) are read back and named by the command
itself, as above; the setup page shows the same under "Needs a click in
Cloudflare". It reports what Cloudflare holds, not that Cloudflare enforces
it. If sign-in still fails later, the longer guide is
`engine/deploy/cloudflare-access-setup.md`.

### 11. The sources (both)

Do only the sources that are enabled. For each: the person makes the
credential and puts it in `.env`; then you check it. At the end, one command
sets them all on the jobs.

**Wiki (always).** The person creates a fine-grained GitHub token limited to
the knowledge repository, with Contents: read and write. They put it in
`.env` as `GITHUB_TOKEN`. It is the secret of the `puller-wiki` job (and of
`puller-fireflies` if Fireflies is on, which writes meeting pages).

How to make it: on GitHub, their profile picture, Settings, Developer
settings, Personal access tokens, Fine-grained tokens, Generate new token.
Repository access: "Only select repositories", and pick the knowledge
repository. Permissions, Repository permissions: Contents, "Read and
write". Generate, and copy the token straight into `.env`.

```
python -m kbe sources wiki check
```

**Fireflies.** The person copies their API key from Fireflies (Settings,
Developer settings) into `.env` as `FIREFLIES_API_KEY`.

```
python -m kbe sources fireflies check
```

**Google Drive (the person runs the sign-in).** They need the OAuth client
file ("Desktop app") downloaded from the Google Cloud console.

How to get it: at console.cloud.google.com, create a project (any name). In
"APIs & Services", Library, find "Google Drive API" and enable it. In "OAuth
consent screen", choose External, fill in the app name and their email, and
add their own Google address as a test user. In Credentials, Create
credentials, OAuth client ID, application type "Desktop app", Create, then
Download JSON.

The sign-in opens a browser and produces two secret values. Ask them to run
this in their own terminal, with a new file name of their choosing:

```
PYTHONPATH=scripts:. .venv/bin/python -m kbe sources drive auth --client-secret ~/Downloads/client_secret.json --out ~/drive-secrets.env
```

The file holds two lines. They copy both into `.env`, then delete the file.
You never open it. Access is read-only.

```
python -m kbe sources drive check
```

**Gmail (optional; only when `sources.gmail.enabled` is `true`).** Skip
this unless the person asked for mail. Say these four things first:

- One mailbox is read: the owner's, unless `sources.gmail.mailboxes` in the
  config names another. Only one mailbox is supported.
- Only threads that carry a tag label are read: a Gmail label named the tag
  prefix plus a topic, for example `kx/consulting`. The prefix is
  `tagging.prefix`, or `sources.gmail.prefix` when that is set. Mail without
  such a label is never listed, fetched or stored. Take the label off and
  the thread leaves the Engine at the next run.
- Access is read-only. The Engine cannot send, change or delete mail.
- Who sees a thread is stricter than for other sources. The owner of the
  mailbox sees their own labelled threads at once. Anyone else sees a thread
  only after it has been approved in review, and only if they hold one of
  its topics. Administrators get no way round this: an administrator sees
  approved mail in the topics an administrator holds (every topic that is
  not sensitive), and nothing more.

The sign-in uses the same kind of OAuth client file as Drive ("Desktop
app"). In the same Google Cloud project, also enable the "Gmail API". The
person signs in **as the mailbox the config names**. Ask them to run this in
their own terminal, with a new file name of their choosing:

```
PYTHONPATH=scripts:. .venv/bin/python -m kbe sources gmail auth --client-secret ~/Downloads/client_secret.json --out ~/gmail-secret.env
```

The file holds one line, `GMAIL_TOKEN_JSON_B64=...`. They copy it into
`.env`, then delete the file. You never open it.

```
python -m kbe sources gmail check
```

The check proves the sign-in works and is for the mailbox the config names,
and says how many labels start with the tag prefix. It lists no thread and
reads no mail. If Gmail was turned on after the app was created, the
`puller-gmail` job does not exist yet: apply the config, then run
`python -m kbe deploy render` and `python -m kbe deploy apply` again (see
the `kb-engine-admin` skill, "Turn a source on or off").

Each check prints `ok` or `FAILED` and a reason, and never any content.

When every check passes, set the source secrets on the jobs from `.env`.
Preview, a yes from the person, then `--yes`:

```
python -m kbe env check
python -m kbe deploy secrets push
python -m kbe deploy secrets push --yes
python -m kbe deploy status
```

The push starts a new deployment. The fallback is the dashboard, as in step
9, followed by `python -m kbe deploy redeploy --yes`.

Check: `python -m kbe verify --phases sources`.

### 12. People and topics (you, with a yes for each)

The owner already exists and holds every topic that is not sensitive, plus
`unclassified`. Add other people only if the person wants them now.

```
python -m kbe people add reader@example.com --name "Sam Reader" --dry-run
python -m kbe people add reader@example.com --name "Sam Reader" --yes
python -m kbe people grant reader@example.com consulting --dry-run
python -m kbe people grant reader@example.com consulting --yes
python -m kbe people list
```

- Roles are `reader` (default), `reviewer` and `administrator`. An
  administrator needs `--admin-ack`. A sensitive topic needs
  `--sensitive-ack`. Use either only after the person says so in words.
- **Two gates.** These commands decide what a person sees. Cloudflare decides
  whether they can sign in at all. At the "owner only" or "named people"
  level, a new person must also be on the Cloudflare sign-in rule. The Engine
  cannot change that rule. The person either edits the rule
  `KB Engine sign-in: <hostname>` in the Cloudflare dashboard, or re-runs the
  setup page with a fresh token (see `kb-engine-admin`). At the "company
  domain" level nothing more is needed for people at those domains.

### 13. The first run (you)

The jobs run once a day, starting at 11:00 UTC and 20 minutes apart (wiki,
then Drive, then Fireflies). Nothing is read before sign-in is set up; that
is by design.

To see results now, run a source from this machine. It does the real work
and makes real model calls:

```
python -m pullers.runner --source wiki --dry-run
python -m pullers.runner --source wiki
python -m kbe sources list
```

`sources list` shows each enabled source as `ok`, `failing` or `never run`.

Check: `python -m kbe verify --phases ingestion` (it passes once every
enabled source has had a good run, so it may have to wait for the schedule).

### 14. Connect Claude (the person)

In Claude: Settings, Connectors, Add custom connector. The address is

```
https://engine.example.com/mcp
```

with their hostname, and it must end in `/mcp`. Claude opens a sign-in page;
they enter their email and the code Cloudflare emails them. Then they ask
Claude a question that their knowledge can answer.

The status page is at `https://<hostname>/status`. It is for the owner only
and asks for a second factor (an authenticator app or a security key) the
first time.

Check: `python -m kbe verify --phases authentication`.

### 15. Tagging (you, with the `kb-engine-tagging` skill)

Until something is tagged, everything is `unclassified` and only the owner
sees it. Load the `kb-engine-tagging` skill and start with:

```
python -m kbe tags audit
```

Nothing is written to a source without the person's yes.

Check: `python -m kbe verify --phases tagging`.

### 16. Support access (optional)

Only if they have a support arrangement. It lets a support person read the
Engine's issue log and nothing else. The command makes a connection string,
which is a secret: it goes to the person's clipboard, never onto the screen.

```
python -m kbe support enable --clipboard --dry-run
python -m kbe support enable --clipboard --yes
```

The person passes the string to their support contact through a secure
channel (a password manager share), never by email or chat, and never to
you. See `docs/care-plan.md`.

### 17. The final check (you)

The last checks run the Engine's own access tests against the live database.
They need the service's test tools, and nothing else: no token is minted and
the Engine needs no document of its own.

```
(cd engine && npm ci)
python -m kbe verify
```

Every line must say PASS. A SKIP counts as a failure; it names the value
that is missing. Report the result to the person as it is.

## Resuming in a later session

Setup progress is kept on this machine in `.kb-engine-local/state.json`. It
holds no secret, so you may read it. It records which phases passed and the
answers already given (engine id, owner email, repository, clone path, app
name, region, hostname, app id, the app's own address).

To find where to continue:

```
python -m kbe verify --list
python -m kbe repo status
python -m kbe access status
python -m kbe deploy status
python -m kbe sources list
```

Then run `python -m kbe verify --phases <phase>` for the phases in order and
continue at the first one that does not pass. Do not re-run a step that
creates something (`repo init`, `deploy apply` on a new app) without
checking first whether it already exists. `access setup` is safe to run
again: it says so when sign-in is already there. If the state file is
missing (a different machine), the commands still work with explicit flags:
`--path`, `--app-id`, `--host`, `--repo`.

## Troubleshooting

| What you see | Cause | What to do |
|---|---|---|
| `kbe: Missing in your local env file: ...` | A value is not filled in | The person adds it to `.env`. Never read the file to check |
| `kbe access setup` says the deployment did not go live, or was not live in time | The build failed, or is slow | `python -m kbe deploy status` and the app's logs. When the app is `ACTIVE`, run `kbe access setup` again |
| `kbe access setup` keeps saying the clipboard does not hold a Cloudflare API token | The person has not copied the token yet, or copied something else | They copy the token from Cloudflare's "token created" screen. Nothing else is needed: the command picks it up |
| `kbe access setup` says the app did not answer with data | The app runs a version from before this command | `python -m kbe deploy redeploy --yes`, wait for `ACTIVE`, run it again |
| `kbe access setup` says the Cloudflare account has never opened Zero Trust | The account has no team name yet. Nothing was created | The person goes to `https://one.dash.cloudflare.com`, chooses the account, picks a team name and the free plan. Run the same line again; the token is still on the clipboard |
| `kbe access setup` prints `Needs a click in Cloudflare: ...` | The app read the setting back and it is not in place | The line ends with where to click. The person does that; nothing is run again |
| `kbe access setup` shows a step as Failed | The step's note says why (often: the token lacks a permission, or the domain is not on that Cloudflare account) | Fix what the note says, run the same line again. A new token is needed only if the note is about the token |
| `/setup` says "This app has no setup code" | `SETUP_CODE` is not set on the service | The person sets it in the dashboard and lets the app redeploy |
| `/setup` says "Wrong setup code" | The code typed is not the one on the app | Check for a stray space. Five wrong codes in 15 minutes lock the page for an hour |
| `/setup` says it is locked | Five wrong codes | `python -m kbe access reopen --clipboard` (dry run, a yes, then `--yes`). It puts a new code on the person's clipboard and clears the lock. They set the new code as `SETUP_CODE` and redeploy |
| `/setup` says the setup window is closed, or the code is not the one in the database | The app has an old code | Same: `kbe access reopen --clipboard`, set the new `SETUP_CODE`, redeploy |
| A command says `--show` only works when a person is at the terminal | `--show` was used in a session like this one | Use `--clipboard` or `--out FILE`. Never `--show` |
| `kbe deploy render` says the branch `stable` does not exist | No release has been published on that branch yet | Render with `--source github:<owner>/<repo>@<branch>` for a repository and branch that exist |
| `kbe sources gmail check` says the sign-in is for another mailbox | The person signed in to Google as a different address | Run `kbe sources gmail auth` again, signed in as the mailbox the config names |
| The hostname answers 404 ("error code: 1043"), or Claude cannot reach it, straight after setup finished | Cloudflare needs a minute or two to start serving a new hostname and its sign-in. Seen on a live account: 404 on every path for the first minute or two | Wait two minutes and try again. Change nothing. `python -m kbe verify --phases access_setup` asks again by itself for up to three minutes. If it is still 404 after five minutes, check that the hostname is listed on the DigitalOcean app |
| Any page answers `503 setup not complete` | Sign-in is not set up yet. Only `/health` and `/setup` answer before that | Finish step 10 |
| Every page answers 503 "Settings unavailable" | The service cannot read its settings from the database | Check the three Supabase secrets on the service, and, with a custom schema, that it is exposed (next row) |
| "The REST API did not answer for the schema" | The schema is not on the project's exposed list | `python -m kbe db expose-schema`, then `python -m kbe db expose-schema --check` |
| A job's log says "setup not complete ... nothing is ingested" | The jobs wait until sign-in is set up | Finish step 10. The job exits cleanly and runs on its next schedule |
| Claude cannot connect, or says authorization failed | The connector address lacks `/mcp`, or the person is not on the Cloudflare sign-in rule, or Managed OAuth is off | Fix the address. Check the rule in Cloudflare. See `engine/deploy/cloudflare-access-setup.md` |
| Claude connects but every search is empty | The person has no topic grants, or nothing is tagged with their topics | `python -m kbe people list`, then `python -m kbe tags audit` |
| "Invalid host" (421) | The request went to the app's own address after setup. Only the hostname answers | Use `https://<hostname>/...` |
| An item is visible only to the owner | It is untagged, or its tag names a topic that does not exist (a typo). Both become `unclassified` | Use the `kb-engine-tagging` skill |
| The config was changed in the knowledge repo but nothing changed | The file is invalid. An invalid file is rejected whole, an issue is logged and the last good config stays in force | `python -m kbe config validate <path>`, fix, commit, push, then `python -m kbe config apply <path>` |
| `kbe config apply` refuses a change | It would unlock a sensitive topic or change the owner | Both are refused on purpose. See `docs/configuration.md` |
| `kbe deploy apply` warns it would delete live components | A source was turned off in the config | Stop and ask. `--allow-remove` only after a yes |
| The first deploy fails | Secrets are not set yet | Expected. Set them (step 9) |
| `kbe access init` or `kbe access reopen` said the database "returned something unreadable" | An older `kbe` misread the empty answer of a call that had in fact worked. The new code was stored but never handed over | Update the checkout, then `python -m kbe access reopen --clipboard` (dry run, a yes, then `--yes`) for a fresh code |
| A deployment still fails for a missing secret after a push | The secret had no value in `.env`, so the push left it as it was. The platform cannot say which secrets hold a value | `python -m kbe deploy secrets push` (no `--yes`): every needed secret must read `will set`. Fill in the ones that read `no local value, left as it is`, then push with `--yes` |
| The build fails with "branch not found" | The repository the app builds from has no `stable` branch | Render again with `--source github:<owner>/<repo>@<branch>` for a repository and branch that exist |
| `kbe repo status` fails after an edit | The clone has uncommitted or unpushed changes | Commit and push in the knowledge repository |

## Limits to say out loud

- Sign-in is by one-time code sent to email. No other sign-in method is
  available yet.
- Adding a person later at the "owner only" or "named people" level needs a
  Cloudflare change as well (edit the rule, or re-run setup with a fresh
  token). The Engine holds no Cloudflare key and cannot do it.
- The setup page never deletes anything in Cloudflare. A changed hostname
  leaves the old records in place until the person removes them.
- Gmail reads one mailbox only, and only threads with a tag label. Mail is
  shown to people other than the mailbox's owner only after it is approved.
- The items listed as "Not yet verified" in `docs/security.md` section 7
  have not been proven against a live Cloudflare account. Any of them may
  need a manual click.
- Sign-in does not work the instant setup finishes. For the first minute or
  two the hostname may answer "not found (404)".
- On DigitalOcean the hostname answers "not found" until it is added to the
  app: app, Settings, Domains, Add domain, "You manage your domain" (or
  `doctl apps update` with a `domains` entry). See docs/operations.md, "The
  Engine's hostname on DigitalOcean". The Health screen checks it.
- The main sign-in (people and Claude's connector) lasts 1 year by default;
  the setup form offers 1 day or 30 days. The status and setup pages always
  ask again every 12 hours with a second factor.
- A restart after the Database screen keeps the claim (the database holds
  it): no new code; the open setup page keeps working, or reuse the first
  FIRST RUN code from the log.
