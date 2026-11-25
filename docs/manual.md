# The Engine: owner's manual

What the Engine is, how knowledge gets into it and out of it, who can see
what, how review works, what the Engine guarantees, and where its limits are.

Related pages: [architecture.md](architecture.md) (the parts),
[build-manual.md](build-manual.md) (setting one up),
[configuration.md](configuration.md) (the config file),
[operations.md](operations.md) (running it), [roles.md](roles.md),
[tagging.md](tagging.md), [security.md](security.md) and
[care-plan.md](care-plan.md).

Commands in this manual run from the repo root with `PYTHONPATH=scripts:.`.

## 1. What the Engine is

The Engine is a private, searchable index of one owner's knowledge, with a
connector that lets Claude search it on behalf of a signed-in person.

It has four parts:

- **Sources.** The places knowledge already lives: a private git repository of
  markdown pages (the knowledge repo, also called the wiki), Google Drive, and
  Fireflies meeting notes. A Gmail source is optional and off by default; it
  reads only the threads of one mailbox that carry a tag label.
- **Pullers.** One scheduled job per enabled source. Each job runs once a day,
  reads what changed, and writes it to the database.
- **The database.** A Postgres schema (named by `KB_SCHEMA`, default
  `workspace`) that holds raw captures, documents, people, topic grants,
  review state, settings and an issue log.
- **The service.** A small web service that answers on one hostname, for
  example `engine.example.com`. It serves the connector at `/mcp`, the status
  page at `/status` and the one-time setup at `/setup` (run for you by
  `python -m kbe access setup`, or by hand as a page in a browser).

The sources stay authoritative. The documents table is a derived index: it can
be rebuilt from the sources and the raw captures.

Each person signs in through Cloudflare Access with a one-time PIN sent by
email. The service verifies that sign-in on every request and filters every
result by the topics granted to that person. See [security.md](security.md).

## 2. How knowledge flows in

```
sources --> raw captures --> documents ----------------> approved documents
            (bronze)         (silver: summary, vector)   (gold: a person said yes)
```

### 2.1 Sources

| Source | What is read | Config key |
|---|---|---|
| `wiki` | Markdown pages in the knowledge repo, in the folders `concepts`, `decisions`, `diagrams`, `meetings`, `people`, `projects`, `research`. `index.md`, `README.md` and `log.md` are skipped. | `sources.wiki` |
| `drive` | Google Docs, Sheets and Slides (`include_mime`). Read-only access. | `sources.drive` |
| `fireflies` | Meeting notes and transcripts. With `write_meeting_pages: true` the job also writes a page for each meeting into the knowledge repo. | `sources.fireflies` |
| `gmail` | Optional. Off by default. | `sources.gmail` |

These are the server-mode sources. The plugin also hands items over with
`record_source_item` (Gmail, Drive, Fireflies, Calendar on a schedule, and
Claude Code session notes by hand; see 2.6 and [plugin.md](plugin.md)).

A source is on when `enabled: true` is set for it in the config.
`python -m kbe deploy render --server-mode` writes one scheduled job per enabled source (server mode; without it the app is the service alone, see `docs/operations.md`, "Server mode").
`python -m kbe sources list` shows the enabled sources and each one's last
run.

### 2.2 What one pull does

Every source goes through the same steps (`pullers/runner.py`):

1. **Gate.** If sign-in has not been set up, the job stops without reading
   anything. Nothing is indexed before someone has decided who may sign in.
2. **Lock.** One run per source at a time. A second run stands down.
3. **Config.** The wiki job checks `.kb-engine/engine.yaml` on the knowledge
   repo's main branch. If it changed and is valid, it is applied before any
   page is read. See section 8.
4. **Fetch.** The job reads the source from where the last run stopped.
5. **Build documents.** Each item becomes one document: a wiki page, a Drive
   file, a meeting. Its topics are decided here, from tags only. See
   [tagging.md](tagging.md).
6. **Raw capture.** For Drive and Fireflies, the text is saved to the raw
   captures table.
7. **Write.** New and changed documents are written. Unchanged ones cost
   nothing. A document whose embedded text changed gets a new vector.
8. **Deletions.** For the wiki and Drive, a document that is no longer at the
   source is marked deleted (`deleted_at`) and stops appearing in results. The
   row is kept.
9. **Review decisions.** Decisions waiting from earlier review sessions are
   applied.
