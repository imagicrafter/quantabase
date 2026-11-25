# Operations

Running an Engine after it is set up: checking health, reading the issue
log, updating, backing up, restoring, and removing a deployment.

In Claude Code, the `kb-engine-admin` skill walks through the day-to-day
tasks on this page. Commands run from the repo root with
`PYTHONPATH=scripts:.`.

## Health

```
python -m kbe deploy status
python -m kbe sources list
python -m kbe access status
python -m kbe tags audit
```

| Command | Healthy looks like |
|---|---|
| `kbe deploy status` | Active deployment `ACTIVE`; each job's last run listed without a failure |
| `kbe sources list` | Every enabled source `ok`. `failing` shows how many runs in a row failed. `never run` is normal before the first schedule |
| `kbe access status` | `setup: complete`, `sign-in settings: present`, `admin pages app: present` |
| `kbe tags audit` | No unknown tags; the untagged count is what the owner expects |

Other places to look:

- **`/health`** on the app's own address (`<name>.ondigitalocean.app`)
  returns `{"ok": true, ...}` with the deployed commit. On the Engine's
  hostname, Cloudflare asks for a sign-in first.
- **The status page**, `https://<host>/status`. Owner only, with a second
  factor. It shows the sources, the topics, the review state, the people and
  the security layers.
- **Logs.** In the DigitalOcean dashboard: the app, the component, Runtime
  Logs. The service and the jobs never log a secret or document text.
- **Alerts.** The app spec asks DigitalOcean to alert on a failed
  deployment, a failed domain, repeated restarts and high memory use.
  DigitalOcean sends them to the account's contacts.

The full check is `python -m kbe verify`. It runs every check in
`setup/manifest.yaml` against the live deployment. A skipped check counts as
a failure. `python -m kbe verify --phases <a,b>` runs some of them.

### The schedule

Each enabled source has its own job, so one failing source does not stop the
others. The jobs run once a day, 20 minutes apart, starting at 11:00 UTC, in
this order: wiki, Drive, Fireflies, Gmail. A job that finds sign-in not set
up exits without reading anything.

To run a source from the owner's machine:

```
python -m pullers.runner --source wiki --dry-run
python -m pullers.runner --source wiki
```

The second form does the real work, including model calls.

### The curator timer

When the curator runs (migration 0057, decided 2026-11-20): there is no interval to choose. New source items wake it at once (a trigger on `source_items`), at most once every 2 minutes; a minute job (`kbe-curator-wake`, plain SQL) wakes it again only when items arrived since the last wake are still waiting; and a fixed hourly tick (`kbe-curator-tick`, minute 0) always runs as the safety net for retries, missed items, summaries, history pruning and the nightly backup. An hour with nothing waiting spends no model tokens.

On an Engine set up from the app, use the **Timer** setup screen (`/setup/timer`): it shows the full tick address, has one switch (curator on or off), makes the timer secret inside the database, schedules both cron jobs, and has a **Test the timer now** button that shows what the poke got back. The model key goes in on the **Model key** screen, and the templates on the **Template** screen (they are no longer a column of `curator_settings`; migration 0054 moved them to `engine_templates`). The SQL below is the same thing by hand.

The curator and the service's own chores run when Supabase cron pokes
`POST /internal/curator/tick`. Nothing in this repository creates the cron
job; an operator does, once, in the SQL editor:

```sql
-- 1. Two secrets in the vault (never in a table or the cron command):
select vault.create_secret('<64 random characters>', 'kbe_tick_secret');
select vault.create_secret('<DigitalOcean model access key>', 'kbe_model_key');
-- 2. Where to poke, the model, the templates, and on:
update workspace.curator_settings
   set engine_url = 'https://<engine host>/internal/curator/tick',
       model = 'openai-gpt-oss-120b',      -- or 'deepseek-v4.1-flash'
       enabled = true;
-- 3. The timer (needs pg_cron and pg_net). This creates both jobs with
--    commands that name the schema the curator functions live in:
select workspace._curator_cron_apply(true);
```

**One writer** (migration 0069, the default). Consensus is off and each item
goes through two steps:

1. **Triage** (`curator_settings.triage`, default on; `triage_model`, default
   `openai-gpt-oss-120b`). A cheap model reads the item (up to 360,000
   characters, numbered lines) and a compact page index, and answers whether
   anything is durable, which pages to update, which new pages may be needed,
   which line ranges matter, and a short summary. Nothing durable: the item
   ends as "no change" and the writer is never called. A triage reply that
   cannot be read never drops an item: the writer reads it as before.
