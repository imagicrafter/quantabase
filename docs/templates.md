# Entity templates

Every rule about kinds of pages lives in YAML, in
`engine/templates/entities/`. The curator prompt, the app and the page tools
read these files; no drawer id, key rule, signal or link rule is written in
code. `base.yaml` holds the eight drawers every Quantabase has; each other
file is a business template that adds drawers. An Engine uses base plus the
templates chosen on **Settings > Template**; when two define the same drawer,
the first one wins.

## File

```yaml
name: consulting                 # must match the file name
label: Consulting
description: Consultants, agencies and partners. Adds Deals and Offers.
drawers:
  - id: deals                    # lower case, letters, digits, dashes
    label: Deals
    icon: dollar                 # an icon name from engine/src/app/icons.ts; unknown means a folder
    key_rule:
      kind: slug                 # email | domain | slug | source_id
      text: "deal: followed by the organisation domain and a short name."
      # sources: [fireflies]     # source_id only: sources whose items carry this key
      anchor:                    # slug only, optional: what a page belongs to
        field: organisation      # consensus compares pages by this field, not by the slug
        single_open: { field: stage, closed: [won, lost] }   # one open page per anchor: update it, never duplicate
    fields:
      - { name: stage, kind: enum, values: [lead, won, lost] }   # text|date|number|enum|key|email|url
      - { name: value, kind: number }
    sections: [Summary, Need, Proposal, Timeline, Notes]
    signals:                     # when the curator should make a page here ("make one when")
      - A request for a price, a proposal or a scope of work
    update_rules:
      auto: [stage, value]       # fields the curator may set on its own
      needs_yes: []              # fields whose change waits for the owner's yes
    default_topic: null          # optional
    curator:                     # optional
      new_page: auto             # auto (default) | needs_yes
      links_to: [organisations, people, projects]   # drawers this page links to ("related")
      required_when:             # case-insensitive regular expressions on the item's text
        - '\$\s?\d'
        - '\b(budget|price|quote|proposal|sow)\b'
      notes:                     # extra one-line rules shown to the curator for this drawer
        - A project page does not replace the deal page; make both when both apply
    list_views:
      - { name: pipeline, filter: stage, sort: value, desc: true }
```

## Keys

| `key_rule.kind` | Key |
|---|---|
| `email` | the person's email, lower case |
| `domain` | the organisation's web domain, without `www.` |
| `slug` | `<prefix>:<short-name>`; the prefix is read from the start of `text` |
| `source_id` | `<prefix>:<the item's id at its source>`, for items from `key_rule.sources` (or with `metadata.<prefix>_id`) |

