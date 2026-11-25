# Source inclusion rules

A Gmail or Fireflies ingest run no longer hands over everything since the
cursor. Each person writes **inclusion rules** for each of their own source
accounts, and the Engine keeps only what those rules include. The rules live
in the database (migration 0063) and the database enforces them; the plugin
only lists less because of them.

## The model

| Part | Rule |
|---|---|
| Whose | Rules belong to one person and one **source account**: `gmail:<address>` or `fireflies:<account address>`. Two people reading the same mailbox each have their own account row and rules. |
| Order | An ordered list. **Exclude rules are checked first and always win.** Then include rules are tried from the top; the **first match** decides. |
| Default | **Deny.** An item no include rule matches is not kept: it is counted on the account (`items_skipped`) and its text is never stored. |
| Inside a rule | Every field must match (AND); within a field any value may match (OR). |
| Topic | Each include rule maps to **exactly one** topic the author holds, or is **private** (kept, owner-only). An item gets one topic, never more. |
| Unit | Gmail: the **message** (its id is the item's `source_id`); the thread id is kept only as context. Fireflies: the meeting. |

Match fields:

| Source | Fields |
|---|---|
| Gmail | `any_address` (from, to or cc), `from`, `to`, `cc`: email addresses or domains (`acme.com` also matches `sales.acme.com`); `labels`: Gmail labels by **label id** |
| Fireflies | `participants`: addresses or domains (the organiser counts); `channels`: Fireflies channels by **channel id** |

Fireflies exposes channels as its own grouping of meetings (the API's
channel list and each transcript's channel ids), and the participants'
addresses; those are the two MVP fields.

### Labels and channels

The run reports the account's labels (or channels) each time
(`report_ingest_candidates`). They are the rule builder's picker. A rule stores
the **id** and shows the current name, so renaming a label in Gmail is safe.
When a complete list no longer has a label, the label is marked deleted and
every rule naming it is **broken**: a broken include rule matches nothing (so
it ingests nothing) until it is fixed. A rule whose topic its author no longer
holds is broken the same way. Gmail's own labels (INBOX, UNREAD, CATEGORY_*)
are never offered.

### Suggested excludes

When an account reports a label named Personal, Private, Family, Medical,
Health, Finance or Banking, the Sources screen offers an exclude rule for it.
Nothing is added until the person clicks it.

## What the Engine enforces

- `record_source_item` accepts only the sources it knows (`gmail`,
  `fireflies`, `drive`, `calendar`): mail handed over under another name
  would skip the rules.
- `get_ingest_plan` (account required for Gmail and Fireflies) returns the
  caller's rules and a **narrowed** provider query: for Gmail the OR of the
  working include rules minus each exclude, e.g.
  `((from:acme.com OR to:acme.com OR cc:acme.com) OR label:board) -label:personal after:YYYY/MM/DD`
  (a date one day before `since`, never epoch seconds; label terms use the
  label name in Gmail's search form: lower case, spaces and slashes as
  dashes, while rules match by label id). The plan also gives a
  `fallback_query` with `newer_than:<days>d` that a run tries once when
  `query` lists nothing;
  for Fireflies a channel and participant filter. A query that lists too much
  is harmless.
- `record_source_item` evaluates the caller's current rules **in the
  database** from the item's provider metadata (`from`, `to`, `cc`,
  `label_ids`, `channel_ids`, `participants`), sets the topic itself, and
  **ignores** any `topics` or `owner` the run passes. An item no rule
  includes comes back `not_included` with no id, and nothing is stored.
- Each kept item stamps `rule_id`, `rule_version` and `ruleset_version`.
- Rule lists are saved as **append-only versions** (`source_rule_sets`, a
  trigger refuses update or delete) and every change, re-check, backfill and
  sample request is in `source_rule_audit`.
- Every rule list is validated in the database: kinds, fields per source,
  at most 50 values a field and 100 rules an account, addresses or domains
  only, labels the account reported, a topic the author holds.

## Changing rules later

| Change | Items already kept | New items |
|---|---|---|
| **Narrowing**: a kept item's topic is not one the new rules give it (another topic, private, or no longer included) | Re-filed **at once** to owner-only (`rule_state = recheck`); the pages built from them are flagged for re-curation (`pages.recheck_at`) | Follow the new rules |
| **Widening**: an item would now get a topic it did not have (e.g. private to a topic) | Unchanged | Follow the new rules |
| **Backfill** (the owner asks, with a date up to a year back) | The next run goes back to that date; the rules still decide | |

The comparison is between each kept item's actual topic and what the new
rules give it, with the rules read as written: a label deleted at the source
does not by itself re-file what its rule already kept (new items stop
matching at once). A topic taken away from the author does re-file at the next
save.

**Re-check** (on the account's page) files each held item under the rule in
force now (a curated one is curated again) and removes those no rule
includes. The owner marks each flagged page checked from the Sources screen.

## Who can see and change rules

- Every person, administrators included, sees and edits **only their own**
  source accounts and rules (`/app/sources`). Nobody can author rules for
  someone else's source; each `app_source_*` function refuses an account
  that is not the caller's.
- An administrator sees, for other people, only **a count of rules per
  person** (Topics and people), never their contents or account names.
- A rule maps only to a topic its author holds, or private.
- **Topics are made by administrators only** (Topics and people, with a
  preview and a yes). Administrators also add and remove people, set roles
  and grant topics there.

## The Sources screen

`/app/sources` (under the person's own menu, not Settings):

- the person's accounts, with rule counts, broken rules, kept and left-out
  counts, and items waiting for a re-check;
- per account: the ordered rule list with Up / Down / Remove buttons and a
  "File under" picker; Add a rule (kind, name, address and domain boxes shown
  as chips, the label or channel picker, a topic picker of the person's own
  topics, or private); suggested excludes;
- a **dry-run** of the rules on the last 7 days, using a metadata-only
  sample the next run sends when asked (`report_ingest_candidates`:
  addresses, label or channel ids, participants, date; never a subject or
  text);
- versions and the audit log; re-check; backfill; ask for a new sample;
- a **Claude Code sessions** card: how many sessions the person has sent a
  note for by hand (`/qb-engine:send-session`), how many notes in all,
  and when the last came. Notes have no account and no rules: each is sent
  after a preview and a yes, and stays with its owner ([plugin.md](plugin.md#sending-a-claude-code-session)).

An edit that could let more people see new items (a new include rule to a
topic, moving a rule, moving a rule to a topic, removing any rule) shows the
dry-run first and needs an explicit yes. Edits that only narrow (a new
exclude, a private rule, moving a rule to private) apply at once.

## One topic per page

The curator gives each page exactly one topic (or none: owner-only). It
offers an item only pages with exactly the item's topics, and writes only
pages with exactly those topics. Facts about the same person or company from
an item in another topic go to a **separate page** on the same key in that
topic (`pages` now allow one live page per owner, key and topic set). A
person's own `save_page` still has to read an existing page on that key
first.

## Migration from source tags (0060)

Migration 0063 turns each person's switched-on Gmail labels and Fireflies
channels into include rules on an account named after their own address (one
rule per tag, to the same topic), copies their found tags into that account's
picker, and records `rules_migrated` in the audit. Items and pages already
filed keep their topics. Items kept through a tag (0060 recorded its id) join
the account with that id as their label or channel and are stamped with the
matching migrated rule, so narrowing it later re-files them. Older items with
no tag record are left as they are (no account, never re-filed by rules). The tag switch can no longer make topics. Drive and
Calendar keep the 0060 behaviour for tags already switched on, until Drive
gets rules.
