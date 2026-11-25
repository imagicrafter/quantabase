# Roles

Who can do what on an Engine, how a person gets a role, and how topics and
grants decide what each person sees.

Two separate checks apply to every person:

1. **Sign-in.** Cloudflare Access decides whether the person may reach the
   Engine at all. See [security.md](security.md).
2. **Role and grants.** The Engine's database holds one record per person
   (table `principals`) with a role, and a list of topic grants (table
   `access_grants`). This page is about that second check.

A person Cloudflare lets through who has no record in the database is refused.
A person with a record and no grants gets empty results.

## The roles

The database accepts three roles: `reader`, `reviewer` and `administrator`.
The owner and the account holder are positions, described below. They are not
separate values of the role column.

| Role | What it is |
|---|---|
| **Reader** | Uses the connector tools. Sees documents in the topics granted to them. |
| **Reviewer** | Stored as its own role. In this version it has the same permissions as a reader. Review is done from a terminal (see [manual.md](manual.md#review-and-approval)); a connector tool for reviewers is not available yet. |
| **Administrator** | Everything a reader can do. Also sees every topic that is not marked sensitive, without a grant. Manages people and grants. May open the status page. |
| **Owner** | The administrator named in `engine.owner.email` in the config. The only person who holds the `unclassified` topic. |
| **Account holder** | Whoever holds the accounts the Engine runs on: the database project, the hosting app, the Cloudflare account, the knowledge repo and the local env file. Often the same person as the owner. |

### What each can do

| Action | Reader | Reviewer | Administrator | Owner |
|---|---|---|---|---|
| `search`, `get_document`, `get_wiki_page`, `who_knows` in granted topics | yes | yes | yes | yes |
| `report_issue` | yes | yes | yes | yes |
| Page tools: read pages in granted topics, write own pages and raw items | yes | yes | yes | yes |
| See non-sensitive topics without a grant | no | no | yes | yes |
| See a sensitive topic | with a grant | with a grant | with a grant | with a grant |
| See `unclassified` | no | no | no | yes |
| Admin tools on the connector, `kbe people` | no | no | yes | yes |
| Open `/status` | no | no | see note | yes |

Note on `/status`: the database admits any active administrator. The
Cloudflare rule in front of `/status` and `/setup` lists the owner's email
only, so another administrator needs that rule changed first.

### The owner

- The first time a config is applied, the Engine creates the owner as an
  administrator (or promotes an existing person with that email). This happens
  only while the Engine has no active administrator.
- After that, a config that names an owner who is not already an active
  administrator is refused. A config file cannot hand the Engine to someone
  else.
- The owner is granted `unclassified` each time the config is applied.
- `kbe people` acts as the owner unless `--as EMAIL` names another
  administrator.

### The account holder

The account holder is not a row in the database. Anyone who holds the
database credentials in the local env file can read every table directly, run
migrations, run the review loop and reopen setup. Topic grants do not limit
them. Treat those credentials as full access to all knowledge in the Engine.

## How a person gets a role

Commands run from the repo root with `PYTHONPATH=scripts:.`.

1. **An administrator adds the person.** A new person starts with no topics.

   ```
   python -m kbe people add reader@example.com --name "Pat Reader" --role reader
   ```

   `--role` is `reader` (the default), `reviewer` or `administrator`. Adding
   an administrator also needs `--admin-ack`.

2. **Cloudflare must let them sign in.** The Engine holds no Cloudflare
   credential and cannot change the sign-in rule. With access level `people`,
   add their email to the rule in Cloudflare. With level `domain`, an email at
   an allowed domain already gets through. The preview shown in step 1 says
   this too.

3. **An administrator grants topics.**

   ```
   python -m kbe people grant reader@example.com consulting
   ```

4. **The person signs in.** On the first sign-in the Engine matches the
   verified email to the person's record and stores the sign-in identity on
   it. From then on the person is recognised by that identity.

`python -m kbe people list` shows everyone, their roles and their grants.

The same actions exist as connector tools for administrators:
`admin_list_people`, `admin_add_person`, `admin_grant_topic`,
`admin_revoke_topic`, `admin_deactivate_person` and
`admin_reactivate_person`. They are listed only for administrators, and the
database checks the caller again on every call.

### Removing access

```
python -m kbe people revoke reader@example.com consulting
python -m kbe people deactivate reader@example.com
```

- `revoke` removes one topic. If the person is an administrator and the topic
  is not sensitive, they still see it. The preview says so.
- `deactivate` removes all access at once. The grants are kept and have no
  effect. You cannot deactivate yourself or the last active administrator.
- Deactivating a person does not remove them from the Cloudflare rule. Remove
  them there as well.
- A deactivated person can be given their access back with
  `python -m kbe people reactivate <email>` or the connector tool
  `admin_reactivate_person`. They return with the role and the topics they
  had; the preview lists both. Only an active administrator can do it, and a
  deactivated person cannot bring themselves back.
- A token the person held before they were deactivated does not come back.
  Reactivating clears it, so a lost or leaked token never starts working
  again. Mint a new one (`python -m kbe tokens mint`) if they need one.
- Changing a person's role is not available yet.

### Every change has two steps

Add, grant, revoke, deactivate and reactivate all work the same way, on the connector and
in `kbe people`:

1. **Preview.** The database checks the request and returns a description of
   exactly what will change, with a one-time confirmation code. Nothing has
   changed.
2. **Confirm.** The same arguments are sent again with the code. The change is
   made and recorded in the event log.

A code works once, for 10 minutes, for the administrator it was issued to and
the exact arguments it was issued for. `kbe people` shows the preview, asks
for a yes, and sends the code itself. `--dry-run` stops after the preview.

## Topics and grants

A **topic** is an access label. The config and the database call it a
`domain`.

- Topics are declared under `domains:` in `.kb-engine/engine.yaml`. Each has
  an `id` (lowercase letters, digits and dashes, starting with a letter), a
  `label`, and an optional `sensitive: true`. See
  [configuration.md](configuration.md).
- Every document carries one or more topics. They come only from tags at the
  source. See [tagging.md](tagging.md).
- A **grant** gives one person one topic. A person sees a document when at
  least one of the document's topics is in their set. A document with two
  topics is visible to holders of either.
- The filter runs inside the database on every search and every fetch. The
  caller never supplies a list of topics.
- A topic cannot be removed from the config while any document carries it or
  any person is granted it. Retag the documents and revoke the grants first.

## Sensitive topics

A topic with `sensitive: true` needs a deliberate grant from everyone,
administrators included.

- Administrators do not see it unless it is granted to them.
- Granting it needs an explicit acknowledgement on both steps:
  `--sensitive-ack` in `kbe people grant`, `sensitive_ack` on the connector
  tool.
- A config can mark an existing topic sensitive. A config cannot remove the
  mark: that would show the topic to every administrator at once, so the
  database refuses it.
- The connector's text for Claude names the non-sensitive topics and only
  counts the sensitive ones.
- `kbe tags suggest` never proposes a sensitive topic.

## `unclassified`

`unclassified` is the topic of every item that has no valid tag.

- It always exists and is always sensitive. It may not be declared in the
  config.
- Only the owner holds it. Each time a config is applied, the database removes
  any other grant on it.
- The admin tools refuse to grant it or revoke it.
- Items in it are indexed and searchable by the owner. Nobody else can find or
  open them.
- To show an unclassified item to other people, tag it at the source with a
  declared topic. The change takes effect the next time that source is pulled.
  `python -m kbe tags audit` lists the untagged items.
