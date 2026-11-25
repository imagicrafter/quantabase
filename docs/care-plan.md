# Support access (Care Plan)

An Engine keeps a log of its own problems: a source that failed, a config
file that was rejected, something a person reported from Claude.
([operations.md](operations.md#the-issue-log) describes the log.) You can let a support person read that log and mark items as
handled, without letting them see any of your knowledge.

It is off until you turn it on, and you can turn it off at any time.

## What support can see

One view, `v_support_inbox`. For each issue it shows:

- a category (for example `source_failure`, `config_invalid`)
- the source name (`wiki`, `drive`, ...)
- an error class and a short message with content removed
- its status, how many times it happened, and when
- the support card id, once support has set one

It never shows who reported an issue, a document's text or title, or a
participant's name. The pullers remove such content before an issue is
written, and the database removes it again.

## What support can do

- read that view
- `issue_set_card(id, card_id)`: note which support card tracks an issue
- `issue_set_status(id, status, pr_url, proof)`: mark it in progress, fixed
  or closed

Nothing else in the Engine's schema. The support role cannot read documents,
people, topic grants, settings or the issue table itself, and cannot run any
other function. A test proves this on every build
(`supabase/tests/access_support_test.sql`).

One limit to know about: this covers the Engine's own schema. If the same
database also holds another application, check what that application leaves
open to every role before you enable support. The header of
`supabase/migrations/0036_support_role.sql` says exactly what that means.

## Turn it on

```
python -m kbe db migrate          # once; creates the kb_support role (no login)
python -m kbe support enable --clipboard
```

`enable` creates a database login that is a member of `kb_support`, with a
password it makes itself, and hands over a connection string **once**. The
string is a secret, so it is never printed unless you ask:

| Flag | Where the string goes |
|---|---|
| `--clipboard` | Onto your clipboard. Nothing secret is printed. |
| `--out FILE` | Into a new file only you can read. An existing file is never replaced. |
| `--show` | Printed once in your terminal. Refused when no person is at the terminal. |

With none of the three the command refuses and changes nothing. An assistant
that runs the command for you uses `--clipboard` or `--out FILE`, never
`--show`.

Pass the string to your support contact through a secure channel, such as a
password manager share. Do not send it by email or chat. It is not saved
anywhere else on your machine; if it is lost, turn support off and on again
to get a new one.

## Check it, turn it off

```
python -m kbe support status
python -m kbe support disable     # ends its sessions and drops the login
```

The status page shows the same thing on its Support menu, on the line
**Care Plan access**. It compares two facts: what the config says you intend
(`support.care_plan.enabled`) and whether a support login really exists in
the database.

| Config | Support login | The line says |
| --- | --- | --- |
| off | none | Off |
| on | exists | On |
| on | none | Not set up: run `enable` when you are ready |
| off | exists | On, not in config: turn support off, or set the key to `true` |

The config key gives nobody access. Only `enable` does.

After `disable` the connection string stops working at once.

## Why the role and the login are made in two places

The `kb_support` role has no login and no password, so it can be created by
a migration like every other part of the database. A login needs a password,
and a password must never be in a file in a repository. So the migration
defines what support may do, and the command creates the login that may do
it. The command sends the database a SCRAM verifier, not the password, so the
password is not in the database's statement log either.