A slug is a free name, so two curator runs rarely name the same deal the
same way. `key_rule.anchor` names the field that says what the page belongs
to (a deal's `organisation`). Consensus runs then compare these pages by
drawer and anchor value, and the key comes from the winning run. With
`single_open`, a new page whose organisation already has an open page on the
shortlist (stage not in `closed`) becomes an update of that page.

## What the curator does with it

- Each drawer becomes one line of the prompt: key, sections, fields,
  `link to`, `make one when` (signals) and `also` (notes). Links name only
  drawers the Engine uses.
- **`required_when`** is a hint. When a pattern matches the item's text,
  the prompt says the item may concern that drawer ("create or update one
  only if the item really is about one"). It is never a failure: the reply
  is applied as it is (since migration 0069).
- **Page shape** (`curator.page_shape`). Every page the curator changes gets
  one dated line at the top under `updates_heading` (default "Major
  updates"), newest first, at most `updates_max` lines; the model writes the
  line (`update_line`) and the Engine dates and places it. A new page's
  title is at most `title_max` characters. A page's own sections (Key
  Interactions, Timeline) are kept. `updates_heading: ""` turns it off.
  Dated events go in the first of `events_sections` (default `[Key
  Interactions, Timeline]`) the page has: a patch to a section the page
  lacks, or a new "Timeline"-like section, goes there instead. A page with
  none of them may get a section the drawer's template names; any other
  unknown section is refused (that patch only, not the item).
- **Update first, never the owner** (round 4). A proposed page that is an
  existing page under another name (the same name or alias, a title sharing
  almost every word and the same numbers, or another drawer's page that
  already has the name as an alias) becomes a patch to that page. No person
  page is made for the Engine's owner or any account user (read from
  `workspace.principals`, migration 0070). With triage on, the triage model
  also fact-checks the writer's new sentences against the source and cuts
  the ones it does not support (listed in the item's "left out" lines).
- **One writer** (the default since migration 0069). With consensus off, a
  cheap triage model reads the item and a compact page index first; an item
  with nothing durable stops there as "no change". Otherwise one writer
  (`curator_settings.writer_model`) reads only the pages triage named (and
  pages the item's addresses match), up to 20 other page titles, and the
  item whole when short or as triage's excerpts and summary when long. See
  `engine/src/curator/writer.ts` and docs/operations.md.
- **Consensus.** With `curator_settings.consensus` on (off by default since 0069), each
  item is curated twice and, when the decisions differ, once more with
  `curator_settings.tiebreak_model`; see `engine/src/curator/consensus.ts`.
  Runs are compared on decisions only (which page, create or update, field
  values), never wording or order; page keys ignore case, and a field only
  one run set is not a disagreement.
  The `required_when` check runs on the merged result.
- **`update_rules.needs_yes`** and **`curator.new_page: needs_yes`** opt a
  drawer in to more caution; the shipped templates use neither.

## Curator quality (migration 0067)

The curator works to the same bar as a careful person filing a wiki by hand.
All of it is set in YAML; `base.yaml` holds the defaults.

```yaml
# template level (first template that sets a value wins, base first)
curator:
  durability: ["Durable: still relevant six months from now", ...]
  skip: ["Pleasantries, thanks, greetings and sign-offs", ...]
  match_threshold: 0.9        # name/embedding score that files a new page on an existing one
  duplicate_threshold: 0.92   # summary similarity for the nightly "Possible duplicates" list
  index_tokens: 1500          # budget of the page index shown to the curator
  low_agreement: 0.5          # primary runs agreeing on less than this share go to the strong model
  page_shape:                 # dated updates list at the top of changed pages
    updates_heading: Major updates
    updates_max: 5
    title_max: 60
    events_sections: [Key Interactions, Timeline]   # where dated events go
drawers:
  - id: people
    key_rule:
      kind: email
      identities: emails      # email/domain keys only: field holding the other addresses
      fallback: person        # email/domain keys only: person:<name> when no address is known
    curator:
      judgement: high         # a new page here is decided by the strong model
      durability: [...]       # replaces the template-wide rule for this drawer
      match_threshold: 0.85
```

- **Durability.** The prompt lists the rule; an item with nothing that passes
  is answered with no changes and recorded as `no_change` (counted, never
  failed), with the model's reason.
- **Page index.** Before deciding, the curator reads one line per page the
  owner has in the item's topic (key, drawer, title, aliases and known
  addresses, description), ranked by key, words and embedding
  (`curator_page_index`), cut to `index_tokens`. Key matches always stay.
- **Model routing.** New pages in, and updates to pages in, `judgement: high`
  drawers, items whose consensus runs were uncertain, and items whose two
  primary runs agreed on less than `low_agreement` of their decisions go to
  `curator_settings.strong_model` (docs/operations.md). Routine drawers stay
  on the primary model. Each item logs why it was, or was not, escalated.
- **Sections.** The prompt lists each shortlist page's own headings
  (imported pages rarely use the template's). A patch to a section the page
  lacks becomes a new section after the template's nearest earlier section
  the page has, else after its last section. A patch, field, link or page
  that still does not fit is left out alone, with the reason on the item
  result; the rest of the reply is applied. A new page key written loosely
  (capitals, spaces, `www.`) is normalised, or filed on the page that already
  has that name, alias or address, before it is refused.
- **Duplicates**, in layers: (a) the key; (b) identities: a person page's
  `fields.emails`, an organisation's `fields.domains`, matched like the key;
  the curator may add one when the item names the page's name and, for an
  address, its organisation, and never merges; (c) before a page without a
  strong key (a slug, or a `fallback` key) is made, a page in the same drawer
  with the same normalised title or alias, or an embedding score at least
  `match_threshold`, gets the update instead and the new name as an alias
  (the score is logged); (d) the nightly look-alike list, merged only by the
  owner (`/app/duplicates`; the merged page keeps both histories, the old key
  leads to the kept page); (e) `kbe pages import` uses the same matching and
  reports a match instead of making a page.
- **A/B harness.** `scripts/eval/curator_ab.ts` runs the curator on a folder
  of items against a page snapshot and writes the proposed changes as
  Markdown, optionally paired blind with `/update-docs wiki` output.
  `--writer-model`, `--triage on|off` and `--triage-model` run the default
  one-writer pipeline; `--consensus`, `--tiebreak-model`, `--strong-model`
  and `--max-tokens` run the consensus one. `OUT/stats.json` has each
  item's outcome, consensus label, agreement, routing, tokens and USD per
  model, and the run's agree rate, USD and USD per item.

A template that does not parse stops the service at start with the file
name and the reason. `engine/tests/entities/templates.test.ts` checks every
shipped file: list views name real fields, icons exist, `links_to` names real
drawers.