10. **Summaries.** Up to 40 documents per run are summarised by the model. See
    2.4.
11. **Review queue.** Newly summarised documents are added to a review batch.
    See section 6.
12. **Record.** The position reached and the result of the run are saved.

A failed run changes nothing in another source. It is recorded, and it opens
an issue in the issue log. A short outage (HTTP 502, 503, 504 or a timeout)
opens an issue only when it happens twice in a row. The next clean run closes
the issue.

Two safety rules apply to step 8:

- If a run would mark more than 10% of a source's live documents as deleted,
  it writes nothing and fails. This catches a source that returned less than
  it should have.
- Fireflies and Gmail never mark documents deleted because they are absent
  from a fetch.

### 2.3 Bronze: raw captures

Table `raw_captures`. One row per version of a fetched item's text, for
`drive`, `fireflies` and `gmail`.

- It is append-only. The pullers' database role may insert and read. It may
  not update or delete.
- The same text fetched again adds no row. Changed text adds a new row.
- The wiki is not captured here. The knowledge repo's git history is its raw
  layer.

### 2.4 Silver: documents

Table `documents`. One row per document. A long wiki page (above roughly 1,500
tokens) also gets one row per `##` section, linked to the page.

Each document holds three texts:

| Text | Used for |
|---|---|
| `title` | Shown in results; part of both searches |
| `body` | The full text. Keyword search runs over title and body. |
| `distillation` | A short summary. The title and the distillation are what get embedded. |

**Distillation.** When a document is first written, the source connector fills
`distillation` with a placeholder built from the document itself. A model then
writes a real summary for the documents that pass a set of fixed rules.

A document is skipped when any of these is true:

- it is a section of a larger page;
- it already has a summary for its current content;
- its title marks it as a placeholder, a copy or a test file (for example
  `Untitled`, `Copy of`, `Backup of`);
- its body is shorter than 400 characters;
- a reviewer excluded this exact content;
- another document has byte-identical content (one of them is summarised).

The summary has a **what** sentence, a **why** sentence or two, and **key
terms**: names, identifiers, amounts and dates a person might type.

Every key term must appear word for word in the source text. A term that does
not is dropped. If more than half of the proposed terms are missing from the
source, the whole summary is rejected and nothing is written.

The model that writes summaries is set by `models.distill` in the config.

**The model and topics.** The model may also propose a topic. Its proposal can
only narrow a document's topics to one of the topics the tags already gave it.
It can never add a topic. When the model disagrees with the tags, the topics
stay as they were, the document is marked `model_proposed`, and it goes to the
front of the review queue.

**Embedding.** The title and distillation are turned into a 384-number vector
by the `gte-small` model, which runs in the `embed` edge function in the same
database project. The query is embedded the same way at search time.

**Tier.** Each document has a tier from 1 to 4, set by the source:

| Tier | What gets it |
|---|---|
| 1 | A wiki page with a `verified:` value in its frontmatter |
| 2 | Other wiki pages; Drive files |
| 3 | Meetings (wiki `meetings` folder, Fireflies); Gmail threads |
| 4 | The default for anything else |

Tier is a ranking factor (4.3).

### 2.5 Gold: approved documents

A document starts as `unreviewed`. A person can approve it in the review loop
(section 6). Approved documents rank higher, and a search can ask for approved
documents only.

There is no separate gold table. Gold is the set of documents whose
`review_status` is `approved`. Section 3 lists the layers side by side.

### 2.6 Sending a Claude Code session