2. **Writer** (`writer_model`: `anthropic-claude-sonnet-5.5`, the default, or
   `anthropic-claude-5.5-haiku`). It reads only the pages triage named (and
   pages the item's addresses match), up to 20 other page titles, and the
   item whole when it is at most 16,000 characters, else triage's excerpts
   and summary. Its fixed instructions are the system prompt, which
   DigitalOcean caches for Anthropic models (cache reads cost a tenth of
   input).

```sql
update workspace.curator_settings set writer_model = 'anthropic-claude-5.5-haiku';
update workspace.curator_settings set triage = false;      -- writer reads every item
update workspace.curator_settings set consensus = true;    -- back to consensus (below)
```

**Cost.** Each run records tokens and USD per model in its stats
(`tokens_in:<model>`, `tokens_out:<model>`, `cache_read:<model>`,
`cache_write:<model>`, `usd:<model>`, `usd`), priced from the table in
`engine/src/curator/prices.ts`: DigitalOcean list prices
(docs.digitalocean.com/products/inference/details/pricing/, read 2026-11-22).
Engine > Pipeline shows the cost this month and per item
(`app_curator_cost`), and Engine > Ledger the spend by day and role
(`app_ledger`, 0071; the Cataloguer's summaries are their own line and bar
from 0075, from the run stat `usd_summaries`). The DigitalOcean invoice is the final word; when a
price changes, change the table.

| Model | In | Out | Cache read | Cache write |
|---|---|---|---|---|
| `openai-gpt-oss-120b` | 0.10 | 0.70 | | |
| `anthropic-claude-5.5-haiku` (up to 100k input) | 0.10 | 0.50 | 0.01 | 0.125 |
| `anthropic-claude-5.5-haiku` (over 100k input) | 0.50 | 2.50 | 0.05 | 0.625 |
| `anthropic-claude-sonnet-5.5` | 2.00 | 10.00 | 0.20 | 2.50 |

**Pipeline and Ledger (0071).** Engine > Pipeline (`/setup/pipeline`; the
old `/setup/indexing` redirects there) draws the curator as a publishing
line and holds a few safe choices; Engine > Ledger (`/setup/ledger`) shows
this month's spend, the month-end projection and a budget (default $25).
Administrators read both; only the Engine owner changes a choice, and the
database checks the owner and the value again (`app_pipeline_set`). Every
change is in `workspace.pipeline_settings_log` with its time and who made it.

| Choice | Values | What it does |
|---|---|---|
| Author | best, budget | `curator_settings.writer_model`: Sonnet 5.5 or Haiku 5.5 |
| Desk editor | keep_more, normal, keep_less | one line in the triage prompt |
| Archivist | rarely_new, normal | rarely_new lowers the name-match threshold by 0.05 (not below 0.5) |
| Publisher | never, big_changes | big_changes also asks before an update removing 20% of a page; the built-in checks always ask |
| Cataloguer | short, standard | the summary prompt asks for 1 or 2 sentences (300 characters) or 2 to 4 (600); 0075 |
| Librarian | 60, 90, 180 days | when a page counts as stale |
| Pause | pause, resume | a pause ends by itself after 24 hours |
| Budget rule | 50 to 100%, warn or switch | switch moves the Author to budget once a month (logged as "budget rule") |

**The Pipeline cards.** Each of the twelve cards (three rows of four) has the same parts: a number,
the step's name and light, what it does, a fixed area for its choice ("Nothing
to set here" when it has none) and the last run. Each choice above sits on its
own card (Pause is a switch on the New mail alert card). The choices are
saved through the same `/setup/pipeline/set` form and `app_pipeline_set`.

**Cataloguer and Index clerk (0075).** The step after publishing. For each
page with `summary_queued_at` set, the curator asks the summary model for a
summary (the Cataloguer) and files it with its gte-small embedding (the Index
clerk) through `curator_summary_write`. A run records `summaries`,
`summary_failed` (an unusable reply or a model error), `index_failed` (a good
summary that could not be embedded or saved), `usd_summaries` and
`summary_model`; the page stays queued either way. The Cataloguer card reads
the pages waiting and the latest run that wrote summaries; the Index clerk
card reads pages with an embedding, pages waiting, and `index_missing` (no
embedding and not queued). **Try a search** (`POST /setup/pipeline/search`,
any administrator, form token, the question in the body, never the address)
calls `app_index_search`, which runs `_pages_search_core`, the same search
`pages_search_by_oauth_subject` (the MCP `search` tool) runs, for the pages
that administrator may see; it shows the top five keys and their scores and
writes nothing. Under Details for experts: the summary model, the cost of
summaries over 30 days, the search model, and for the owner **Redo summaries
and index** (`GET /setup/pipeline/redo` shows the pages and an estimate from
the observed cost a summary, else the price table; `POST` with the form token
and `confirm=yes` calls `app_summaries_redo`, owner only in the database too,
which sets `summary_queued_at` on every live page, logs `redo_index` in
`pipeline_settings_log` and wakes the curator). The search model is not a
setting.

**Tickets (0072).** `workspace.pipeline_tickets` holds problems for a person,
with ids `QB-0001` upward, and `workspace.pipeline_ticket_notes` their notes.
`_tickets_sync()` looks at the alert sources and opens a ticket, or marks an
open one seen again:

| Kind | Step | Opens when |
|---|---|---|
| `curator_failed` | Author | the latest finished curator run failed |
| `stuck_run` | Mailroom | a running run's lease ran out over 5 minutes ago, or it is over 30 minutes old |
| `timer_failed` | New mail alert | a timer cron job's last run failed (one ticket per job) |
| `poke_failed` | New mail alert | 3 or more pokes failed in 24 hours, the latest in the last 2 hours |
| `budget_warn` | Author | this month's spend passed the budget rule |
| `budget_switch` | Author | the budget rule switched the Author to Budget this month |
| `items_failed` | Author | items the curator gave up on (0073) |
| `summary_failed` | Cataloguer | the latest run that wrote summaries could not write some (0075) |
| `index_failed` | Index clerk | the latest run that wrote summaries could not file some in the search index (0075) |
| `reviews_waiting` | Publisher | changes wait for a person's yes |
| `held_mail` | Mailroom | mail is held because it looked like orders |

There is one open ticket per `dedupe_key`. `reviews_waiting` and
`held_mail` are to-dos (0073): when the queue is empty they close by
themselves (`closed_by` "the Engine", with a note). Every other kind is a
fault: when the cause clears, `cleared_at` is set, the screens say "looks
fixed since" and show an amber "Check and close" badge instead of the red
"Needs you", and only a person closes it (`app_ticket_close`, the Close
button on `/app/tickets/<id>`). The checks run:

- every hour, from the timer: `curator_tick_poke()` runs them before it
  pokes the service (the cron command is unchanged, so no job needs saving
  again; a failing check is logged as a warning and never stops the poke);
- at the end of every curator run: the service calls `curator_tickets_sync()`
  (a failure is logged, never fails the run);
- whenever the list is read (`app_tickets_list`, the Pipeline page, To do,
  and Claude's `list_tickets`).

Administrators read tickets, add notes and close them. Claude's tools
`list_tickets`, `get_ticket` and `add_ticket_note` use their own database
functions (`admin_tickets_list`, `admin_ticket_get`, `admin_ticket_note`);
there is no closing function for Claude.

Check it: `select ref, kind, status, cleared_at from workspace.pipeline_tickets order by id desc limit 10;`

(USD per million tokens.) A template's `required_when` pattern is a hint in
the prompt, never a failure.

With consensus on, the strong model (migration 0067) is asked only where judgement matters: a
new page in, or an update to a page in, a drawer marked `judgement: high` in
the templates (base: concepts, decisions, research, playbooks); an item whose
consensus runs were uncertain; and an item whose two primary runs agreed on
less than the templates' `low_agreement` share of their decisions (default
0.5). Everything else stays on `model` (with consensus). Every item logs
"curator: strong model routing" with why it was, or was not, escalated. If the
strong model fails, the primary plan is used. Allowed values and DigitalOcean
serverless prices (USD per million tokens in / out, November 2026):

| `strong_model` | In | Out | Note |
|---|---|---|---|
| `deepseek-v4.1-flash` (default) | 0.30 | 1.20 | Beat `openai-gpt-oss-120b` slightly in test A1 |
| `deepseek-v4-pro` | 1.74 | 3.48 | Stronger DeepSeek; about 3 to 6 times the default |
| `glm-5.3` | 1.40 | 4.40 | Best page choice and writing in A1, but long replies were cut off there |
| `anthropic-claude-sonnet-5.5` | 2.00 | 10.00 | Strongest on the list; most expensive |
| `openai-gpt-oss-120b` | 0.10 | 0.70 | Same as the primary: turns routing off in effect |

An escalated item adds one call of roughly 12k input and 1k output tokens:
about $0.005 on the default, $0.025 on `deepseek-v4-pro`, $0.034 on
`anthropic-claude-sonnet-5.5`.

```sql
update workspace.curator_settings set strong_model = 'deepseek-v4-pro';
```

**Output limits** (migration 0068). Each model asks for its own number of
output tokens: 4,096 for `openai-gpt-oss-120b` (its DigitalOcean cap), 16,384
for the reasoning models (`deepseek-v4.1-flash`, `deepseek-v4-pro`,
`glm-5.3`, `anthropic-claude-sonnet-5.5`), which spend much of the budget
thinking before the JSON. `curator_settings.max_output_tokens` overrides any
model (256 to 65,536 each). A reply cut off at the limit
(`finish_reason=length`) is never parsed: the curator asks once more with
twice the room, and if that is cut off too, the run counts as failed.

```sql
update workspace.curator_settings
   set max_output_tokens = '{"deepseek-v4.1-flash": 24000}';
```

The same run also starts the nightly look-alike check once a day
(`curator_duplicates_scan`): pages in the same drawer and topics that share an
address or domain, a name, or a very similar summary go on each owner's
**Possible duplicates** list (`/app/duplicates`). Nothing is merged unless the
owner presses Merge there.

(With another schema name, use it in place of `workspace`. Saving the Timer
screen does the same. Never write the job commands by hand with `public.`:
the functions live in the Engine's schema, and such a job fails every run.)

Each poke sends the vault secret in the `X-Kbe-Tick` header. The service
does not hold the secret: the database compares what arrived with the vault
copy. A wrong or missing secret gets 401. The service answers at once (202)
and runs in the background; a poke during a run answers `{"busy": true}`,
and only one run goes at a time across instances.

Every run, whether or not the curator is on:

- reads failed pokes since the last run from `net._http_response` (cron
  reports success even when the HTTP call failed) and logs them;
- thins page history (`page_history_prune`): every version for 30 days, then
  the latest of each day up to a year, then the latest of each month; the
  newest 10 versions of every page are always kept, whatever their age.

When the curator is on and `kbe_model_key` is in the vault it also applies
approved reviews, curates up to `batch_size` items (default 10) and writes
up to 20 page summaries. `curator_runs` keeps one row per run with its
counts.

**Is it firing?** (migration 0064, after the 2026-11-21 stall.) Every poke
writes one log line: `curator tick accepted`, `curator tick busy` or
`curator tick rejected` (with the reason, never the secret), and every run
writes `curator run started` and then `finished`, `failed` or `skipped:
another run holds the lease`. A run holds a 3-minute lease renewed every
minute, so a run whose service died or restarted is reclaimed within 3
minutes (and on the next boot at once); a run is recorded as failed after 20
minutes whatever it is waiting on, and every database call times out after
60 seconds. The Timer and Pipeline screens show both cron jobs with their
last run (`cron.job_run_details`), failed pokes of the last 24 hours
(`net._http_response`), when the service last received a poke, and the run
that holds the lease. "No poke received" with jobs scheduled points at
pg_cron or the edge; "pokes received, busy" points at a stuck run.

**First load.** For a large backlog, poke once with batch mode; it keeps
claiming items until none are left or about 12 minutes have passed:
`select workspace.curator_tick_poke('batch');`

**Sign-in in front of the service.** The tick path carries no Cloudflare
Access sign-in. The sign-in setup (the `/setup` page or `kbe access setup`)
now adds a bypass application for `/internal/curator/tick` only. An Engine
whose sign-in was set up earlier needs the sign-in setup run once more, or
the pokes are stopped at the edge (the Timer screen's test shows 302 or 403).

**Stopping it.** `update workspace.curator_settings set enabled = false;`
stops curation at the next run and stops the wakes; the chores go on. `select
cron.unschedule('kbe-curator-tick'); select cron.unschedule('kbe-curator-wake');`
stops the timer.

## The Engine's hostname on DigitalOcean

DigitalOcean's edge only answers for hostnames listed on the app; any other
Host gets "not found". The sign-in setup points DNS at the app in Cloudflare
but does not add the hostname to the app (seen live 2026-11-20). Add it once:

1. DigitalOcean: your app, **Settings**, **Domains**, **Add domain**.
2. Type the hostname. Choose **You manage your domain** (Cloudflare holds the
   DNS; do not let DigitalOcean change it). Save; the app redeploys.
3. Or: `doctl apps spec get APP_ID > spec.yaml`, add
   `domains: [{domain: <host>, type: PRIMARY}]` at the top level, then
   `doctl apps update APP_ID --spec spec.yaml`.

The Health screen (`/setup/health`) checks it: "Hostname reaches the app"
posts to the timer path without a secret and expects this app's own 401.
Setup does not do this itself: it would need a DigitalOcean token with
rights over every app on the account, one more secret to ask for and keep.

## The issue log

The Engine keeps one table of its own problems.

| Category | Logged by | Meaning |
|---|---|---|
| `source_failure` | A job | A run failed. Repeats update the same issue and count up |
| `config_invalid` | The wiki job | `engine.yaml` in the knowledge repo is not valid. The last good config stays in force |
| `data_quality_issue`, `feature_gap`, `friction_point` | A signed-in person, through the `report_issue` tool in Claude | Something wrong, missing or awkward. At most 10 reports per person per hour |
| `unknown_tag` | A job | One issue per source while any of its documents carries a tag that names no topic. Holds a count and the tag texts, never a title. Closes on the first run with none left |

An issue holds a category, a source name, an error class and a short message
with content removed. It never holds document text, a document title or a
participant's name.

A `source_failure` issue closes by itself on that source's next clean run.

### Reading it

- `python -m kbe issues list` lists the open issues, newest first. `--all`
  adds closed ones (the newest 200). `python -m kbe issues show <id>` shows
  one issue with its detail. Both are read-only and answer administrators
  only (`--as EMAIL` names one; the default is the owner).
- The status page lists the open issues under its **Support** menu, with
  the number fixed in the last 30 days, the Care Plan line and whether the
  newest config is in force.
- An administrator can ask Claude: the connector tool `admin_list_issues`
  returns the open issues. Other people do not have the tool.
- Curator and timer problems are Pipeline tickets (see "Tickets (0072)"):
  To do, the red "Needs you" badges on Engine > Pipeline, or Claude's
  `list_tickets`.
- `python -m kbe sources list` shows which source is failing.
- The job's Runtime Logs in the DigitalOcean dashboard show the error.
- With support access on, a support person reads the same view. See
  [care-plan.md](care-plan.md).

### Acting on it

| Issue | Usual cause | Action |
|---|---|---|
| A source keeps failing | An expired or revoked credential | `python -m kbe sources <wiki\|fireflies\|drive\|gmail> check`, then rotate the secret |
| `unknown_tag` | A mistyped tag, or a topic removed from the config | `python -m kbe tags audit --source <name>` lists the items; fix the tag at the source, or add the topic |
| `config_invalid` | A bad edit | `python -m kbe config validate <path>`, fix, commit, push, `python -m kbe config apply <path>` |
| A job logs "setup not complete" | No sign-in settings | `python -m kbe access status`; finish setup |
| Search results are thin | Sources have not run, or documents are untagged | `python -m kbe sources list`, `python -m kbe tags audit` |

## Updates

Every Engine builds from the same public repository, branch `stable`. A fix
reaches an Engine when its app is deployed again.

**The Updates screen** (**Staff & settings > Updates**, `/setup/updates`,
administrators) shows the version this Engine runs, the newest release on
the public repository's `stable` branch (`QB_RELEASE_REPO`, default
`imagicrafter/quantabase`; `VERSION` and `CHANGELOG.md` read over HTTPS
with no token, kept for an hour), what is new since (changelog text, shown
as plain text), and how to update: a link to the app in the DigitalOcean
dashboard (straight to it when the app spec passes `APP_ID`, else the apps
list) with **Actions → Force Rebuild and Deploy**, then `/setup/database`.
It also says "Database update needed: N pending" when migrations are
waiting. When GitHub cannot be reached it says "Could not check for updates
just now" and the rest of the screen still works. A one-click update (app
and database together) is a future requirement; today it is these two steps.

**An Engine made with the "Deploy to DigitalOcean" button** (README) does
not update itself: a new release on `stable` changes nothing until the
owner redeploys. In the DigitalOcean dashboard open the app, then
**Actions -> Force Rebuild and Deploy**. Then open `/setup/database` (an
administrator, after sign-in): it lists the migrations the release brings
that the database does not have yet and applies only those with a Supabase
access token used once and never kept (or run `python -m kbe db migrate`).
Until then the app logs `database update needed` at boot with the pending
file names, and Health, Pipeline and any screen whose database function is
missing show "Database update needed: N pending". Read `CHANGELOG.md` first.

**An Engine deployed with `kbe deploy`**:

```
git pull
python -m kbe db migrate --dry-run
python -m kbe db migrate
python -m kbe deploy render
python -m kbe deploy apply --dry-run
python -m kbe deploy apply
python -m kbe deploy redeploy
python -m kbe deploy status
```

- Read `CHANGELOG.md` first. It says when a release needs more than this.
- Database first, then the app. New code expects the new database.
- `deploy apply` reads the live spec, keeps every stored secret value, and
  shows a diff of the rest. It lists the app's secrets by name only: DigitalOcean
  does not reveal which ones hold a value. For a new secret a release adds,
  put it in the local env file and run `python -m kbe deploy secrets push`
  (a preview; `--yes` sets it), or enter it in the dashboard.
- `migrate` refuses to run if an applied file has changed. Do not edit
  migration files. If this happens after a `git pull`, stop and read the
  release notes.

There is no automatic update. `deploy_on_push` is off: an Engine changes
only when its owner deploys.

**After 0077 (names on pages).** An Engine set up before 0077 stored the
owner's email as their display name, so pages say "the owner". Open
**Staff & settings > People**, card **Your name**, and set the name used on
pages (for example your first name). New curation uses it at once; pages
already written keep their words until you ask Claude to fix them with
`update_page`.

### Rolling back

- **The app:** in the DigitalOcean dashboard, the app's Activity tab can
  roll back to an earlier deployment.
- **The database:** migrations are not reversed automatically. Each file
  ends with the statements that undo it, as comments, for a person with
  database access to run by hand. Restore from a backup if in doubt.

## Backups

What holds what, and how it is protected:

| Data | Where the original is | Backup |
|---|---|---|
| Pages (in the database) | The database | Supabase backups, and the nightly GitHub backup below |
| Wiki pages and the config (repo mode) | The knowledge repo on GitHub | Git history; every clone is a copy |
| Drive files, meeting recordings | Google Drive, Fireflies | Those services |
| The index (raw captures, documents, summaries, vectors) | The database | Can be rebuilt by running the jobs again |
| People, topic grants | The database only | Supabase backups |
| Review decisions (what is approved) | The database only | Supabase backups |
| The issue log, run events | The database only | Supabase backups |
| Sign-in settings | The database; the originals are in Cloudflare | Can be stored again with `kbe access adopt` |
| Secrets | The owner's password manager, the DigitalOcean dashboard | The owner's password manager |

Supabase backs up a project's database on a schedule that depends on the
plan. Check the project's backup settings and current plan terms. The
people, grants and review decisions exist nowhere else, so they are what a
database backup is for.

To keep an extra copy of the people and grants as text:

```
python -m kbe people list --json
```

The output has names and emails but no secret. Store it somewhere private.

### The nightly GitHub backup

The Engine owner can have every page written to one **private** GitHub
repository each night (`/setup/backup`). The files open as an Obsidian
vault: one Markdown file per page named by its title, a folder per drawer,
the header as frontmatter (`title`, `aliases`, `description`, `type`, `key`,
`owner`, `topics`, `status`, `tags`, `related`, `sources`, the drawer's
fields), links written as `[[Title]]`, and a generated `index.md` (pages by
drawer) and `log.md` (recent changes). A rename is a file move in the same
commit.

- **One way.** The database always wins. The whole branch is rewritten from
  the database each run; anything edited in the repository is overwritten,
  and nothing is read back. A night with no change makes no commit.
- **Owner only.** The repository holds every person's pages with no sharing
  rules, so only the Engine owner (the config's `engine.owner.email`, else
  the first administrator) can see or change this screen. The run refuses a
  public repository.
- **The token.** A fine-grained GitHub token for that one repository, with
  *Contents: read and write*. It is typed into the screen and kept in
  Supabase Vault (`kbe_backup_token`); it is never shown again, logged or
  stored elsewhere.
- **When.** On the curator timer (Timer screen), at most once every 20
  hours. **Back up now** on the screen runs one within a minute: it makes
  the run due and wakes the curator the way the Timer screen's test does (a
  backup that is already running is left alone). Without a saved timer it
  waits for the next timer run.
