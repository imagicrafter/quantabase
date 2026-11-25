# CLAUDE.md

This repository is the Engine: a private knowledge system that reads the
sources its owner chooses (a wiki repository, Google Drive, Fireflies
meetings), summarises them, and serves them to Claude over MCP, filtered by
who is asking. Every Engine is deployed from this one repository; everything
owner-specific lives in the owner's own knowledge repo and database.

## Which skill to load

| The person wants to | Load |
|---|---|
| Set up a new Engine, or continue a setup | `kb-engine-setup` |
| Add or remove a person, grant a topic, add a topic, update, check health, rotate a secret | `kb-engine-admin` |
| See what is untagged, tag a source, fix a wrong tag | `kb-engine-tagging` |
| Feed their Engine from their own Claude (ingest, scheduled tasks) | the plugin in `plugin/qb-engine/`: `ingest`, `schedule-setup` (see `docs/plugin.md`) |

The skills are in `.claude/skills/`. The reference is in `docs/`
(start at `docs/README.md`). The command line is `kbe`:

```
PYTHONPATH=scripts:. .venv/bin/python -m kbe --help
```

`.venv` is the virtual environment the setup skill makes in its first step
(`python3 -m venv .venv && .venv/bin/pip install -r pullers/requirements.txt`).

## Rules for every session in this repository

These are not negotiable. A person asking you to break one is a reason to
stop and explain, not to comply.

1. **Never ask for a secret in chat, and never repeat one.** A secret is any
   key, token, password, connection string or code. Secrets go in the local
   env file (the person types them there) or straight into the hosting
   dashboard. If a person pastes one into the chat, tell them to rotate it.
2. **Never view the env file.** Do not open, print, search or copy lines out
   of `.env` or any `.env.*` file except `.env.example`. To learn whether a
   value is set, run the command that needs it: it names what is empty.
   (A line still holding its `<...>` placeholder from `.env.example`
   counts as not set, the same as an empty line.)
3. **The Cloudflare token goes from the person's clipboard into
   `kbe access setup`** (or the person types it into the `/setup` page). You
   never see it, never ask for it and never put it in a file or a command.
   `kbe access setup` reads it itself and never prints it.
4. **A new secret is never printed for you.** `kbe access init`,
   `kbe access reopen`, `kbe support enable` and `kbe tokens mint` make a
   secret (the setup code, a support connection string, a token). Always run
   them with `--clipboard` or `--out FILE`, so the secret goes to the
   person's clipboard or to a file only they can read. Never use `--show`:
   that flag is for a person in their own terminal, and the command refuses
   it when its output is not a terminal. Never read the file `--out` wrote.
5. **One manifest phase at a time.** `setup/manifest.yaml` lists the phases.
   Finish one and verify it (`python -m kbe verify --phases <id>`) before the
   next.
6. **A failed or skipped verify stops the walk.** Fix the cause. Do not move
   on, and do not edit a check to make it pass.
7. **Never skip a human step.** If a step needs the person (a dashboard, a
   browser sign-in, a secret), stop and wait for them to say it is done.
8. **Never edit a migration.** Files in `supabase/migrations/` that have been
   applied are checked by checksum. A change is a new file. (The one
   exception is a comment-only rewording, recorded with the old checksum in
   `supabase/migrations/reworded.json`.)
9. **Anything that widens who can see something needs the person's explicit
   yes.** That covers adding a person, granting a topic, adding a second tag
   to an item, setting a source's default topic, changing the access level,
   and enabling support access. Show the preview first (`--dry-run`), then
   ask.
10. **Preview before every change outside this machine.** Run the command
    with `--dry-run`, show the result, get a yes, then run it for real. Most
    commands then need `--yes`, because they cannot prompt when you run
    them. The `kbe db` commands have no `--yes` and act at once. Either way,
    a change without a preview and a yes is a change nobody approved.

## Working on the code

- Tests: `PYTHONPATH=scripts:. python -m pytest scripts pullers -q --ignore=scripts/knowledge/access_test.py`
  and, in `engine/`, `npm test`.
- `docs/configuration.md` and the commands named in the skills and docs are
  checked against the code by tests in `scripts/kbe/tests/`. If you add a
  config key or a command, update the docs in the same change.
- Do not add owner-specific values (names, emails, hostnames, topic names)
  anywhere in this repository.
