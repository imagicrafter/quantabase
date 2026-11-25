# Quantabase

Quantabase (repository and package name: `kb-engine`) is a private knowledge Engine for one person or one small organisation. It
reads the places your knowledge already lives, writes a short summary of
each document, and lets Claude search it for you and for the people you
choose. Each person sees only the topics they have been granted.

You run it on your own accounts. There is one codebase for every Engine;
everything that is yours (topics, people, sources, hostname) lives in your
own private repository and your own database.

## Who it is for

- An owner who wants Claude to answer from their own notes, documents and
  meetings, without handing those to a shared service.
- A small team where different people should see different things: a
  bookkeeper sees the finance topic, a contractor sees one project.
- Someone comfortable following a guided setup. You do not need to write
  code. You do need accounts with Supabase, DigitalOcean, Cloudflare (with a
  domain) and GitHub.

## Deploy

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/imagicrafter/quantabase/tree/stable)

The button makes one DigitalOcean service from this repository
(`.do/deploy.template.yaml`) and asks for three values from your Supabase
project (Project Settings -> API): the project URL, the anon key and the JWT
secret. Then:

1. Open the app's **Runtime Logs** in DigitalOcean and find the line
   `FIRST RUN: open https://<this app's address>/setup?code=...`. Open that
   address (with the app's own address) to claim the Engine. The code works
   once.
2. The **Database** screen sets up the Supabase project (tables, the embed
   function, the embed token in Vault) from a project access token that is
   used once and not kept.
3. The **Sign-in** screen sets up Cloudflare Access; then Topics and people,
   Template, Model key, Timer, Backup and Health.

**Updates need a click.** A new release does not redeploy the app by itself:
open the app in DigitalOcean and choose **Actions -> Force Rebuild and
Deploy** (see [`docs/operations.md`](docs/operations.md#updates)).

## Quick start with Claude Code

```
git clone https://github.com/imagicrafter/quantabase.git
cd kb-engine
claude
```

Then say:

```
set up the engine
```

Claude Code loads the `kb-engine-setup` skill and leads you through it: what
to create, which command it is running and why, and where you need to click.
It never asks you for a password or a key; you type those into a local file
or your hosting dashboard yourself.

Prefer to read first? [`SETUP.md`](SETUP.md) is one page.
[`docs/build-manual.md`](docs/build-manual.md) is the long form.

## The Claude plugin

Each person feeds their own Engine from their own Claude. In Claude Code:

```
/plugin marketplace add imagicrafter/quantabase
/plugin install qb-engine@quantabase
```

Its commands are `/qb-engine:ingest`, `/qb-engine:schedule-setup` and
`/qb-engine:send-session`. Then say "set up ingest". For the Claude app on Pro, Max or Team, see
[docs/plugin.md](docs/plugin.md).

## What it does

- **Pages in the database**, curated from your sources, with a nightly
  one-way backup to a private GitHub repository that opens as an Obsidian
  vault, and a one-time import of an existing wiki (`kbe pages import`).
- **Sources.** Fed from each person's own Claude (the plugin below). The
  Python pullers (a wiki repository, Google Drive, Fireflies, Gmail on a
  schedule) are an optional server mode, off by default.
- **Tagging at the source.** A document's topic comes only from a tag you
  can see and change where the document lives: a line at the top of a page,
  a note in a Drive file's or folder's description, a Fireflies channel.
  Nothing is guessed from a title or its text.
- **Access by topic.** You name the topics. You grant people topics. Every
  search is filtered in the database by the asker's grants. Anything
  untagged is indexed and visible to the owner only.
- **Sensitive topics.** A topic marked sensitive is never given to anyone
  automatically, administrators included.
- **Sign-in.** Cloudflare Access in front of your own hostname, with a code
  sent by email. One command (`kbe access setup`) has the app create the
  Cloudflare side for you from a single-use token that is never stored.
- **Review.** A person can approve a document's summary, ask for a new one,
  exclude the document or correct its topics. Approved documents rank
  higher.
- **A status page** for the owner, behind a second factor.
- **An issue log.** The Engine records its own failures and what people
  report from Claude, without document text or names.
- **Optional support access.** You can let a support person read the issue
  log and nothing else, and turn it off at any time.
- **A connector for Claude.** Add `https://<your hostname>/mcp` as a custom
  connector. Tools: `search`, `get_document`, `get_wiki_page`, `who_knows`,
  `report_issue`, and administrator tools for people and grants.

## How it is built

```
 your sources                     your DigitalOcean app            your Supabase project
 ┌──────────────────┐   daily    ┌──────────────────────┐         ┌────────────────────┐
 │ knowledge repo   │──────────▶ │ jobs, one per source │ ──────▶ │ database (1 schema)│
 │ Google Drive     │            │                      │         │ embed function     │
 │ Fireflies        │            │ service              │ ◀─────▶ │                    │
 └──────────────────┘            │  /mcp /status /setup │         └────────────────────┘
                                 └──────────▲───────────┘
                                            │ signed-in requests only
 you and your people ──▶ Claude ──▶ Cloudflare Access (code by email)
```

- The service reads the database only through functions that filter by who
  is asking. Its database role has no table access at all.
- The jobs can write and cannot delete.
- No secret is in this repository or in your knowledge repository.

More: [`docs/architecture.md`](docs/architecture.md).

## What it costs

No licence fee. You pay your own providers: one small DigitalOcean app and
its scheduled jobs, the model calls that write summaries, a Supabase
project, and Cloudflare Zero Trust (which has a free plan). Check each
provider's current pricing.

## Documentation

| | |
|---|---|
| [`SETUP.md`](SETUP.md) | One page to skim before you start |
| [`docs/manual.md`](docs/manual.md) | What the Engine is and how it behaves |
| [`docs/build-manual.md`](docs/build-manual.md) | The setup, step by step |
| [`docs/architecture.md`](docs/architecture.md) | The parts and the data flow |
| [`docs/configuration.md`](docs/configuration.md) | Every config key and environment variable |
| [`docs/roles.md`](docs/roles.md), [`docs/tagging.md`](docs/tagging.md) | Who sees what |
| [`docs/security.md`](docs/security.md) | Sign-in and the setup page |
| [`docs/operations.md`](docs/operations.md) | Health, updates, backups, removal |
| [`docs/care-plan.md`](docs/care-plan.md) | Optional support access |
| [`scripts/kbe/README.md`](scripts/kbe/README.md) | The `kbe` command line |
| [`CHANGELOG.md`](CHANGELOG.md) | Releases |

The full index is [`docs/README.md`](docs/README.md).

## Layout

```
engine/              the service (TypeScript)
pullers/             one job per source (Python)
scripts/knowledge/   the library the jobs use
scripts/kbe/         the kbe command line
supabase/            migrations, the embed function, SQL tests
config/              example config and its schema
setup/manifest.yaml  the setup phases and their checks
templates/           the starter knowledge repo
docs/                documentation
.claude/skills/      guided setup, administration and tagging for Claude Code
```

## Developing

```
python3 -m venv .venv && .venv/bin/pip install -r pullers/requirements.txt pytest
PYTHONPATH=scripts:. .venv/bin/python -m pytest scripts pullers -q --ignore=scripts/knowledge/access_test.py
cd engine && npm ci && npm test
```

## Status

Version `1.0.0-rc.1`, a release candidate. Known limits are listed in
[`CHANGELOG.md`](CHANGELOG.md) and in
[`docs/manual.md`](docs/manual.md#10-known-limits).

## Security

To report a vulnerability, use GitHub's private reporting on this
repository (the **Security** tab, **Report a vulnerability**). See
[`SECURITY.md`](SECURITY.md). Please do not open a public issue.

## Licence

MIT. See [`LICENSE`](LICENSE).