- **The screen.** Every save (token, repository settings, Back up now)
  returns to `/setup/backup` with a short notice ("Token saved", "Backup
  settings saved", "Backup started", or the error with the other fields
  still filled in) and the next step to take.
  The last run's result (done, unchanged or failed, with the reason) is on
  the screen.
- **Identities.** Each page also carries what its key stands for, as a
  wiki would write it: `email` on a person, `domain` on an organisation,
  `fireflies_id` on a meeting (never over a field of the same name). A field
  that shares a header line's name is written `field_<name>`.

### Restoring pages from the backup

Restore one person at a time from a checkout of the backup repository.
Apply migration 0078 first (Database screen, or `python -m kbe db migrate`):
without it a restore stops at its first page and says so.

```
python -m kbe pages import <checkout> --owner person@example.com --from-backup
python -m kbe pages import <checkout> --owner person@example.com --from-backup --keep-topics --apply
```

The first command only reports: how many of that person's pages it would
file, which files belong to someone else (skipped and listed: another
person's page never stands in for theirs), and what is not carried over.
`--apply` (after a yes; `--yes` to skip the question) files them. A key the
person already holds is left alone, so a second run only adds what is
missing. Run it again with each person's `--owner` to restore everyone.
A plain `kbe pages import` of a backup checkout is refused.

What a restore keeps, page by page:

| Kept | How |
|---|---|
| The key | as written in `key` (never re-derived), so links, lookups and the curator's matching still find the page |
| Identities | other addresses and domains (the `emails` / `domains` fields) and the meeting's Fireflies source |
| Title, aliases, description, status, tags, template, generated, verified | as written |
| Fields | every other frontmatter line, `field_<name>` back to `<name>` |
| Sources | as written |
| Related pages | `[[Title]]` turned back into the keys of the pages they name |
| The body | exactly; links in it are `[[Title]]`, which the database resolves to the same pages |
| Links | rebuilt by the database from related, the body and tags, as on any save |
| Created and updated | the day only (the backup keeps no time of day) |
| Topics | only with `--keep-topics` (each page's own; the person must hold them, or the page is refused and listed) or `--topic` (the same topics for every page). Without either, the pages are the person's alone |

What a restore does not bring back, because the backup does not hold it:

- **Page history.** `log.md` lists recent changes by title only; a restored
  page starts with one history entry.
- **The reviewed date.** Restored pages show as not yet re-checked.
- **The time of day** of created and updated.
- **Everything that is not a page:** people and their topic grants, review
  decisions, the issue log, run events, source items and the index. These
  live only in the database, so they come back only from a **Supabase
  backup** (see the table above); the index is rebuilt by the jobs. Add the
  people and grants first (`kbe people add`, `kbe people grant`), then
  restore their pages.

## Importing an existing wiki

A one-time move of an OKF or Obsidian wiki (a folder of Markdown files with
frontmatter) into pages, for one person. Apply migration 0074 first (from
the Database screen): it lets the import keep dates and link attendees.

```
python -m kbe pages import ~/path/to/wiki --owner person@example.com
python -m kbe pages import ~/path/to/wiki --owner person@example.com --map import-map.yaml
python -m kbe pages import ~/path/to/wiki --owner person@example.com --map import-map.yaml --topic consulting --apply
```

The first command only reads the folder and reports: how many pages per
drawer, the key each gets, which keys fell back (a person page with no
`email`, an organisation with no `domain` or `website`, a meeting with no id),
which files are skipped, merged or shortened and why, how meeting attendees
link, the `--map` entries, how many pages keep their dates, and which
frontmatter keys are not carried over. `--json` lists everything. `--apply`
(after a yes; `--yes` to skip the question) saves them over the direct
database connection (`KBE_DATABASE_URL`).

- `type` picks the drawer (`person` -> people, `meeting` -> meetings,
  `company` -> organisations, `retrospective` -> playbooks, ...), else the
  folder name. Files that map to no drawer are skipped and listed (or
  refiled with `--map`).
- **Dates.** `created` and `updated` (else `timestamp`, `modified`,
  `last_updated`) become the page's own created and updated times and the
  date of its first history entry, so the Librarian's stale check sees how
  old the page really is. One date alone stands for both. A date in the
  future is dropped (and reported); a page with no date is dated today.
- `related` and `[[links]]` become links: the database resolves each title
  or alias to a page key as the pages are saved.
- **Meeting attendees.** Each name or email in a meeting's `attendees`
  becomes a link to a person page: by email first (the page's key or another
  known address), then by name or alias (only when exactly one page has it).
  Person pages in the same import are found in the dry run; the person's
  existing pages are checked as each meeting is saved. An attendee with no
  person page stays on the meeting as the field `attendees`. No person page
  is ever made for an attendee, including the Engine's own users.
- **Two files for one meeting id** become one page: the newer file (by
  `updated`, else `created`, else `date`) is the page and the other is added
  under `## Note: <its title>`. Any other repeated key is skipped and listed.
- **Long files.** A body over 200,000 characters is imported shortened to
  that limit, with a note at the top naming the original file.
- **Other frontmatter.** A drawer's own fields are kept (from any entity
  template; `company` / `organization` / `org` fill `organisation`).
  `summary` fills an empty `description`, and a meeting's `fireflies_id` is
  kept in its sources as well as its key. Everything else is listed in the
  dry run as not carried over.
- A key the person already holds is left alone, so a second run adds only
  what is new. Nothing is overwritten. People and organisations are saved
  first, so the meetings that follow can link to them.
- Pages get only the topics named with `--topic`, and only topics the person
  holds. Without `--topic` they are the person's alone.
- `index.md`, `log.md`, `README.md`, dot-folders, `templates/` and `sources/`
  are skipped.
- After the import, archive the old repository: the Engine is now the home
  of these pages.

### The map file (`--map`)

Optional. Use it to refile pages the frontmatter files wrongly, typically
companies kept as projects or concepts, and to make one page of two files
about the same company:

```yaml
files:
  "projects/Acme.md":              # path inside the wiki folder
    drawer: organisations
    key: acme.com                  # must fit the drawer's key rule (a domain here)
    aliases: [Acme Corp]
  "concepts/Acme notes.md":
    merge_into: "projects/Acme.md" # one page; both bodies under their own headings
create:                            # pages with no wiki file
  - name: Globex
    domain: globex.com
    aliases: [Globex Corp]
    # drawer: organisations        # the default
```

- `drawer`, `key` and `aliases` are each optional; a key replaces the one
  the frontmatter would give, and the frontmatter's other domains (or
  addresses) are kept as the page's identities.
