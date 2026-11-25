# Configuration reference

The Engine is configured in two places.

1. **`engine.yaml`** holds everything that is safe to commit: the owner, the topics, the sources, the status page. It lives at `.kb-engine/engine.yaml` in the owner's private knowledge repo and is applied to the database.
2. **Environment variables** hold credentials and a few per-machine settings. They are never committed.

Related pages: [manual.md](manual.md) (day-to-day use), [build-manual.md](build-manual.md) (first setup), [architecture.md](architecture.md), [operations.md](operations.md), [security.md](security.md), [tagging.md](tagging.md), [care-plan.md](care-plan.md).

A note on words. This page says **topic** for what the config file and the code call a **domain** (`domains`, `default_domain`). A topic decides who can see a document.

---

## Part 1: `engine.yaml`

### How the file is checked

The shape of the file is written once, as the zod schema in `engine/src/config/engine-config.ts` and `engine/src/config/dashboard-schema.ts`. Everything else follows from it:

| Part | File | Used by |
| --- | --- | --- |
| The schema (the source of truth) | `engine/src/config/engine-config.ts`, `engine/src/config/dashboard-schema.ts` | the service |
| The generated schema | `config/schema.json` | editors, the Python validator |
| The Python validator | `scripts/knowledge/engine_config.py`, `scripts/knowledge/engine_config_schema.py` | the `kbe` CLI, the scheduled jobs |
| The shared test files | `config/fixtures/valid/*.yaml`, `config/fixtures/invalid/*.yaml` | both test suites |