At the end of a Claude Code session worth keeping, run
`/qb-engine:send-session`. Claude writes a short **session note**: what is
new, as items labelled `decided`, `fact`, `status`, `how-to` or `idea`, each
with 1 to 3 exact quotes from the session and hints about which of your pages
it concerns (found with the Engine's `search` and `find_entity`). A bundled
script checks the quotes word for word against the session and cuts
anything that looks like a secret; you see the whole note and say yes; one
`record_source_item` call sends it as source `claude-code` (item id = the
session id, the project folder as a `project` tag). Nothing is filed under a
topic: a note stays yours unless an administrator files its project under
one. If you set a notes folder (`save_dir`, which may hold `{week}`), a copy
of the approved note is also saved there as markdown.

The curator keeps a note (the Desk editor almost never sets one aside),
reads the hinted pages first, writes ideas as ideas, and fact-checks new
sentences against the note's quotes. Details:
[plugin.md](plugin.md#sending-a-claude-code-session).

## 3. The layers

| Layer | Where | What it holds | Who writes it |
|---|---|---|---|
| Bronze | `raw_captures` (and git, for the wiki) | Source text as fetched | Pullers, insert only |
| Silver | `documents`, `review_status = unreviewed` | Title, body, summary, vector, topics, tier | Pullers |
| Gold | `documents`, `review_status = approved` | The same row, approved by a person | The review loop |

Two more statuses, `excluded` and `rejected`, remove a document from results.

## 4. How knowledge flows out

### 4.1 The connector

The connector is an MCP server at `https://<host>/mcp`, for example
`https://engine.example.com/mcp`. A person adds that address as a custom
connector in Claude and signs in with the one-time PIN.

On connect, Claude receives a short text built from the config: the Engine's
name, the enabled sources, and the labels of the topics that are not
sensitive. Sensitive topics are counted and not named.

The service's database role can run a fixed list of functions and can read
no table.

### 4.2 The tools

For everyone:

| Tool | Arguments | Returns |
|---|---|---|
| `search` | `query`; `match_count` (1 to 50, default 10); `require_approved` (default false) | Ranked results: id, title, source, link, topics, tier, review status, distillation, a snippet (the first 400 characters of the distillation), score |
| `get_document` | `id` | The full body and metadata of one document |
| `get_wiki_page` | `title_or_path` | Up to 5 wiki pages whose title or path contains the text, with full body. An exact title match comes first. |
| `who_knows` | `topic` (a free-text subject) | People named as author or participant in matching documents, with a count and the documents as evidence. See Known limits. |
| `report_issue` | `category`, `title`, optional `detail` | Logs a problem in the issue log. 10 reports per person per hour. |
| `get_entity_schema` | optional `templates` (default `solo`) | The drawers pages are filed in (the eight base drawers plus each named template's), with key rule, fields, sections, signals, update rules and list views |
| `find_entity` | `query`; optional `drawer`, `limit` | Pages whose key, alias or title is exactly the text. One entry per key, your own page first, with header, body and `content_hash` |
| `list_entities` | `drawer`; optional `filter`, `sort`, `desc`, `limit` | One entry per key in a drawer. Counts keys, not pages; a field two pages disagree on shows both values and is listed under `conflicts` |
| `related` | `key`; optional `limit` (default 10) | Pages one link away (out-links and backlinks) with the reason |
| `save_page` | `drawer`, `key`, `title`; optional header fields, `body`, `expected_hash` | Creates or replaces one of your own pages. Replacing needs `expected_hash` |
| `update_page` | `key`, `patches`; optional header changes | Small edits to your own page: `append-bullet`, `append-paragraph`, `replace-line`, `new-section-after` |
| `record_source_item` | `source` (`gmail`, `fireflies`, `drive`, `calendar`, `claude-code`), `source_id`, `body`; for Gmail and Fireflies `account` and `provider`; optional `title`, `cursor`, `metadata`, `tags` (Drive folders; the project for `claude-code`); for `claude-code` a `note` (the session note) instead of `body` | Stores one raw item as yours, untrusted, versioned by id and text hash, if your inclusion rules for that account include it ([source-rules.md](source-rules.md)); the Engine sets the topic. `topics` and `owner` are ignored. Otherwise `not_included` and nothing is stored |
| `get_ingest_plan` | `source` (`gmail`, `drive`, `fireflies`, `calendar`); `account` for Gmail and Fireflies | Your cursor for that source account, `since`, `max_items`, and how to fill `record_source_item`; for Gmail and Fireflies your rules and a query narrowed by them. Stores no source text. Used by the plugin's `ingest` skill ([plugin.md](plugin.md)) |
| `report_ingest_candidates` | `source`, `account`; optional `labels`/`channels` (+ `_complete`), `candidates` | Reports an account's labels or channels (the rule builder's picker; a label missing from a complete list makes its rules broken) and a metadata-only sample for the dry-run. No subject or text |
| `get_source_item` | `id` | One of your own raw items; its text only inside `content.untrusted_source_text` |

Pages are owned by one person each. Writes only ever change the caller's own
pages and items, and only under topics the caller holds. A page is visible
to its owner and to an active person holding one of its topics. Every save
that changes a page writes a history version, rewrites its links and queues
its summary (written by the curator, below). `search` also
returns pages (`entities`, one per key, own page first) and up to ten
`related` pages.

### The curator

The curator runs inside the service. It turns raw items (handed over with
`record_source_item`) into page changes, using a DigitalOcean serverless
inference model. It has no connectors: it works only on rows already in the
Engine, through database functions granted to the service alone. It is off
until `curator_settings.enabled` is set, and it needs the model key in the
vault (see [operations.md](operations.md#the-curator-timer)).

For each item not yet curated, oldest first:

1. **Screen.** Text that looks written to steer an AI (chat role tags,
   "ignore previous instructions", text addressed to "AI assistant:") holds
   the item. It waits for its owner to release it; the model never sees it.
   Everything from a released item still waits for a yes.
2. **Match.** Pages are matched by key first (email addresses and web
   domains in the item's headers and metadata, a meeting id), then by keyword.
   Only the item owner's own pages are looked at, and only pages whose topics
   all belong to the item: a private mail is never folded into a page shared
   more widely. A new page gets exactly the item's topics.
3. **Ask.** The model gets the shortlist and the item. The item's text is
   inside a delimited block marked as quoted data. The answer is small
   patches (`append-bullet`, `append-paragraph`, `replace-line`,
   `new-section-after`), field values, links (`related`) and new pages.
   One item is filed on every entity it is really about, not just one: the
   person (key = email), their organisation (key = domain), and the project
   and/or deal, each matched by key first, updated with dated lines and
   linked to each other (at most 6 updates and 4 new pages per item). A link
   may only point at a page on the shortlist or one made in the same reply.
   Every added line starts with the item's date and says why.
4. **Check.** Anything outside that shape is refused and the item is tried
   again later (three tries by default): an unknown page or field, a value
   not allowed by the drawer, an undated line, a patch that does not apply,
   text copied from another page, a cut-off reply.
5. **Apply or queue.** Changes are saved on their own, including new deal,
   offer, program and property pages and stage or value changes; every save
   is a version in the page's history, so any of it can be undone there. A
   change waits in `curator_reviews` for the owner's yes only in extreme
   cases: it comes from an item the steering screen flagged and a person
   released; it would remove or replace 40% or more of an existing page's
   text, or a whole section; or it would overwrite, with a different value,
   a field a person set by hand in the app's edit form (recorded in the
   page's `verified` list). A template may still opt a drawer in with
   `update_rules.needs_yes` or `curator: { new_page: needs_yes }`; the
   shipped templates do not. Approved changes are applied on the next run.
6. **Close.** The item is marked curated with the pages it touched. Each
   touched page lists the item in `sources`, so a run cut short and repeated
   never patches a page twice. An older version of an item that has a newer
   one is closed as `superseded`.

**Names on pages.** Pages are written from the owner's side and say who did
what. The curator calls the owner by their **name used on pages** ("Ann
decided to ...", "Ann sent Pat the SOW"), never "the owner", and calls other
people with an account by theirs. First-run setup asks for it ("What should
your pages call you?"); change it under **Staff & settings > People**, card
**Your name** (`/setup/people`). Empty means your display name, unless that is
an email; with no name at all the curator falls back to writing from the
owner's side without naming them. A session note keeps "Owner:" on its
quotes (it is written before the Engine is asked); the curator is told that
"Owner" there is the owner's name, and the fact check accepts the name for
what the owner said or did. Changing the name does not reword pages already
written: ask Claude to fix those pages with `update_page`.

After the items, the curator writes the summary of every page marked
"summary needed" (any save, by a person or the curator), embeds it with the
same embed function search uses, and clears the mark. A page saved again in
the meantime keeps its mark and is summarised on the next run.

`report_issue` categories are `data_quality_issue`, `feature_gap` and
`friction_point`. The title is 5 to 120 characters and the detail is at most
1,000.

For administrators only:

- `admin_list_people`: every person, with role, active or not, and topics.
- `admin_add_person`: adds a reader, reviewer or administrator.
- `admin_grant_topic` and `admin_revoke_topic`: give or take away one topic.
- `admin_deactivate_person`: removes all of a person's access.
- `admin_reactivate_person`: gives a deactivated person their access back,
  with the role and topics they had. The preview lists both.
- `admin_list_issues`: the open issues of this Engine (id, category, source,
  title, status, when it opened, how often it was seen) and the number fixed
  in the last 30 days. Read-only.
- `list_tickets`: the Pipeline tickets (see 7.1), open ones by default, or
  closed or all. Read-only.
- `get_ticket`: one ticket by its id, such as `QB-0012`, with its notes.
  Read-only.
- `add_ticket_note`: adds a note to a ticket, under your name. Claude asks
  you first. It cannot close a ticket: only a person closes one, in the app.

The five tools that change something work in two steps. The first call
returns a preview and a one-time confirmation code and changes nothing. Claude
shows the preview and waits for an explicit yes. The second call sends the
same arguments with the code and makes the change. A code works once, for 10
minutes, for that administrator and those exact arguments. See
[roles.md](roles.md).

The admin tools are listed only for administrators. The database checks the
caller on every call, whatever the list shows.

### 4.3 How search ranks

`search` runs two searches over the documents the caller may see and merges
them.

1. **Meaning.** The query is embedded and compared with each document's
   vector. The 200 nearest are kept.
2. **Wording.** The query is matched against title and body as a keyword
   search and scored with BM25. The 200 best are kept. Quoted phrases and
   `-word` exclusions work.
3. **Merge.** The two lists are merged by position (reciprocal rank fusion,
   constant 60). A document found by both searches scores higher than one
   found by a single search.
4. **Weights.** The merged score is multiplied by four factors:

| Factor | Value |
|---|---|
| Age | Halves every 365 days, counted from the document's date at the source |
| Exact wording | Up to 1.5, by how closely the query's words match |
| Tier | 1.30 for tier 1, 1.15 for tier 2, 1.00 for tier 3, 0.85 for tier 4 |
| Approval | 1.25 if the document is approved, 1.00 otherwise |

5. **One row per page.** When several sections of the same page match, the
   best one is kept.
6. **Cut.** The top `match_count` results are returned.

Deleted, excluded and rejected documents are never returned. With
`require_approved: true`, only approved documents are searched.

### 4.4 The access filter

Every document carries one or more topics. Every person has a set of topics.
A person sees a document when the two overlap.

- The person's topics are worked out inside the database from their verified
  sign-in. No tool takes a list of topics as an argument.
- A reader's set is exactly their grants.
- An administrator's set is every topic that is not sensitive, plus any
  sensitive topic granted to them.
- A person who is unknown or deactivated has an empty set. An empty set
  returns no rows.
- `search`, `get_document`, `get_wiki_page` and `who_knows` all use the same
  filter. `who_knows` counts only documents the caller can see.
- `get_document` gives the same "not found" answer for an id that does not
  exist and for a document the caller may not see.
- When a search is empty because the person has no topics at all, the answer
  says so.

Topics come only from tags at the source: a key in a wiki page's frontmatter,
a tag in a Drive file's or folder's description, a Fireflies channel. The
Engine does not guess a topic from a title, a file name or the text. An item
with no valid tag is `unclassified`: it is indexed, and only the owner can see
it. [tagging.md](tagging.md) has the full rules.

## 5. Roles

- **Reader**: searches and reads within granted topics.
- **Reviewer**: same permissions as a reader in this version.
- **Administrator**: also sees all non-sensitive topics; manages people and
  grants.
- **Owner**: the administrator named in the config; the only holder of
  `unclassified`.
- **Account holder**: holds the database, hosting, Cloudflare and repository
  accounts.

People are added and granted topics with the `kbe people` commands or with the
admin tools on the connector. [roles.md](roles.md) has the details, including
sensitive topics and `unclassified`.

## 6. Review and approval

Review is how a document becomes approved. It is optional: unreviewed
documents are searchable. Approval raises a document's rank and lets a search
be limited to approved knowledge.

### 6.1 The review queue

At the end of each pull, the job builds a review batch of up to 40 documents.
A document is eligible when it is unreviewed, not deleted, has a model-written
summary, and is not already waiting in an open batch.

The batch is ordered by how much a mistake would matter:

1. documents where the model disagreed with the tagged topics;
2. tier 1 and tier 2 documents in a topic whose id starts with `client-`;
3. documents in a sensitive topic;
4. documents whose summary had key terms dropped;
5. everything else.

Within a group, newer documents come first.

The status page shows how many items are waiting and lists some of them under
**Waiting for your OK**.

### 6.2 Reviewing

Review runs in a terminal, with the database credentials from the local env
file:

```
python -m knowledge.review_cli
python -m knowledge.review_cli --size 40
```

The command resumes the oldest batch that still has undecided items. If there
is none, it builds a new batch of `--size` items (default 40). It asks for
your name, then shows each item: title, source, tier, topics, and the summary
split into WHAT, WHY and TERMS.

| Key | Decision | What happens to the document |
|---|---|---|
| `a` | approve | Status becomes `approved`. The time and your name are recorded. |
| `l` | relabel | You pick one topic from the config. The document's topics are set to exactly that one topic, and it is approved. |
| `r` | regenerate | The summary is discarded. The document stays unreviewed and is summarised again on a later pull. |
| `x` | exclude | Status becomes `excluded`. The document is no longer returned by any tool. |
| `s` | skip | Nothing. The item stays in the batch. |
| `q` | quit | Stops and applies what has been decided. |

Each decision is saved as soon as the key is pressed and applied when the
command ends. Any left over are applied during the next pull.

### 6.3 What approval does

- An approved document's score is multiplied by 1.25.
- `search` with `require_approved: true` returns approved documents only.
- Every result carries its `review_status`, so Claude can tell approved from
  unreviewed.
- When an approved document's content changes at the source, it goes back to
  `unreviewed` and the reviewer's name and time are cleared. The approval
  applied to the old content.

A wiki page with a `verified:` value in its frontmatter is tier 1. That is
separate from approval, and a page can have both.

## 7. The status page and the issue log

**The status page** is at `https://<host>/status`. It needs the admin-pages
sign-in (one-time PIN and a second factor), and the database admits active
administrators only. Without a `dashboard:` section in the config it shows
the Knowledge and Security menus, built from the enabled sources, and the
Support menu. Knowledge includes the items waiting for review. The
`dashboard:` section sets the title and the menus, and can add a Tools menu
with the connector address.

A banner at the top says one of two things. The Engine is **working**
unless one of these is true, in which case it **needs attention** and the
banner names the reason:

- a source's run failed and it has not run clean since;
- the last config change in the knowledge repo was rejected;
- a source that is on, and has run at least once, last succeeded longer ago
  than its `alert_after`.

Other open issues (an unknown tag, something a person reported) are listed
under Support and do not change the banner.

**The Support menu** (`dashboard.menus.support`, shown unless it is set to
an empty list) is the Engine's own issue log, view-only: the open issues,
how many were fixed in the last 30 days, the Care Plan line (what the config
says you intend, next to whether a support login really exists) and whether
the newest config is in force or was rejected.

**The issue log** is a table of problems the Engine has recorded about itself.
It is written in four ways:

- a source's run failed (`source_failure`);
- a config file in the knowledge repo was rejected (`config_invalid`);
- a source has documents whose tag names no topic (`unknown_tag`, one issue
  per source, with a count and the tag texts);
- a signed-in person used `report_issue`.

A failure that repeats updates its one open issue and counts the occurrences.
An issue holds a category, a source name, an error class and a short message.
Document text, titles, participant names and email addresses are removed
before it is stored.

With support access turned on (`python -m kbe support enable`), a support
person can read the log and mark items as handled, and can read nothing else.
Support access is optional and off by default. See
[care-plan.md](care-plan.md).

[operations.md](operations.md) covers both in full.

### 7.1 The Pipeline page and tickets

**The Pipeline page** (Engine > Pipeline) shows how new mail, files and
meetings become pages. It is twelve numbered cards, joined by arrows, like a
book going through a publishing house: Subscriptions, Mailroom, New mail
alert, Desk editor, Archivist, Author, Fact-checker, Publisher, Cataloguer,
Index clerk, Librarian, Reading room. Each card says what that step does and
whether it is working (a green, amber, red or grey light). The cards run left
to right in three rows of four (two a row on a narrow screen); on a phone they
run top to bottom.

After the Publisher saves a page, two more steps make it easy to find:

- The **Cataloguer** writes a short summary of the page. Its card shows how
  many pages wait for a summary, and how many the last run wrote and could
  not write. Its one choice is the summary length: **Standard** (2 to 4
  sentences, recommended) or **Short** (1 or 2 sentences, a little cheaper).
- The **Index clerk** files each summary in the search index, so Claude can
  find the page. Its card shows how many pages are in the index, how many
  wait, and any that are missing. **Try a search** shows the top five pages a
  question finds for you, with a score, using the same search Claude uses and
  only the pages you may see. It changes nothing. There is no setting here:
  the search model cannot be changed from the screen.

A big queue of pages waiting is not a problem; the curator works through it
a few at a time.

Some cards have a choice at the bottom: how good the Author's writing is
(Best or Budget), how much the Desk editor passes on, how often the
Archivist starts a new page, when the Publisher asks you first, when the
Librarian calls a page stale, how long the Cataloguer's summaries are, and a
switch to pause the curator for 24 hours. One line under each choice says what it does to cost or quality.
Only the Engine owner can change them; other administrators see them. None
of them can switch a check off. Every change is logged.

Under **Details for experts** the Cataloguer and Index clerk card names the
summary model, what summaries cost over the last 30 days, and the search
model. The owner also has **Redo summaries and index** there: it first shows
how many pages and the estimated cost, and does nothing until you confirm.
Then every page is queued again; the curator rewrites them on its normal
runs, and each page keeps its old summary until then. Use it after changing
the summary length, or if search seems to miss pages.

**A ticket** is a problem the Engine has written down for a person. It has a
short id (`QB-0012`), the step it belongs to, what happened, what to do, when
it opened, and a list of notes. The Engine opens one by itself when:

- the curator's last run failed;
- a run looks stuck;
- the timer (the new mail alert) failed, or its pokes do not reach the Engine;
- spending passed the budget rule, or the rule switched the Author to Budget;
- some items failed: the curator tried several times and gave up;
- the last run could not write some page summaries (Cataloguer), or could
  not file some in the search index (Index clerk);
- changes are waiting for your yes;
- mail is held because it looked like it was giving orders.

The same problem never opens two tickets: while one is open, a repeat
updates it. The Engine checks every hour, after every curator run, and when
someone opens the list.

Tickets are listed first on **To do**, and each has its own page. There are
two kinds:

- **To-dos**: changes waiting for your yes, and held mail. When nothing is
  left waiting, the ticket closes by itself with the note "Closed by itself:
  nothing left waiting", and its page says "Nothing is waiting now".
- **Problems**: everything else. When the cause goes away the ticket says
  **looks fixed since** a time, but stays open until a person checks and
  presses **Close this ticket**.

On the Pipeline page a step shows a red **Needs you** badge for tickets whose
cause is still there, and a calm amber **Check and close** badge for problems
that look fixed. Who closed a ticket, and when, is kept. If the same problem
comes back later, a new ticket opens.

Administrators see tickets. Claude can list and read them and add notes
(section 4.2), but cannot close them.

## 8. The config

One file, `.kb-engine/engine.yaml`, in the owner's private knowledge repo. It
names the Engine and its owner, declares the topics, sets the tag prefix,
turns sources on and off, and names the summary model.
`config/engine.example.yaml` is a complete example, and
[configuration.md](configuration.md) describes every field.

The file is applied to the database. The service and the pullers read the
applied copy. `apply` validates the file, shows what differs from the applied
config, asks, then applies it:

```
python -m kbe config validate ~/knowledge-acme/.kb-engine/engine.yaml
python -m kbe config apply ~/knowledge-acme/.kb-engine/engine.yaml
```

The wiki job also applies the file on its own. On each run it compares the
file on the knowledge repo's main branch with the applied config. A changed,
valid file is applied before any page is read. An invalid file, or one the
database refuses, is rejected whole: the previous config stays in force and a
`config_invalid` issue is opened. The next valid file closes it.

## 9. What the Engine guarantees

Each of these is enforced by code or by the database. Most have a test in
`supabase/tests/` or next to the code.

**Access**

1. **The filter runs in the database.** Topics are resolved from the verified
   sign-in inside SQL. The service's role holds no grant on any table and
   reaches data only through functions that apply the filter.
2. **Unknown means nothing.** An unknown or deactivated person, or a person
   with no topics, gets zero rows from every tool.
3. **Sensitive topics are never implicit.** An administrator sees a sensitive
   topic only with a grant for it.
4. **`unclassified` is owner-only.** Applying a config removes any other grant
   on it. The admin tools refuse to grant it.
5. **A document always has a topic.** The database rejects a document with an
   empty topic list.
6. **A model never widens access.** A model's topic proposal can narrow a
   document's topics or flag it for review. It cannot add a topic.
7. **A wrong tag never widens access.** A tag that names an undeclared topic
   makes the item `unclassified`.
8. **Hidden documents stay hidden.** Deleted, excluded and rejected documents
   are not returned by search or by fetch.

**Changes to people and config**

9. **Admin changes need a preview and a code.** The code is single-use, lasts
   10 minutes, and is bound to the administrator and the exact arguments.
   Every applied change is recorded in the event log.
10. **There is always an administrator.** You cannot deactivate yourself, and
    the last active administrator cannot be deactivated.
11. **A config cannot take over the Engine.** It cannot name a new owner,
    declare `unclassified`, remove the sensitive mark from a topic, or remove
    a topic that still has documents or grants.

**Ingestion**

12. **Nothing is indexed before sign-in is set up.** The pullers stop until
    sign-in settings exist.
13. **Raw captures are append-only, and documents are never deleted.** The
    pullers' role cannot update or delete a raw capture, and has no delete
    permission on documents. It marks them deleted.
14. **Key terms are checked against the source.** A term that is not in the
    source text is dropped.
15. **A large unexpected deletion stops the run.** More than 10% of a source's
    live documents going missing in one run writes nothing.
16. **Changed content loses its approval.**

**Logs**

17. **Search text is not logged.** The service logs the length of a query,
    never the query.
18. **The issue log holds no content.** Messages are scrubbed twice, by the
    pullers and by the database, and a reporter is stored as a handle.
19. **Support sees the issue inbox only.** The support role can read one view
    and run two functions.

`python -m kbe verify` runs the checks listed in `setup/manifest.yaml` against
your own database.

## 10. Known limits

**Tools**

- `who_knows` counts the author of each matching document (a wiki page's
  author, a Drive file's owner, a meeting's organizer, the first person on a
  mail thread) and, for mail, everyone on the thread. Meeting attendees other
  than the organizer are not counted: the meetings job does not store them.
  It needs migration `0043`; before that it returns an empty list.
- `get_wiki_page` matches text contained in the title or path. It does not
  correct spelling. Keyword search uses English word stemming.

**Review**

- The reviewer role has no permissions of its own yet. Review runs in a
  terminal with database credentials, so in practice the account holder does
  it.
- The reviewer's name is typed in and is not verified.
- Relabel sets exactly one topic.
- There is no command to undo an exclude.
- At most 40 documents per source are summarised per run, and only summarised
  documents enter the review queue. A large new source takes several days to
  work through.
- The review order gives a special place to topic ids that start with
  `client-`. This is not configurable.

**People**

- The Engine cannot change who may sign in. Adding a person in the Engine does
  not add them to the Cloudflare rule, and deactivating them does not remove
  them from it.
- There is no command to change a person's role or to reactivate a person.
- Database credentials bypass topic grants. Whoever holds them can read
  everything.

**Ingestion**

- Each source is pulled once a day. A new page, a changed tag or a deletion
  takes effect at the next pull of that source.
- The `visibility` column on a document is stored and not used for access.
- One database holds one Engine.

**Status and issues**

- The issue log is read-only everywhere it is shown: the Support menu of the
  status page, `python -m kbe issues list`, and the administrators' connector tool
  `admin_list_issues`. An issue is closed by the run that fixes it or by a
  support person; there is no command for an administrator to close one.

- Setup's calls to Cloudflare, and the link that fills in the token's
  permissions, were written from Cloudflare's
  documentation. [security.md](security.md) lists what has not been checked
  against a live account.

## 11. Glossary

| Term | Meaning |
|---|---|
| **Approved** | A document a person said yes to in review. Ranks higher. Also called gold. |
| **Bronze** | Raw source text, kept in `raw_captures` |
| **Distillation** | The short summary of a document: what, why, key terms |
| **Document** | One row in the index: a wiki page or section, a Drive file, a meeting |
| **Domain** | The name for a topic in the config and the database |
| **Grant** | One person's permission to see one topic |
| **Knowledge repo** | The owner's private git repository of markdown pages. Also holds the config. |
| **Owner** | The administrator named in `engine.owner.email` |
| **Puller** | The scheduled job that reads one source |
| **Sensitive** | A topic that needs a deliberate grant, even for administrators |
| **Silver** | Documents that are indexed and not yet approved |
| **Tag** | `<prefix><topic id>` at the source, for example `kx/consulting` |
| **Tier** | A rank from 1 to 4, set by the source, used in ranking |
| **Topic** | An access label on a document. A person sees a document when they hold one of its topics. |
| **Unclassified** | The topic of every item with no valid tag. Indexed. Owner only. |