- `merge_into` names another file in the folder. The merged page has the
  target's title and key, a `## <title>` section for each file (with the
  file it came from), both files' tags, links and sources, the other
  title as an alias, and the earliest created and latest updated date. A
  merge into a file that is itself merged, or into itself, is refused.
- A `create:` entry needs a `name` and a `domain` (or `key` for another
  drawer). A key already taken by a file is skipped and listed.
- Every problem in the file is listed at once, before anything is read.

## Server mode (the Python pullers)

The default Engine is one service: sources come in through each person's
Claude (the plugin, `docs/plugin.md`) and the curator runs inside the
service. The Python pullers in `pullers/` (wiki repo, Drive, Fireflies,
Gmail on a schedule) are **server mode**, off by default:

- the "Deploy to DigitalOcean" button never creates puller jobs;
- `python -m kbe deploy render` adds them only with `--server-mode` (one
  scheduled job per source enabled in the config). The choice is remembered
  for the next render; `--no-server-mode` turns it off again.

To turn server mode on for an Engine deployed with `kbe deploy`:

```
python -m kbe deploy render --server-mode
python -m kbe deploy apply --dry-run
python -m kbe deploy apply
python -m kbe deploy secrets push
```

The jobs need their own secrets (the model key and each source's
credentials; `deploy render` lists them). Turning it off and applying
removes the jobs (`deploy apply` asks before it deletes a live component).

