# Tagging: who can see what

> **Items fed by the plugin** (the `ingest` skill) get their topics from
> tags you switch on in Quantabase, not from `kx/` names declared in the
> config: see [source-tags.md](source-tags.md). This page describes the
> pullers (wiki, Drive, Fireflies jobs) and the config-declared topics they use.

Every document in the Engine has one or more **topics** (called `domains` in
the config and the database). A person sees a document only if they have been
granted one of its topics.

Topics are decided **only by tags you can see and change at the source**. The
Engine never guesses a topic from a title, a file name, a folder name or the
text of a document.

## The order

For each item the Engine looks for a tag in this order and stops at the first
place that has one:

| # | Where | Example |
|---|---|---|
| 1 | **On the item itself** (content tag) | a page's frontmatter, a file's description, a mail label |
| 2 | **On what holds it** (container tag) | a Drive folder, a Fireflies channel. The nearest one wins. |
| 3 | **The source's default topic** | `sources.drive.default_domain` in the config |
| 4 | **`unclassified`** | nothing matched |

`unclassified` is a real topic. It is sensitive and only the owner has it, so
an untagged item is still indexed and searchable by the owner, and invisible
to everyone else.

## What a tag looks like

A tag is `<prefix><topic id>`. The prefix is `tagging.prefix` in the config
(default `kx/`), so the topic `consulting` is tagged `kx/consulting`. A source
may set its own prefix (`sources.gmail.prefix`). Upper or lower case does not
matter.

The topic id must be one declared under `domains:` in the config.

## How to tag, per source

### Wiki pages

Put the topic ids in the page's frontmatter, under the key named by
`tagging.frontmatter_key` (default `domains`). No prefix is needed here.

```yaml
---
title: Lease renewal checklist
domains: [properties]
---
```

A single value works too: `domains: consulting`. The free-form `tags:` key is
not read for access.

- **One page:** add the key to that page.
- **Every page:** set `sources.wiki.default_domain` in the config. Pages with
  their own key keep it.
- There is no folder-level tag for the wiki.

### Google Drive

Write the tag anywhere in the **Description** of a file or a folder (right
click, *File information*, *Details*, *Description*). Other text in the
description is fine: `Signed copies. kx/consulting`.

- **One file:** tag the file. A file's own tag beats any folder tag.
- **A folder and everything under it:** tag the folder. For a file in nested
  folders, the **nearest** tagged folder above it wins.
- **All of Drive:** set `sources.drive.default_domain`.

**Whose tags count.** By default a Drive tag counts only on a file or folder
that is **owned by the Google account the Engine signs in as**
(`sources.drive.trust_tags_from: owner`). Anyone who can edit an item can
edit its description, so without this rule a person who shares a file with
you could choose the topic it lands in.

- A tag on an item someone else owns is ignored, as if the description were
  empty. The next rule in the order then applies: a tagged folder of yours
  above it, else the source default, else `unclassified`.
- An item whose owner Drive does not report (for example a file in a shared
  drive) is treated as someone else's.
- Each document where a tag was ignored is marked `ignored_foreign_tag`, and
  `python -m kbe tags audit --source drive` shows how many there are.
- To make a shared item land in a topic, put it in a folder you own and tag
  that folder, or make a copy you own and tag the copy.
- **What the rule does not cover.** Drive lets an editor change the
  description of an item you own. A person you gave edit rights to can
  therefore change or remove a tag on your own file or folder, and the
  Engine cannot tell their edit from yours. Give edit rights on a tagged
  item only to people who may decide who sees it; give everyone else view
  or comment rights. `python -m kbe tags audit --source drive` shows how
  each item got its topic.
- `sources.drive.trust_tags_from: anyone` turns the rule off: every tag on
  every item the account can see counts. Use it only when everyone who can
  edit those items is allowed to decide who sees them.

### Fireflies meetings

- **A channel:** name the channel `kx/consulting`, or keep its name and list
  it in the config: `sources.fireflies.channels: { "Sales Calls": consulting }`.
  Every meeting in that channel gets the topic.
- **One meeting:** once the meeting has a page in the wiki, set `domains:` in
  that page's frontmatter. From then on **the page decides**, for the page and
  for the transcript, whatever the channel says. When a meeting is tagged by
  its channel, the Engine writes that topic into the new meeting page for you.
  It never overwrites a value already there, and it never writes a source
  default into a page.
- **All meetings:** set `sources.fireflies.default_domain`.

A meeting someone else recorded and shared with you never takes a topic from
*their* channel.

### Gmail

Put the label `kx/consulting` on the thread. The Gmail source is optional
and off by default (`sources.gmail.enabled`).

- **The label is the only way in.** A thread with no tag label is never
  listed, fetched or stored. Take the label off and the thread leaves the
  Engine at the next run.
- The prefix is `tagging.prefix`, or `sources.gmail.prefix` when you want
  mail labels to look different.
