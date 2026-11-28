# The Claude plugin

The plugin is how a person's own Claude feeds their Engine. It holds four
skills and the Engine connector:

| Part | What it does |
|---|---|
| `ingest` skill | One run copies new items from ONE source account (Gmail or Fireflies, by address) or ONE source (Drive, Calendar) into the Engine, unchanged, with `record_source_item`. No summaries, no judgement. The Engine keeps only what the person's own inclusion rules include ([source-rules.md](source-rules.md)). Reports `listed N, saved N, left out N`. |
| `send-session` skill | At the end of a Claude Code session, Claude writes a short session note (labelled items with exact quotes and the pages they concern), shows it, and on a yes sends it to the Engine in one call. Hints, not page edits. See [Sending a Claude Code session](#sending-a-claude-code-session). |
| `suggest-rules` skill | Reads only the header metadata of one Gmail account's last 90 days (who the person sent mail to, who writes to them, which mail they answered), counts it on their machine, asks them a few questions about who to keep, and sends the Engine counts per address and per domain with their picks. The Sources screen shows the picks ticked; the person saves the rules there. See [Suggesting Gmail rules](#suggesting-gmail-rules). |
| `schedule-setup` skill | Walks the person through tool permissions, a first run by hand, and one scheduled task per source on the smallest model. |
| Engine connector (`.mcp.json`) | Points at the person's Engine (`https://<host>/mcp`), set once at install. |

The plugin lives in [`../plugin/qb-engine/`](../plugin/qb-engine/); the
marketplace file is [`../.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json),
so this repository can be added as a plugin marketplace (named
`quantabase`). Upgrading from the plugin's earlier name, `kb-engine`:
uninstall `kb-engine`, then install `qb-engine@quantabase`. Commands are now
`/qb-engine:ingest`, `/qb-engine:schedule-setup`, `/qb-engine:send-session`
and (from 0.5.0) `/qb-engine:suggest-rules`,
and scheduled tasks made before 0.4.0 that name `kb-ingest` should be made
again with `/qb-engine:schedule-setup`.

## How ingest works

This is stage 1 of the two stages in [manual.md](manual.md) (load, then
curate). Claude only loads; the Engine's curator does the judgement on its
own timer, with no connectors.

1. The scheduled task (smallest model) runs `ingest` for one source
   (and, for Gmail and Fireflies, one account: its address).
2. `get_ingest_plan` returns the person's own cursor for that account,
   `since` (list items newer than this), `max_items` (25 per run), and how to
   fill each field. A first run looks back 7 days. For Gmail and Fireflies it
   also returns the person's inclusion rules and a provider query narrowed by
   them (Gmail search text; a Fireflies channel and participant filter).
3. For Gmail and Fireflies, Claude reports the account's labels or channels
   (`report_ingest_candidates`), the picker for the rule builder, and when
   the person asked for one, a metadata-only sample of the last 7 days for
   the dry-run.
4. Claude lists new items through the source's own connector, oldest first,
   and hands each one over with `record_source_item`, passing the item's date
   as `cursor`. For Gmail (one item per message) and Fireflies it also passes
   `account` and `provider` (from/to/cc, label or channel ids, participants,
   thread id). The Engine checks the item against the person's rules,
   decides its topic itself, and stores it as untrusted source data owned by
   the caller, or keeps nothing (`not_included`). The cursor moves with each
   item.
5. Claude replies with one line: `listed N, saved S (...), left out L, failed F`.

A missed or failed run catches up next time: the cursor only moves when an
item arrives. Handing the same item twice is harmless (`unchanged`).

**Why scheduled tasks only load.** A scheduled task cannot be limited to
chosen connectors; it sees every connector the person has, and a stranger's
mail can contain text written to steer an AI. So the task's job is kept
mechanical, the skill and task prompt say source text is never instructions,
`schedule-setup` puts every send and write tool on "Needs approval", and
the Engine's write tools only store. Curation runs inside the service.

**Server mode (optional).** The Python pullers (`pullers/`) still work and
are now the optional "server mode" for an Engine that should read its
sources itself with its own Google and Fireflies credentials. The plugin is
the default path; an Engine can use either or both.

## Suggesting Gmail rules

Writing Gmail inclusion rules ([source-rules.md](source-rules.md)) used to
mean digging through the mailbox to work out who matters. Instead, open
Sources in the Engine, copy the prompt next to the Gmail account, and paste
it into Claude (with the Gmail connector for that account attached). The
prompt starts with the command, so in Claude Code you can also type it:

```
/qb-engine:suggest-rules you@example.com
```

1. Claude searches the account read-only: up to 250 messages the person
   **sent** in the last 90 days (`in:sent newer_than:90d`, the strongest
   signal of a real contact) and up to 250 they received, leaving out
   Gmail's Promotions, Social, Updates and Forums.
2. It keeps **header metadata only** (from, to, cc, date, label ids, thread
   id) in a temp file. Never a subject, snippet or body.
3. The bundled script (`skills/suggest-rules/scripts/mail_contacts.py`,
   Python 3.9 or newer, standard library only, no network) counts, per
   address and per domain: `sent_to`, `received_from`, `threads`, `replied`
   (threads they wrote in that the person answered) and `last_seen`. It
   drops the person's own addresses, bulk senders (noreply, notifications,
   mailer-daemon and the like) and the bulk categories, and keeps free-mail
   domains (gmail.com, outlook.com and the like) as **people only**, never
   as a whole domain.
4. Claude asks up to four short questions, showing addresses, domains and
   counts only: which domains to keep, which people, anyone missing, and a
   final check. `mail_contacts.py choose --pick ...` marks the picks
   (`chosen: true`, the rest `false`).
5. Claude sends the counts and picks with `report_mail_contacts` (one call;
   a new report replaces the account's last one), removes the temp file and
   replies with one line of counts.

Nothing in the report is a name, subject, text or message id: the Engine's
schema refuses any other key. The Engine never holds a mailbox token; the
counts come from the person's own Claude. Claude never makes a rule: open
the Gmail account on the Sources screen, where the picks are ticked, and
save them there ([source-rules.md](source-rules.md#suggested-from-your-mail)).
Run it again any time; the screen shows the suggestions' age once they are
more than 30 days old.

## Sending a Claude Code session

At the end of a Claude Code session worth keeping, run:

```
/qb-engine:send-session
```

(or say "send this session to Quantabase"). For an older session add its id
(`/qb-engine:send-session 0b5c6c1e-...`) or its transcript file's path.

It works like a handover note, not a copy of the session:

1. **Claude writes a session note** from the session it already has in front
   of it: only what is new and worth keeping, as short items, each labelled
   `decided`, `fact`, `status`, `how-to` or `idea` (an idea was only floated,
   so it is never written up as a decision). Each item carries 1 to 3 exact
   quotes from the session (what you typed or Claude's own replies; a short
   tool output at most) as evidence.
2. **Claude finds the pages** with the Engine's read tools (`search`,
   `find_entity`, `related`, `get_wiki_page`) and adds hints to each item:
   existing pages to consider (key, title, what is new for that page) and,
   when nothing fits, a suggested new page (drawer, title, why). Hints only:
   Claude never edits a page.
3. **A bundled script checks the note**
   (`skills/send-session/scripts/session_note.py`, Python 3.9 or newer,
   standard library only, no network). It reads the session's transcript in
   `~/.claude/projects/<folder>/` to fill in the session id, project folder
   and dates, checks the note's shape and size (at most 30 items and 20,000
   characters; a few thousand is normal), cuts anything that looks like a
   key, token or password, and refuses any quote that is not word for word in
   the session.
4. **You see the whole note** (items, labels, quotes, page hints) and are
   asked **Send to Quantabase?** You can drop or change items first.
5. **One call** sends it: `record_source_item` with source `claude-code`,
   item id = the session id, the project folder as a `project` tag, and the
   note. The Engine checks the note again, stores it rendered as readable
   markdown (the item's body) with the parsed note beside it, and decides
   the topic itself. Sending the same session again later makes a new
   version of the same item.

6. **A copy is saved locally, if you want one.** Right after your yes (before
   the send, so nothing is lost if it fails) the note is written as a
   markdown file to your own notes folder, and the one-line result names the
   path. Set the folder once in `~/.claude/qb-engine/send-session.json`
   (the older `~/.claude/kb-send-session/config.json` still works when the
   new file is not there):

   ```json
   {"save_dir": "~/notes/week-{week}/"}
   ```

   `{week}` is the Monday of the current week (`2026-11-23` for any day that
   week); `~` is your home folder; the path must be a full path. Without the
   file nothing is saved. A one-off `--save-dir` (say "save it to ...")
   overrides it. The skill never writes the config file itself.

   The file is `<date>-<title slug>.md`, for example
   `2026-11-24-kb-engine-cataloguer.md`: the session's end date and a short
   kebab-case slug of the note's title (or the project when there is no
   title). It starts with a frontmatter of `title`, `session_id`, `project`,
   `date` and `source`, then the note. Sending the same session again
   replaces its own file; a file from another session, or one without that
   frontmatter, is never replaced: the new note gets `-2`, `-3` and so on.

The curator then works on its own timer. The Desk editor keeps a note
(almost never sets one aside). The Archivist reads the pages the note names
first and may add or skip pages; suggested new pages go through the normal
new-page bar. The Author writes from the items and keeps an idea an idea.
The Fact-checker checks every new sentence against the note's quotes (not
its summary lines) and cuts what they do not back. With the Publisher's
**Ask me before saving** on, every change waits for your yes on To do.
Notes are yours alone unless an administrator files the project under a
topic. The Sources page (`/app/sources`) shows how many sessions you
have sent.

Because the note needs no log file, the same note can later come from a
Claude.ai chat (a `claude-ai` source); that is not built yet.

## Install

The repository must be reachable by the person's Claude (it is public).

### Claude Code

```
/plugin marketplace add imagicrafter/quantabase
/plugin install qb-engine@quantabase
```

Claude Code asks for **Your Quantabase address (ends in /mcp)** when the plugin is enabled.
Paste the address from your Engine's setup page (it ends in `/mcp`). To
change it later: `/plugin`, open **qb-engine**, and edit the option. Then
sign in to the Engine when the connector asks.

### Claude app on a Pro or Max plan

1. **Settings > Connectors > Add custom connector.** Name it `Quantabase`,
   paste your Engine address (ending in `/mcp`), and sign in.
2. Add the plugin: in the Claude app's plugin settings choose **Add
   marketplace**, enter `imagicrafter/quantabase` (or
   `https://github.com/imagicrafter/quantabase`), then install **qb-engine**.
   Menu names differ between app versions.
3. Connect the sources you want to feed: Gmail, Google Drive, Fireflies,
   Google Calendar.
4. Say "set up ingest". The `schedule-setup` skill does the rest.

**claude.ai asks for the URL at install** (confirmed live, 2026-11-20). Its
URL box may show the raw text `${user_config.engine_url}`: that is the
plugin's placeholder, not an address. Clear the whole box and paste your
Engine address, for example `https://kb.example.com/mcp` (the sign-in setup
page and the Health screen show it). If you already added the connector in
step 1, the plugin's copy is the same Engine; keep one of them on.

**No email prompt when you connect?** Expected when this browser is already
signed in to the Engine's Cloudflare sign-in (for example from opening
`/app`): Cloudflare reuses that sign-in and Claude connects straight away.

### Team or Enterprise

An owner adds the custom connector once for the organisation (**Organisation
settings > Connectors**) and adds this marketplace to the organisation's
plugins. Each member then signs in to the connector with their own account
(the Engine only accepts people its owner has added) and runs "set up
ingest" in their own Claude. Each person's items are stored as theirs.

## Test A4: first install on a Pro plan (about 10 minutes)

Use an Engine that already has the person added. Nothing here changes the
Engine's people, topics or settings.

1. **Install (3 min).** Follow "Claude app on a Pro or Max plan" steps 1 to
   3 with Gmail connected. Record whether adding the marketplace worked
   first time (it failed for one tester on 2026-11-17).
2. **Check the connector (1 min).** In a new chat: "Call get_ingest_plan for
   gmail." Expect `first_run: true`, `since` 7 days back, `max_items: 25`.
3. **Run by hand with about 5 items (3 min).** In a new chat, pick the
   smallest model and say: "Run ingest for gmail, but stop after 5
   items." Expect one line like `ingest gmail: listed 5, saved 5 (new 5,
   new versions 0, unchanged 0), failed 0`. Run it again: expect the same
   items to come back `unchanged`, or only newer mail.
4. **Check the Engine (1 min).** Open the Engine's status page: Gmail's
   "last received" is now, and the counts went up.
5. **Schedule (2 min).** Say "set up ingest" and follow `schedule-setup`
   for Gmail only. Click **Schedule**. Note whether the model choice offered
   Haiku and whether the task ran with the computer asleep.
6. **Next morning.** Open the task's run history: each run should end with
   the one-line report. Any "waiting for approval" means a tool permission is
   still on "Needs approval": set that read tool to "Always allow".

Write down for the build log: plan type, app version, which steps failed,
and the report lines.