## Restoring

### The database is lost, everything else is intact

1. Restore the Supabase backup if there is one. Then run
   `python -m kbe db migrate --dry-run` to confirm nothing is pending, and
   `python -m kbe verify`.
2. With no backup, build a new database:

   ```
   python -m kbe db migrate
   python -m kbe db expose-schema
   python -m kbe db deploy-functions
   python -m kbe config apply <knowledge repo>/.kb-engine/engine.yaml
   ```

   Mint the embed token again and enter it in the dashboard
   (`python -m kbe tokens mint --embed --write-env --clipboard`: the token
   goes into the local env file and onto the clipboard, and is not printed).
   Store the sign-in settings again. Their values are in the Cloudflare
   dashboard: the team domain, and the AUD tag of each of the two
   applications.

   ```
   python -m kbe access adopt --team-domain https://<team>.cloudflareaccess.com --aud <AUD> --status-aud <AUD> --host engine.example.com --level people --dry-run
   ```

   Add the people and grants again (`kbe people add`, `kbe people grant`).
   The jobs rebuild the index on their next runs. Review decisions are not
   rebuilt: everything is unreviewed again.

   If the project itself is new, the three Supabase secrets on every
   component change too.

### The app is lost

```
python -m kbe deploy render
python -m kbe deploy apply
```

