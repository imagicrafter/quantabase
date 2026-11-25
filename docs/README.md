# Documentation

Start with the page that matches what you are doing.

| I want to | Read |
|---|---|
| Understand what the Engine is and how it behaves | [manual.md](manual.md) |
| Skim what a setup involves before starting | [../SETUP.md](../SETUP.md) |
| Set one up, with every step explained | [build-manual.md](build-manual.md) |
| Have Claude Code lead me through the setup | The `kb-engine-setup` skill: open this repository in Claude Code and say "set up the engine" |
| See the parts and how data moves between them | [architecture.md](architecture.md) |
| Look up a config key or an environment variable | [configuration.md](configuration.md) |
| Decide who sees what | [roles.md](roles.md) and [tagging.md](tagging.md) |
| Understand sign-in and the setup page | [security.md](security.md) |
| Check health, update, back up, restore, remove | [operations.md](operations.md) |
| Give a support person access to the issue log | [care-plan.md](care-plan.md) |
| Feed my Engine from my own Claude, install the plugin, schedule ingest | [plugin.md](plugin.md) |

## All pages

| Page | What it covers |
|---|---|
| [manual.md](manual.md) | What the Engine is, how knowledge flows in and out, the layers, review and approval, what it guarantees, known limits, glossary |
| [build-manual.md](build-manual.md) | The setup in long form: one chapter per phase of `setup/manifest.yaml` |
| [architecture.md](architecture.md) | Components, what runs where, data flow, the database roles, where each setting lives |
| [configuration.md](configuration.md) | Every key of `engine.yaml` and every environment variable |
| [operations.md](operations.md) | Health, the issue log, updates, backups, restoring, removing a deployment |
| [roles.md](roles.md) | Reader, reviewer, administrator, owner; topics and grants |
| [tagging.md](tagging.md) | How a document gets its topics, per source |
| [source-rules.md](source-rules.md) | Inclusion rules: what Gmail and Fireflies ingest keeps, per person and account; the Sources screen; who sees whose rules |
| [source-tags.md](source-tags.md) | Labels, folders and channels found at ingest (the rule picker; Drive topics); the provider interface for adding a source |
| [templates.md](templates.md) | The entity template YAML: drawers, keys, signals, links, required patterns |
| [security.md](security.md) | Sign-in, setup mode, the setup page, the Cloudflare token, what is and is not verified against a live account, source text and the model, mail |
| [care-plan.md](care-plan.md) | Optional read-only support access to the issue log |
| [plugin.md](plugin.md) | The Claude plugin: ingest skill, scheduled tasks, install on Pro and Team, the A4 test |

## Elsewhere in the repository

| File | What it is |
|---|---|
| [`../README.md`](../README.md) | What the product is, a quick start, the feature list |
| [`../CLAUDE.md`](../CLAUDE.md) | The rules a Claude Code session follows here |
| `../.claude/skills/` | The guided setup, administration and tagging skills |
| [`../scripts/kbe/README.md`](../scripts/kbe/README.md) | The `kbe` command line, command by command |
| [`../setup/manifest.yaml`](../setup/manifest.yaml) | The setup phases and the checks `kbe verify` runs |
| [`../config/engine.example.yaml`](../config/engine.example.yaml) | An example config |
| [`../engine/deploy/cloudflare-access-setup.md`](../engine/deploy/cloudflare-access-setup.md) | Setting up the Cloudflare side by hand |
| [`../CHANGELOG.md`](../CHANGELOG.md) | What changed in each release |
| [`../SECURITY.md`](../SECURITY.md) | How to report a vulnerability |

## Checked against the code

Two tests keep these pages from drifting:

- `scripts/kbe/tests/test_docs_configuration.py`: the config keys and
  environment variables in `configuration.md` match the schema and the
  example files.
- `scripts/kbe/tests/test_docs_commands.py`: every `kbe` command and flag
  named in the manifest, the skills and these pages exists in the tool.