`config/schema.json` is generated from the zod schema (`npm run gen:schema` in `engine/`). Do not edit it by hand; a test fails when it is stale. The Python validator checks a file against that generated schema with the `jsonschema` package, so it accepts the same keys, types and forms as the service, the whole `dashboard` section included. The rules a schema file cannot hold (the [cross-field rules](#cross-field-rules)) are written once on each side.

Both test suites run every file in `config/fixtures/`. A file in `valid/` must be accepted by both validators and a file in `invalid/` must be refused by both. `config/engine.example.yaml` is a complete example that passes both.

Rules that apply to the whole file:

- An unknown key is an error in every section, `dashboard` included. A typo is reported, not ignored.
- A section written with nothing under it (for example `tagging:` on a line by itself) is `null`, and is refused. Leave the section out, or give it a value.
- The file is read as YAML 1.2 on both sides. Only `true` and `false` are booleans; `yes`, `on` and `off` are text. A date such as `2026-01-02` is text.
- An email address must pass the same rule on both sides.
- Both validators list every problem they find, not only the first.

A config written for an earlier release may still hold `dashboard.knowledge.sources[].business`. That key was removed. Delete those lines, or the file is refused.

### How the file is applied

The service and the jobs do not read the file from disk. They read the copy stored in the database (`engine_settings` table, one row). A change takes effect when that copy is replaced.

**Check a file.** Nothing is changed.

```
python -m kbe config validate .kb-engine/engine.yaml
```

**Apply a file by hand.**

```
python -m kbe config apply .kb-engine/engine.yaml
```

`config apply` does three things in order (`scripts/kbe/config_cmd.py`):

1. Validates the file, then prints a diff against the config the database holds now: topics added, removed or changed, sources turned on or off, the owner.
2. Asks for a yes. `--yes` skips the question. `--dry-run` stops after the diff.
3. Calls the database function `engine_config_apply`. The function runs in one transaction. If any step refuses, nothing changes.

`--via api` reaches the database through the REST API with `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_JWT_SECRET`. `--via db` uses `KBE_DATABASE_URL`. The default, `--via auto`, uses the API when its three values are set and the database URL otherwise. Both act as the `kb_ingest` role.

**Automatic apply.** The wiki job has the knowledge repo checked out. On each run, before it ingests any page, it calls `apply_from_checkout` in `pullers/config_sync.py` (called from `pullers/wiki.py`). `kbe deploy render` schedules the wiki job once a day at 11:00 UTC. The function does this:

| Situation | What the job does |
| --- | --- |
| No `.kb-engine/engine.yaml` in the checkout | Nothing. |
| The file differs from `origin/main` in the checkout (an edit that was not pushed) | Nothing. Only what is on the main branch is applied. |
| The file is valid and its hash equals the applied config's hash | Nothing. An open config issue is closed. |
| The file is valid and changed | Applies it with `engine_config_apply`, closes an open config issue, and uses the new config for the rest of the run. |
| The file is invalid | Rejects the whole file. The previous config stays in force. Opens an issue (category `config_invalid`, key `config`). |
| The database refuses the file (see the rules below) or cannot be reached | The previous config stays in force. Opens the same issue. |

The issue never holds text from the file. It holds a count of problems, or the class of the refusal. The function never raises, so a bad config does not stop the wiki from being indexed under the config that is still in force. The service caches the stored config for one minute (`engine/src/config/settings.ts`).

### Rules the database enforces

These are checked by `engine_config_apply` and `domains_apply` (`supabase/migrations/0029_engine_settings.sql`, `0030_domains_from_config.sql`). They hold no matter which tool applies the file.

| Rule | Detail |
| --- | --- |
| `unclassified` is reserved | It always exists and is always sensitive. It may not be declared in `domains`. It is granted to the owner and to nobody else. Any other grant on it is removed on each apply. |
| A sensitive topic cannot be unlocked by a config | A topic may go from `sensitive: false` to `sensitive: true`. The reverse is refused. An administrator unlocks a topic by hand. |
| A topic in use cannot be removed | Removing a topic from `domains` is refused while any document still carries it, or while anyone is still granted it. Grants are not deleted for you. Retag the documents and remove the grants first, then apply again. |
| The owner is created once | On the first apply, when the Engine has no active administrator, the address in `engine.owner.email` becomes an administrator. After that, a config that names an owner who is not already an active administrator is refused. Changing the owner is an administrator's act. |
| All or nothing | A refused apply changes nothing. The last good config stays in force. |

### What cannot be changed later

| Setting | Why |
| --- | --- |
| `engine.owner.email` | Refused once an administrator exists, unless the new address already belongs to an active administrator. |
| `domains[].sensitive` from `true` to `false` | Refused by the database. |
| `domains[].id` | A topic id cannot be renamed. A new id is a new topic, and the old one can only be removed once no document and no grant uses it. |
| `tagging.prefix`, `tagging.frontmatter_key`, `sources.gmail.prefix` | The database accepts a change. Tags already written in files, descriptions, channels and mail labels keep the old form and stop matching. Treat these as fixed after the first ingest. See [tagging.md](tagging.md). |

<!-- config-keys:start -->

### Top level

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `version` | number | required | Must be `1`. |

The top-level sections are `engine`, `domains`, `tagging`, `sources`, `models`, `dashboard` and `support`. Only `version` and `engine` are required.

### `engine`

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `engine.id` | string | required | Short id of this Engine, for example `acme`. Starts with a lower-case letter, then lower-case letters, digits and dashes. |
| `engine.name` | string | required | Display name. Not empty. Also the default title of the status page. |
| `engine.owner.email` | string | required | The owner's sign-in address. Becomes the first administrator on the first apply. Cannot be changed by a config once an administrator exists. |
| `engine.owner.names` | list of strings | `[]` | How the owner appears in meeting notes. Used to recognise the owner among meeting attendees. The first entry is the display name of the administrator created on the first apply. Entries must not be empty. |
| `engine.owner.emails` | list of strings | `[]` | Every other address that is the owner. Used together with `engine.owner.email` to recognise the owner in meetings. Each entry must be an email address. |

### `domains`

One entry per topic. The code name for a topic is "domain".

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `domains` | list of objects | `[]` | The topics of this Engine. An id may appear once. `unclassified` may not be declared. |
| `domains[].id` | string | required | Topic id, for example `consulting`. Same pattern as `engine.id`. A tag is the prefix plus this id. Cannot be renamed. |
| `domains[].label` | string | required | Display name of the topic. Not empty. Can be changed at any time. |
| `domains[].sensitive` | boolean | `false` | A sensitive topic needs a deliberate grant. Can be turned on later. Cannot be turned off by a config. |

### `tagging`

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `tagging.prefix` | string | `kx/` | What a tag starts with. A tag is the prefix plus a topic id, for example `kx/consulting`. Not empty. Must end in a character that is not a letter or digit, such as `/` or `-`. Matching ignores case. |
| `tagging.frontmatter_key` | string | `domains` | The frontmatter key in wiki and meeting pages that lists a page's topics. Not empty. |

### `sources.wiki`

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `sources.wiki.enabled` | boolean | `false` | Turns the wiki source on. In server mode (`kbe deploy render --server-mode`) each enabled source gets one scheduled job. |
| `sources.wiki.repo` | string or null | `null` | The knowledge repo on GitHub as `owner/name`, for example `acme/knowledge`. Required when `sources.wiki.enabled` is `true`. |
| `sources.wiki.default_domain` | string or null | `null` | The topic given to a page with no topic tag. Must be a declared topic. `null` leaves such pages in `unclassified`. |

### `sources.drive`

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `sources.drive.enabled` | boolean | `false` | Turns the Google Drive source on. |
| `sources.drive.default_domain` | string or null | `null` | The topic given to a file with no topic tag. Must be a declared topic. `null` leaves such files in `unclassified`. |
| `sources.drive.include_mime` | list of strings | `[docs, sheets, slides]` | The kinds of file the Drive job indexes. Each entry is one of `docs`, `sheets`, `slides`, `pdf`. Only Google Docs have their text read; sheets, slides and PDFs are indexed by name, kind and folder. An empty list means the default. |
| `sources.drive.trust_tags_from` | string | `owner` | Whose description tags count. `owner`: a tag counts only on a file or folder owned by the Google account the Drive job signs in as; a tag on anyone else's item is ignored, as if it were not there, and the document is marked `ignored_foreign_tag`. `anyone`: a tag counts on every item the account can see. See [tagging.md](tagging.md). |

### `sources.fireflies`

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `sources.fireflies.enabled` | boolean | `false` | Turns the meetings source on. |
| `sources.fireflies.default_domain` | string or null | `null` | The topic given to a meeting with no topic tag and no mapped channel. Must be a declared topic. `null` leaves such meetings in `unclassified`. |
| `sources.fireflies.channels` | map of string to string | `{}` | Channel name to topic id. A meeting in a listed channel gets that topic. Each value must be a declared topic. The channel name is free text. |
| `sources.fireflies.write_meeting_pages` | boolean | `true` | Whether meeting pages are written to the knowledge repo. When `true`, `kbe deploy render` gives the meetings job the `GITHUB_TOKEN` secret it needs to push them. |
| `sources.fireflies.shared_meetings.enabled` | boolean | `false` | Also take meetings that someone else recorded and shared with the owner. |
| `sources.fireflies.shared_meetings.trusted_domains` | list of strings | `[]` | The only organizer email domains whose shared meetings are taken. Each entry is a lower-case domain such as `example.com`. An empty list accepts none. |

### `sources.gmail`

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `sources.gmail.enabled` | boolean | `false` | Turns the mail source on. Only labelled threads are indexed. |
| `sources.gmail.prefix` | string or null | `null` | Tag prefix for mail labels. `null` uses `tagging.prefix`. Same rules as `tagging.prefix`. |
| `sources.gmail.mailboxes` | list of objects | `[]` | Whose mailbox is read. At most one entry: one mailbox is supported for now. An empty list means the owner's mailbox (`engine.owner.email`). |
| `sources.gmail.mailboxes[].email` | string | required | The address of the mailbox. The stored Gmail sign-in must be for this address; `kbe sources gmail check` confirms it. Stored in lower case. |
| `sources.gmail.mailboxes[].owner_email` | string or null | `null` | The person who owns the threads read from this mailbox. `null` means the Engine owner. Stored in lower case. |

Who can see a mail thread is stricter than for other sources. The owner of the mailbox sees their own threads. Anyone else sees a thread only when it has been approved in review, they hold one of its topics, and its owner is still an active person. An administrator gets no way round this: an administrator sees approved mail in the topics an administrator holds (every topic that is not sensitive), and nothing else. See [security.md](security.md).

### `models`

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `models.distill.backend` | string | `do` | Which provider writes the retrieval summaries. Not empty. A deployed job can run `do` or `anthropic`; `kbe deploy render` refuses any other value. The render step copies it to the job as `KNOWLEDGE_MODEL_BACKEND`. |
| `models.distill.id` | string | `openai-gpt-oss-120b` | The model id at that provider. Not empty. Copied to the job as `KNOWLEDGE_MODEL_ID`. |

### `dashboard`

The whole section is optional. It describes what the status page shows. Without it the page shows the Knowledge and Security menus, built from the `sources` section.

Three value forms are used below:

- A **sensor** is a non-empty string that names a live check, written `kind` or `kind:argument`. The kinds are `connector_state:<source>`, `review_items:undecided`, `engine_health:<url>`, `agent_job:<profile>/<name>`, `host_state:<path>`, `workshop_jobs`, `github_prs:<owner>`, `client_inbox:<client>` and `static` (no live check).
- A **duration** is a whole number followed by `m`, `h` or `d`, for example `30m`, `26h`, `7d`.
- A **part name** is `knowledge.index`, `knowledge.<source id>` or `tools.<tool id>`.

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `dashboard.title` | string | value of `engine.name` | Title of the status page. |
| `dashboard.ask_claude_buttons` | boolean | `true` | Show the buttons that open a question in Claude. |

### `dashboard.menus`

The page has five menus. Each key lists the tabs to show under that menu. When `dashboard.menus` is left out, the page shows all Knowledge and Security tabs, the Tools tab `connected` if `dashboard.connect` is set, the Workers tab `tasks` and the Support tab `issues`. The Workers menu is hidden whenever no job has a `task`.

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `dashboard.menus.knowledge` | list of strings | `[]` | Allowed: `overview`, `sources`, `areas`, `review`. |
| `dashboard.menus.workers` | list of strings | `[]` | Allowed: `tasks`. |
| `dashboard.menus.tools` | list of strings | `[]` | Allowed: `connected`, `support_desk`. `support_desk` needs `dashboard.tools.support_desk.enabled: true`. |
| `dashboard.menus.security` | list of strings | `[]` | Allowed: `layers`, `people`, `systems`. |
| `dashboard.menus.support` | list of strings | `[issues]` | Allowed: `issues`. The Support menu shows the Engine's own issue log, the Care Plan line and whether the newest config is in force. It is shown unless this is set to an empty list. |

### `dashboard.connect`

Optional. When the section is present, `connector_url` is required.

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `dashboard.connect.connector_url` | string (URL) | required | The address people add as a connector, for example `https://engine.example.com/mcp`. |
| `dashboard.connect.login` | string | `email-code` | Short name of the sign-in method, shown on the page. |
| `dashboard.connect.status_page_url` | string (URL) | none | Address of the status page. |
| `dashboard.connect.status_page_login` | string | none | Short name of the sign-in method of the status page. |
| `dashboard.connect.status_page_aud` | string | none | AUD tag of the sign-in application that guards `/status`. It names the application and is not a secret. Used only when neither `CF_ACCESS_STATUS_AUD` nor the stored sign-in settings give one. |

### `dashboard.knowledge`

Optional. When the section is left out, the gauges are built from `sources`: one per enabled source, a search index gauge when the wiki is on, and a review queue gauge. When the section is present, `dashboard.knowledge.sources` is required.

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `dashboard.knowledge.index.label` | string | required | Label of the search index gauge. Required when `index` is present. |
| `dashboard.knowledge.index.sensor` | sensor | required | The check behind the gauge. |
| `dashboard.knowledge.index.schedule` | string | none | Schedule text shown next to the gauge. |
| `dashboard.knowledge.index.fresh_within` | duration | `26h` | The gauge is fresh while the last run is newer than this. |
| `dashboard.knowledge.index.alert_after` | duration | `48h` | The gauge raises an alert when the last run is older than this. |
| `dashboard.knowledge.sources` | list of objects | required | One gauge per source. |
| `dashboard.knowledge.sources[].id` | string | required | Id of the gauge. Workers refer to it as `knowledge.<id>`. |
| `dashboard.knowledge.sources[].label` | string | required | Label of the gauge. |
| `dashboard.knowledge.sources[].sensor` | sensor | required | The check behind the gauge. |
| `dashboard.knowledge.sources[].schedule` | string | none | Schedule text shown next to the gauge. |
| `dashboard.knowledge.sources[].connection` | string | none | Name of the system the source connects to, for example `Google Drive`. |
| `dashboard.knowledge.sources[].owner` | string | none | Whose account the source reads. |
| `dashboard.knowledge.sources[].share` | string | none | One line that tells people how to share an item with the Engine. |
| `dashboard.knowledge.sources[].enabled` | boolean | `true` | `false` shows the source as off. |
| `dashboard.knowledge.sources[].off_reason` | string | none | Why the source is off. Required when `enabled` is `false`. |
| `dashboard.knowledge.sources[].fresh_within` | duration | `26h` | The gauge is fresh while the last run is newer than this. |
| `dashboard.knowledge.sources[].alert_after` | duration | `48h` | The gauge raises an alert when the last run is older than this. |
| `dashboard.knowledge.review_queue.label` | string | required | Label of the review queue gauge. Required when `review_queue` is present. |
| `dashboard.knowledge.review_queue.sensor` | sensor | required | The check behind the gauge, normally `review_items:undecided`. |
| `dashboard.knowledge.review_queue.warn_over` | integer | `25` | The gauge warns when more items than this wait for review. |
| `dashboard.knowledge.area_notes` | map of string to string | `{}` | Topic id to a plain description shown on the Areas tab. A topic with no note shows its label. |

### `dashboard.workers`

Scheduled agents and their jobs. An Engine that names none shows no Workers menu.

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `dashboard.workers` | list of objects | `[]` | One entry per worker. |
| `dashboard.workers[].id` | string | required | Id of the worker. |
| `dashboard.workers[].role` | string | none | `caretaker` or `worker`. |
| `dashboard.workers[].label` | string | required | Display name. |
| `dashboard.workers[].does` | string | none | One line on what the worker does. |
| `dashboard.workers[].jobs` | list of objects | `[]` | The worker's scheduled jobs. |
| `dashboard.workers[].jobs[].sensor` | sensor | required | The check behind the job. A job with a `task` needs an `agent_job:` sensor. |
| `dashboard.workers[].jobs[].schedule` | string | none | The schedule in machine form. |
| `dashboard.workers[].jobs[].late_after` | duration | `26h` | The job counts as late when its last run is older than this. |
| `dashboard.workers[].jobs[].task` | string | none | Name of the outcome, shown under Workers. A job without one stays hidden. |
| `dashboard.workers[].jobs[].when` | string | none | The schedule in words, for example `Every 2 hours`. |
| `dashboard.workers[].uses` | list of strings | `[]` | Part names this worker uses. Each must name an existing part. |
| `dashboard.workers[].reports_to` | string | none | Who the worker reports to. |

### `dashboard.tools`

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `dashboard.tools.connected` | list of objects | `[]` | Tools shown on the Connected tab. |
| `dashboard.tools.connected[].id` | string | required | Id of the tool. Workers refer to it as `tools.<id>`. |
| `dashboard.tools.connected[].label` | string | required | Display name. |
| `dashboard.tools.connected[].does` | string | none | One line on what the tool is for. |
| `dashboard.tools.connected[].can` | list of strings | `[]` | What the tool can do, one short line each. |
| `dashboard.tools.connected[].sensor` | sensor | required | The check behind the tool. |
| `dashboard.tools.support_desk.enabled` | boolean | `false` | Turns the Support desk tab on. The whole `support_desk` section is optional. |
| `dashboard.tools.support_desk.note` | string | none | Text shown above the desk. |
| `dashboard.tools.support_desk.default_issue_source` | string | none | Label used for an issue that names no source. |
| `dashboard.tools.support_desk.tools` | list of objects | `[]` | Tools shown on the Support desk tab. |
| `dashboard.tools.support_desk.tools[].id` | string | required | Id of the tool. Workers refer to it as `tools.<id>`. |
| `dashboard.tools.support_desk.tools[].label` | string | required | Display name. |
| `dashboard.tools.support_desk.tools[].does` | string | none | One line on what the tool is for. |
| `dashboard.tools.support_desk.tools[].can` | list of strings | `[]` | What the tool can do, one short line each. |
| `dashboard.tools.support_desk.tools[].sensor` | sensor | required | The check behind the tool. |
| `dashboard.tools.support_desk.client_engines` | list of objects | `[]` | Other Engines this desk supports. |
| `dashboard.tools.support_desk.client_engines[].id` | string | required | Id of the client Engine. |
| `dashboard.tools.support_desk.client_engines[].label` | string | required | Display name. |
| `dashboard.tools.support_desk.client_engines[].repo` | string or null | `null` | The client Engine's repository. |
| `dashboard.tools.support_desk.client_engines[].status` | string | `active` | Status text shown on the page. |
| `dashboard.tools.support_desk.client_engines[].sensor` | sensor | none | The check behind the entry, normally `client_inbox:<client>`. |

### `dashboard.security`

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `dashboard.security.systems_static` | list of objects | `[]` | Systems listed on the Systems tab that have no live check. |
| `dashboard.security.systems_static[].handle` | string | required | Short id of the system. |
| `dashboard.security.systems_static[].name` | string | required | Display name. |
| `dashboard.security.systems_static[].what` | string | required | One line on what the system is. |
| `dashboard.security.system_notes` | map of string to string | `{}` | System handle to a note shown next to that system. |
| `dashboard.security.login_check_sensor` | sensor | none | The job whose result is shown as the daily sign-in check. |

### `support`

| Key | Type | Default | Meaning and rules |
| --- | --- | --- | --- |
| `support.care_plan.enabled` | boolean | `false` | Whether the owner intends this Engine to be on a care plan. It gives nobody access by itself: support access exists only after `kbe support enable`. The status page compares the two on its Support menu and says so when they disagree (set here but no support login, or a support login that is not set here). See [care-plan.md](care-plan.md). |

<!-- config-keys:end -->

### Cross-field rules

Both validators check these:

- A topic id is declared at most once.
- `unclassified` is not declared.
- Every `default_domain` and every value in `sources.fireflies.channels` names a declared topic.
- `sources.wiki.repo` is set when `sources.wiki.enabled` is `true`.

Both validators also check these for `dashboard`:

- Every entry in `dashboard.workers[].uses` names an existing part.
- A job with a `task` has an `agent_job:` sensor.
- A source with `enabled: false` has an `off_reason`.
- The `support_desk` tab is listed only when `dashboard.tools.support_desk.enabled` is `true`.

### Known differences between the validators

The two validators judge a file the same way, with these exceptions:

| Subject | Python validator | TypeScript (the service) |
| --- | --- | --- |
| An unknown key inside `dashboard` | Refused when a file is validated. | Refused when a file is validated (`validateEngineConfigFile`). When the service reads the config already stored in the database it drops the key without an error, so a config stored by an earlier release still loads. |
| What counts as a URL (`dashboard.connect.connector_url`, `dashboard.connect.status_page_url`) | Must look like `scheme://host...`. | Anything the JavaScript `URL` parser accepts, for example `mailto:someone@example.com`. |
| `sources.wiki.repo` | The letters allowed in `owner/name` include letters from any alphabet. | ASCII letters, digits, `_`, `.` and `-` only. |

Use an `https://` address and a plain GitHub `owner/name`, and the two agree.

---

## Part 2: Environment variables

<!-- env-vars:start -->

Never commit a real value. Never paste one into a chat. The two example files, `.env.example` and `engine/.env.example`, hold placeholders only. Each lists every variable its side reads; a test fails when one is missing.

A line that still holds its placeholder (`NAME=<what goes here>`) and a line with nothing after the `=` both count as not set. So does a real value left inside the brackets: replace the whole `<...>`, brackets included. This holds for the `kbe` CLI (`scripts/kbe/secrets.py`) and for the jobs and scripts (`scripts/knowledge/env_file.py`). The command that needs a missing value names it.

`python -m kbe env check` reads the local env file and says what each line holds, by name only: `set`, `empty`, `still the example placeholder`, `wrapped in <...> (remove the brackets)` or `not in the file`. It never shows a value or a length. It groups the names by when they are needed (now, filled in by a later step, optional; the table is in `scripts/kbe/env_check.py`) and fails when a value needed now is missing or mis-shaped, or when any value is still wrapped in `<...>`.

`python -m kbe deploy secrets push` sets the deployed app's secrets from the local env file, so they are not typed into the dashboard. A secret is looked up under its own name, with one exception: `EMBED_TOKEN` on the service takes the value of `KNOWLEDGE_EMBED_TOKEN`. `SETUP_CODE` is never kept in the env file; `--setup-code-from-clipboard` takes it from the clipboard. Without `--yes` the command only previews, by name. DigitalOcean does not reveal whether a secret already holds a value, so the push sets every secret that has a local value, each time, and leaves the others as they are. It is safe to run again. For how secrets are stored and rotated, see [security.md](security.md).

"Secret" in the tables means the value must be stored as a secret on the deployment platform and never shown.

### The service

Read from the process environment and checked at boot by `engine/src/env.ts`. A value that fails a check stops the service with a message that names the variable. For local runs, copy `engine/.env.example` to `engine/.env`.

| Variable | Required | Secret | Default | Meaning |
| --- | --- | --- | --- | --- |
| `PORT` | optional | no | `8080` | Port the service listens on. A positive whole number. |
| `NODE_ENV` | optional | no | `production` | `development`, `production` or `test`. |
| `LOG_LEVEL` | optional | no | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `trace`. |
| `SOURCE_COMMIT` | optional | no | `unknown` | The deployed commit, shown by `/health`. An empty value, or one that still holds an unexpanded `${...}` template, reads as `unknown`. |
| `QB_RELEASE_REPO` | optional | no | `imagicrafter/quantabase` | The public GitHub repository (`owner/name`) whose `stable` branch the Updates screen compares this Engine with. Read over HTTPS from `raw.githubusercontent.com`, no token. Empty means the default; anything that is not `owner/name` stops the boot. |
| `APP_ID` | optional | no | none | DigitalOcean's id for this app. The app spec binds it as `${APP_ID}`; the Updates screen uses it to link straight to the app. Empty, an unexpanded `${...}` or anything but a UUID reads as unset, and the link goes to the apps list. |
| `SUPABASE_URL` | required | no | none | The Supabase project URL. Selects the project. |
| `KB_SCHEMA` | optional | no | `workspace` | The database schema that holds the knowledge index. See [`KB_SCHEMA` rules](#kb_schema-rules). |
| `SUPABASE_JWT_SECRET` | required | yes | none | Project JWT secret, at least 32 characters. Signs short-lived tokens for the read-only `kb_engine` role. The service never holds the service-role key. |
| `SUPABASE_ANON_KEY` | required | no | none | The publishable anon key, at least 20 characters. Used to reach the embed function. |
| `EMBED_TOKEN` | optional | yes | none | Token of the service's own principal, which may embed and nothing else. At least 10 characters. Leave it unset on an Engine set up from the app's Database screen: that screen makes the token and keeps it in Supabase Vault (`kbe_embed_token`), and the service reads it from there. Mint it with `python -m kbe tokens mint --embed --write-env --clipboard`: the token goes into the local env file (as `KNOWLEDGE_EMBED_TOKEN`) and onto the clipboard, and is never printed. `kbe deploy secrets push` sets it on the service from there. |
| `SETUP_CODE` | optional | yes | none | The one-time code that opens setup. 32 to 256 letters, digits, `-` or `_`. `python -m kbe access setup` makes it, sets it on the app, uses it and blanks it again, without showing it. For the setup page it is made by `python -m kbe access init --clipboard` (or `--out FILE`), which stores only its SHA-256 in the database and never prints the code unless `--show` is given. Unset or empty: the setup page refuses to work. |
| `CF_ACCESS_TEAM_DOMAIN` | optional | no | none | Sign-in team domain, `https://<team>.cloudflareaccess.com`. The issuer of sign-in assertions and the host their signing keys are fetched from. |
| `CF_ACCESS_AUD` | optional | no | none | AUD tag of the sign-in application in front of `/mcp`. |
| `OAUTH_RESOURCE_URL` | optional | no | none | The canonical connector URL, for example `https://engine.example.com/mcp`. Must be a URL and should end in `/mcp`. |
| `EXPECTED_HOST` | optional | no | none | The only `Host` header the service answers to, for example `engine.example.com`. |
| `CF_ACCESS_STATUS_AUD` | optional | no | none | AUD tag of the separate sign-in application that guards `/status`. Unset: the stored sign-in settings are used, then `dashboard.connect.status_page_aud`. |
| `ALLOWED_EMAIL_DOMAINS` | optional | no | none | Comma-separated email domains allowed to sign in, for example `example.com,example.org`. A second check only. The sign-in policy is the real gate. |

Rules for the sign-in variables:

- `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `OAUTH_RESOURCE_URL` and `EXPECTED_HOST` are set together or not at all. A partial set stops the service at boot.
- Leave all four out on a new Engine. Setup stores the same settings in the database and the service reads them from there.
- When all four are set, they win over the stored settings.
- With neither source, every protected route answers 503.

### The scheduled jobs and `scripts/knowledge`

These programs read a local file named `.env` at the root of the repository, through `dotenv_values`. Nothing in the file is exported into a process. Copy `.env.example` to `.env` for local runs.

A deployed job gets its values from the platform as process environment. The job's start command first writes the selected variables into `.env`, then runs the job (`engine/deploy/do-app-spec.template.yaml`). `kbe deploy render --server-mode` writes one job per enabled source and gives each job only the variables that source needs; without `--server-mode` it writes no jobs.

The "Read from" column says where the code looks: `file` is the `.env` file, `process` is the process environment.

| Variable | Required | Secret | Default | Read from | Meaning |
| --- | --- | --- | --- | --- | --- |
| `SUPABASE_URL` | required | no | none | file | The Supabase project URL. |
| `SUPABASE_ANON_KEY` | required | no | none | file | The publishable anon key. |
| `SUPABASE_JWT_SECRET` | required | yes | none | file | Project JWT secret. Signs tokens for the `kb_ingest` role. |
| `KB_SCHEMA` | optional | no | `workspace` | file and process | The schema that holds the knowledge index. See [`KB_SCHEMA` rules](#kb_schema-rules). |
| `SUPABASE_SERVICE_ROLE_KEY` | optional | yes | none | file | Service-role key. Only for scripts the owner runs by hand: the full access suite (`python -m knowledge.access_test`) and the older `mint_token.py`. A setup does not need it. Leave it out of every deployed job. |
| `KB_ENGINE_CONFIG` | optional | no | none | process | Path to an `engine.yaml` to use in place of the config stored in the database. For development and tests. While it is set, the wiki job still applies a changed file to the database but keeps using this file for its own run. |
| `KNOWLEDGE_WIKI_ROOT` | optional | no | `~/github/knowledge` | file | Where the knowledge repo is checked out. If the path does not exist, the jobs clone the repo named in `sources.wiki.repo` into their own cache. |
| `GITHUB_TOKEN` | required for the wiki job and for meeting pages | yes | none | file | Token used to clone and push the knowledge repo. A fine-grained token for that one repo with contents read and write. |
| `GH_TOKEN` | optional | yes | none | file | Used when `GITHUB_TOKEN` is not set. |
| `KNOWLEDGE_HANDLE` | optional | no | the owner's handle | process | Whose access `python -m knowledge.search` searches with. A principal handle. `--handle` overrides it. |
| `KNOWLEDGE_TOKEN_<HANDLE>` | required for search | yes | none | file | That principal's token. The name ends in the handle in upper case, with every character that is not a letter or digit written as `_` (`first.last` gives `KNOWLEDGE_TOKEN_FIRST_LAST`). Written by `python -m kbe tokens mint --handle <handle> --write-env`. |
| `KNOWLEDGE_EMBED_BACKEND` | optional | no | `local` | file | `remote` calls the embed function. `local` needs `sentence-transformers` on the machine. Deployed jobs use `remote`. |
| `KNOWLEDGE_EMBED_URL` | required when the backend is `remote` | no | none | file | Address of the embed function: `https://<project-ref>.supabase.co/functions/v1/embed`. |
| `KNOWLEDGE_EMBED_TOKEN` | required when the backend is `remote` | yes | none | file | Token of a principal allowed to embed. The same value as `EMBED_TOKEN`. `python -m kbe tokens mint --embed --write-env` writes it here. |
| `KNOWLEDGE_MODEL_BACKEND` | optional | no | `do` | file | Provider that writes the summaries. On a deployed job the render step sets it from `models.distill.backend`. |
| `KNOWLEDGE_MODEL_ID` | optional | no | `openai-gpt-oss-120b` | file | Model id. On a deployed job the render step sets it from `models.distill.id`. |
| `DO_INFERENCE_KEY` | required when the backend is `do` | yes | none | file | Key for DigitalOcean serverless inference. |
| `ANTHROPIC_API_KEY` | required when the backend is `anthropic` | yes | none | file | Key for the Anthropic API. |
| `FIREFLIES_API_KEY` | required for the meetings job | yes | none | file | Fireflies API key. |
| `FIREFLIES_RETENTION_ENABLED` | optional | no | off | file | `1`, `true` or `yes` lets the meetings job remove old transcripts from Fireflies once they are safely stored. |
| `FIREFLIES_RETENTION_DRY_RUN` | optional | no | off | file | `1`, `true` or `yes` makes retention report what it would remove and remove nothing. The example file sets it to `true`. |
| `FIREFLIES_RETENTION_DAYS` | optional | no | `90` | file | Age in days after which a transcript may be removed. Values below 30 are raised to 30. A value that is not a number reads as 90. |
| `FIREFLIES_UPSTREAM_DELETE_EXECUTE` | optional | no | off | caller passes it | Read by `execute_enabled()` in `pullers/fireflies_upstream_delete.py`. `1`, `true` or `yes` allows real deletes in that module's own sweep. No scheduled job calls that function in this release; retention is governed by the three variables above. |
| `DRIVE_TOKEN_JSON_B64` | required for the Drive job | yes | none | file | Base64 of the Drive OAuth token JSON. Made by `python -m kbe sources drive auth`. The job decodes it in memory; no token file is written. |
| `DRIVE_TOKEN_CLIENT_JSON_B64` | required for the Drive job | yes | none | file | Base64 of the OAuth client JSON, made by the same command. Used for the client id and secret when the token JSON does not carry them. No file is written. |
| `GMAIL_TOKEN_JSON_B64` | required for the mail job | yes | none | file | Base64 of the Gmail OAuth token file. Made by `python -m kbe sources gmail auth`. Only needed when `sources.gmail.enabled` is `true`. The job writes it to `/tmp/gmail-token.json` if that file does not exist. |
| `CF_ACCESS_TEAM_DOMAIN` | optional | no | none | file, then process | Read by the setup gate in `pullers/access_gate.py`. A job ingests nothing until sign-in settings exist. They exist when the database holds them, or when this variable and `CF_ACCESS_AUD` are both set on the job. `kbe deploy render` sets both only when asked to keep sign-in settings in the environment. |
| `CF_ACCESS_AUD` | optional | no | none | file, then process | See `CF_ACCESS_TEAM_DOMAIN`. |
| `OBS_COMMIT` | optional | no | the local git commit | file | The commit to stamp on run events when git is not available. At most 40 characters are kept. |

The embed function (`supabase/functions/embed`) reads `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `KB_SCHEMA` from its own environment. The platform provides the first two. `python -m kbe db deploy-functions` sets `KB_SCHEMA` as a function secret when it is not the default. When the schema is the default, it removes a `KB_SCHEMA` secret the function still holds from an earlier setup.

The full access suite (`python -m knowledge.access_test`, run by hand on an Engine that has content) reads three more names from the process environment only: `ACCESS_TEST_OWNER_HANDLE`, `ACCESS_TEST_READER_HANDLE` and `ACCESS_TEST_SENSITIVE_QUERY`. `kbe verify` does not use them: it runs the same suite with `--roles-only`, which needs no token.

### The `kbe` CLI

The CLI reads credentials from one local env file: `--env-file`, then `KBE_ENV_FILE`, then `.env` at the root of the repository. It reads the file with `dotenv_values` and exports nothing. A value reaches a child program only through that child's environment and is never printed.

| Variable | Required | Secret | Default | Read from | Meaning |
| --- | --- | --- | --- | --- | --- |
| `KBE_ENV_FILE` | optional | no | `<repo>/.env` | process | Path of the env file to use. `--env-file` wins over it. |
| `KBE_STATE_FILE` | optional | no | `<repo>/.kb-engine-local/state.json` | process | Path of the file where the CLI keeps non-secret setup answers and progress. |
| `KBE_PSQL` | optional | no | found on `PATH`, then in the usual install folders | process | Path of the `psql` program to use. |
| `KBE_DATABASE_URL` | required for `kbe db migrate`, `kbe db adopt`, the SQL checks in `kbe verify`, `kbe people`, `kbe issues`, `kbe tokens`, `kbe support`, and `--via db` | yes | none | file | Direct Postgres connection string: `postgresql://<user>:<password>@<host>:5432/postgres`. Passed to `psql` as `PG*` variables in the child's environment, never on the command line. Only the URL options `sslmode`, `sslrootcert`, `connect_timeout`, `options` and `application_name` are accepted. |
| `SUPABASE_URL` | required for `--via api` | no | none | file | The Supabase project URL. Also the fallback source of the project ref. |
| `SUPABASE_ANON_KEY` | required for `--via api` | no | none | file | The publishable anon key. |
| `SUPABASE_JWT_SECRET` | required for `--via api` | yes | none | file | Signs a five-minute token for the `kb_ingest` role. |
| `KB_SCHEMA` | optional | no | `workspace` | file and process | The schema every command works on. See [`KB_SCHEMA` rules](#kb_schema-rules). |
| `SUPABASE_PROJECT_REF` | optional | no | taken from `SUPABASE_URL` | file | Project ref for `kbe db deploy-functions` and `kbe db expose-schema`. Order: `--project-ref`, the saved state, this variable, then the host name in `SUPABASE_URL`. 15 to 30 lower-case letters and digits. |
| `SUPABASE_ACCESS_TOKEN` | optional | yes | none | file | A Supabase personal access token. `kbe db deploy-functions` passes it to the `supabase` program; without it, run `supabase login` first. `kbe db expose-schema` uses it to add the schema to the project's exposed schemas; without it, the command prints the dashboard steps. |
| `GITHUB_TOKEN` | optional | yes | none | file | Checked by `kbe sources` for the wiki source. `GH_TOKEN` is accepted in its place. |
| `FIREFLIES_API_KEY` | optional | yes | none | file | Checked by `kbe sources` for the meetings source. |
| `DRIVE_TOKEN_JSON_B64` | optional | yes | none | file | Checked by `kbe sources` for the Drive source. Produced by `kbe sources drive auth`. |
| `DRIVE_TOKEN_CLIENT_JSON_B64` | optional | yes | none | file | Produced by `kbe sources drive auth` together with the token. |
| `GMAIL_TOKEN_JSON_B64` | optional | yes | none | file | Checked by `kbe sources gmail check`. Produced by `kbe sources gmail auth`. |
| `KNOWLEDGE_EMBED_TOKEN` | optional | yes | none | file | Written by `kbe tokens mint --embed --write-env`. `kbe deploy secrets push` sets it on every job, and on the service as `EMBED_TOKEN`. |

### `KB_SCHEMA` rules

`KB_SCHEMA` names the Postgres schema that holds the knowledge index. The rule is written three times and must stay the same in all three: `engine/src/kb-schema.ts` (the service), `scripts/knowledge/kb_schema.py` (the jobs and the CLI, re-used by `scripts/kbe/schema.py`), and the embed function.

- Default: `workspace`. An existing deployment needs no change.
- Form: 1 to 63 characters. Lower-case letters, digits and underscores. The first character is a letter or an underscore.
- Reserved names are refused: `public`, `auth`, `storage`, `extensions`, `graphql`, `graphql_public`, `realtime`, `vault`, `pgsodium`, `supabase_migrations`, `information_schema`, and any name that starts with `pg_`.
- SQL reserved words are refused too, for example `user`, `table`, `select`, `order` and `default`. The list is PostgreSQL's reserved key words, the same fixed list in all three places. A name that only contains such a word (`kb_user`) is fine.
- A bad name stops the program. It is never replaced by the default. The embed function answers with an error for a bad name.
- An empty value counts as unset. So does an unfilled `<...>` placeholder in the local env file.
- The Python programs accept the value from the `.env` file or from the process environment. If both are set and differ, the program stops.
- `kbe db migrate --schema <name>` may name the schema for a first run. If `KB_SCHEMA` is already set to another value, the command refuses.
- Use the same value in four places: the service, every deployed job, the local env file of the CLI, and the embed function. To move the embed function to the same value, run `python -m kbe db deploy-functions`. Going back to the default works the same way: the command removes the function's old `KB_SCHEMA` setting.
- The REST API serves only schemas on the project's exposed list. `python -m kbe db expose-schema` adds the schema. `python -m kbe db expose-schema --check` confirms it is served.

<!-- env-vars:end -->