With no app id in local state this creates a new app. Enter every secret
again. The new app has a new address of its own, so the DNS record must
point at it: reopen setup (`kbe access reopen`) and run the setup page, or
change the CNAME in Cloudflare by hand. (`kbe access setup` is for an Engine
that has no sign-in yet; here sign-in exists, so the page is the way.)

### The owner's machine is lost

Clone this repository and the knowledge repo again. Make a new `.env` from
`.env.example`. The local state file is gone; pass `--app-id`, `--path` and
`--as` where a command asks, or run `kbe deploy status --app-id <id>` and
`kbe config apply` once to record them again. Rotate any secret that was
only on that machine.

## Removing a deployment

There is no single command. In this order:

1. **Support access**, if on: `python -m kbe support disable`.
2. **The app:** `doctl apps delete <app id>` (the id is shown by
   `python -m kbe deploy status`). Billing for the app stops.
3. **Cloudflare**, in the dashboard: the applications `KB Engine: <host>`
   and `KB Engine admin pages: <host>`, the rules
   `KB Engine sign-in: <host>` and `KB Engine administrators: <host>`, and
   the CNAME record for the hostname.
4. **The database:** delete the Supabase project. If the project is shared
   with something else, a person with database access drops the Engine's
   schema and the roles `kb_engine`, `kb_ingest` and `kb_support` instead,
   and deletes the `embed` function.
5. **Credentials:** delete the GitHub token, the Fireflies API key if it was
   made for this, the DigitalOcean inference key, and the app's access in
   the Google account (myaccount.google.com/permissions).
6. **The owner's machine:** delete `.env` and `.kb-engine-local/`.

The knowledge repo is the owner's and stays. Nothing in the sources is
touched by removing an Engine.