- Only labels a person made count. A system label is never a tag.
- A label that names no topic makes the thread `unclassified`, as for every
  source.
- A tag decides the topic. It does not make a thread visible by itself: a
  thread is shown to people other than the mailbox's owner only after it is
  approved. See [security.md](security.md#9-mail-the-gmail-source).

## Several tags

Several valid tags in the same place give the item several topics:
`domains: [consulting, properties]`, or `kx/consulting kx/properties` in a
description. Anyone with **either** topic can see it, so add a second tag only
when you mean to widen the audience.

## Untagged items and wrong tags

- **Untagged:** the item is `unclassified` (owner only).
- **Unknown tag:** a tag that names a topic the config does not declare (a
  typo such as `kx/consluting`, or a topic that was removed). The item becomes
  `unclassified` and is recorded with an `unknown_tag` signal. This holds even
  if another tag in the same place is valid, and even if a folder further up
  has a good tag: a mistake never falls through to a wider audience.
- **A tag for a sensitive topic** is honoured. It is your deliberate act.
- **A tag that cannot be read** is treated as an unknown tag, never as "no
  tag": a wiki page whose frontmatter block is not closed (or starts with a
  byte-order mark), or a `domains:` value that is not a list of ids.
- **A Drive file the Engine cannot place** is `unclassified`: a folder above
  it is missing from the listing (`folder_chain_incomplete`), or it sits in
  several folders whose tags differ (`ambiguous_folder`). The source default
  is only used when the whole folder path up to My Drive was seen.
- **A meeting whose wiki page may belong to another recording** (same title,
  same day) takes that page's topic only if its own channel agrees; otherwise
  it is `unclassified` (`ambiguous_page`).

Each document records how it was decided (`tag_source`: `content`,
`container`, `source_default` or `default`) and what was read (`tag_signals`).

To see where you stand:

```
python -m kbe tags audit            # every source
python -m kbe tags audit --source drive
```

It prints, per source, how many documents were tagged each way, then lists the
untagged ones and the ones with an unknown tag, and for Drive how many
documents had a tag ignored because the item is not the owner's.

While any document of a source carries an unknown tag, the issue list holds
one open issue for that source (category `unknown_tag`). It gives a count and
the unknown tag texts, never a document title. It closes by itself on the
first run after the last such tag is fixed.

A changed tag takes effect the next time that source is pulled.

## Have Claude propose tags

Three steps. Nothing is written to a source until you say so.

1. **Propose.** The model reads each untagged item and proposes one topic from
   your config. It is never offered a sensitive topic.

   ```
   python -m kbe tags suggest --source drive --out proposals.csv
   ```

   This writes `proposals.csv` (`source, external_id, title, current, proposed,
   reason`) and nothing else.

2. **Review.** Open the file. Change `proposed` where the model is wrong, clear
   it to leave an item alone, or type a sensitive topic yourself. Then preview:

   ```
   python -m kbe tags apply proposals.csv --wiki-root <your knowledge clone>
   ```

   This is a dry run. It lists what would be written and what is skipped, and
   why.

3. **Apply.** Add `--write`.

   ```
   python -m kbe tags apply proposals.csv --wiki-root <your knowledge clone> --write
   python -m kbe tags apply proposals.csv --drive-token <drive sign-in file> --write
   ```

   - **Wiki:** the frontmatter key is written into the pages of your local
     clone. Nothing else in the file changes and nothing is committed: look at
     `git diff`, then commit and push yourself.
   - **Drive:** the tag is added to the file's description. This needs its own
     sign-in with permission to edit descriptions; the Engine's own Drive
     access stays read-only. Create the sign-in file once with
     `python -m kbe tags authorize --source drive --client-secret <OAuth client file> --out <drive sign-in file>`.
   - **Gmail:** the label is created if needed and put on the thread, and a
     tag label for a different topic is taken off (`--gmail-token`, created
     the same way with `--source gmail`). Other labels are left alone.
   - **Fireflies:** not written by this tool. Tag the channel, or the
     meeting's wiki page.

In Claude Code, the `kb-engine-tagging` skill walks through these steps and
always shows you the file before anything is written.

Related pages: [roles.md](roles.md) (topics and grants) and
[configuration.md](configuration.md) (the `tagging` and `sources` keys).

## For developers

- Resolver: `scripts/knowledge/tag_resolver.py` (pure; `resolve(source,
  content_tags, container_tags, config)`).
- Readers: `scripts/knowledge/tag_sources/{wiki,drive,fireflies,gmail}.py`.
- Drive tag trust: `scripts/knowledge/connectors/drive_topics.py`
  (`apply_tag_trust`). The unknown-tag issue: `pullers/tag_issues.py`.
- Stored as `workspace.documents.tag_source` / `tag_signals` (migration
  `0031`); `workspace.tagging_health(email)` returns the per-source counts.
- A model may narrow a document's topics later (`labels.arbitrate`), never
  widen them.
