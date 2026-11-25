---
name: kb-engine-tagging
description: Audit how documents in a kb-engine are tagged, propose topics for untagged items, and write approved tags back to the wiki, Google Drive or Gmail. Use when the owner asks "what is untagged", "tag my Drive / wiki / mail", "why can't X see this document", "fix unknown tags", or wants Claude to suggest topics. Always shows the proposal file and gets a clear yes before anything is written.
---

# kb-engine tagging

A document's topics decide who can see it. Topics come only from tags at the
source (see `docs/tagging.md`). This skill finds what is untagged or mistagged
and helps the owner fix it. **You never write a tag without the owner's yes.**

Run every command from the repo root with `PYTHONPATH=scripts:.`. Read
`CLAUDE.md` first; its rules apply here.

Tags at the source apply to items the Engine's server-mode jobs read
(`docs/tagging.md`). Items a person's Claude hands over through the plugin's
`ingest` skill are that person's own until the curator files them into
pages; this skill does not tag them.

## Rules

1. `apply` without `--write` is a dry run. Always run the dry run first.
2. Before any `--write`: show the owner the proposal rows that are `ready`
   (source, item, topic) and ask for a yes. A yes covers that file only. If
   the file changes, show it again.
3. Never put a sensitive topic into `proposed` yourself. If the owner wants
   one, they say so for the specific items, and you repeat it back first.
4. Never add a second topic to an item to "be safe": more topics means more
   people can see it. When unsure, leave `proposed` empty.
5. Never edit the Engine config, grant access, or commit to the knowledge
   repo as part of tagging unless the owner asks for that separately.
6. Do not print document bodies. Titles and ids are enough.

## Procedure

### 1. Audit

```
python -m kbe tags audit
python -m kbe tags audit --source <wiki|drive|fireflies|gmail>
```

Tell the owner, per source: how many are tagged on the item, by a folder or
channel, by the source default, untagged, and with an unknown tag.

### 2. Fix unknown tags first

An unknown tag is usually a typo. List them (`unknown_tag:<text>` shows what
was written) and ask the owner what each should be. These are fixed at the
source by hand, or by adding rows to a proposal file (step 4).

### 3. Prefer a container tag or a default over many item tags

If most untagged items in a Drive folder or a Fireflies channel belong to one
topic, suggest tagging the folder (its Description) or the channel (its name,
or `sources.fireflies.channels` in the config). That is one change the owner
makes at the source; say exactly what to type, for example `kx/consulting`.

### 4. Propose topics for what is left

```
python -m kbe tags suggest --source <source> --out proposals.csv
```

This writes a CSV only. Read it, then show the owner a short table: title,
proposed topic, reason. Point out rows with no proposal. Let the owner change
any row; edit the `proposed` column for them when they tell you to.

### 5. Dry run

```
python -m kbe tags apply proposals.csv --wiki-root <path to the knowledge clone>
```

Show the output: what is `ready`, what is `skip` and why.

### 6. Ask, then write

Ask: "Write these N tags?" and wait for a yes. Then:

```
python -m kbe tags apply proposals.csv --wiki-root <path> --write
python -m kbe tags apply proposals.csv --drive-token <drive sign-in file> --write
python -m kbe tags apply proposals.csv --gmail-token <gmail sign-in file> --write
```

- Wiki: pages change in the local clone only. Show `git diff --stat` there and
  let the owner commit and push.
- Drive and Gmail need a sign-in file made once with
  `python -m kbe tags authorize --source <drive|gmail> --client-secret <OAuth client file> --out <sign-in file>`.
  The owner runs this; it opens a browser. Never read or print that file.
- Fireflies rows are skipped by design: tag the channel or the meeting page.

### 7. Confirm

Tags take effect on the source's next pull. After it, run the audit again and
report the new counts.

## If something fails

- `Has migration 0031 been applied?` The database is behind the code; stop
  and tell the owner.
- A row shows `failed`: nothing else was changed for that row. Report the
  note as written and do not retry with a different topic.
