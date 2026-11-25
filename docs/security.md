# Security

How sign-in works, what protects the one-time setup page, what has and
has not been checked against a real Cloudflare account, how text from your sources
is handled before a model sees it, and the rules for mail.

Related pages: [architecture.md](architecture.md) (the parts and the database
roles), [roles.md](roles.md) (who sees what), [build-manual.md](build-manual.md)
chapter 13 (running setup, with `kbe access setup` or the page), and
[`../engine/deploy/cloudflare-access-setup.md`](../engine/deploy/cloudflare-access-setup.md)
(doing the Cloudflare side by hand).

## 1. The sign-in model

Two separate questions, answered in two separate places.

| Question | Who answers | Where it lives |
|---|---|---|
| **May this person reach the Engine at all?** | Cloudflare Access | The Access applications and their rules, in your Cloudflare account |
| **What may this person see?** | The Engine's database | Topic grants (`workspace.access_grants`) |

Cloudflare decides who gets in. Grants decide what they see. Getting in is not
the same as seeing knowledge: a person Cloudflare lets through who has no
record in the database is refused, and one with a record but no grants gets
empty results.

How a request is checked:

1. Cloudflare Access sits in front of the hostname. A person signs in with a
   one-time PIN that Cloudflare emails to them. Cloudflare then adds a signed
   assertion (`Cf-Access-Jwt-Assertion`) to each request.
2. The Engine does not trust the network. It verifies that assertion itself on
   every request: signature against your team's public keys, issuer, audience
   (the application's AUD tag), expiry. A request with no assertion gets 401.
   This is what makes the hosting platform's own hostname harmless: a request
   sent straight to it carries no Cloudflare assertion.
3. The Engine answers only on its own hostname. Any other `Host` gets 421.
4. The verified email is matched to a person in the database. Every search is
   filtered by that person's grants, in SQL.

There are two Access applications:

- **The hostname application** covers the whole hostname. It has Managed OAuth
  switched on, so Claude can connect to `https://<host>/mcp`.
- **The admin-pages application** covers only `/status` and `/setup`. It needs
  a second factor on top of the one-time PIN, and its rule lists the owner
  only. It has its own AUD tag. The Engine refuses to serve those pages if
  that AUD tag is missing or equal to the hostname application's, so a
  connector sign-in can never open them.

The Engine holds no Cloudflare key and no identity-provider key. It cannot
change who may sign in.

### Access levels

All three use Cloudflare one-time PIN. The owner is always included.

| Level | Who may sign in |
|---|---|
| `owner` | The owner's email only |
| `people` | The owner and a list of emails (at most 50) |
| `domain` | The owner and anyone with an email at the listed domains (at most 10) |

Public email providers (gmail.com, outlook.com and the like) are refused as a
company domain, because anyone can get an address there.

## 2. Setup mode

A new Engine has no sign-in settings. Until it has them it is in **setup
mode**:

- `GET /health` answers.
- `/setup` answers.
- Everything else (`/mcp`, `/status`, the discovery documents, any other
  path) answers `503 setup not complete`.

The Engine is in setup mode only when it has no usable sign-in settings from
either source: the four Cloudflare variables are unset **and** the database
holds none. A deployment that sets the variables is never in setup mode,
whatever the database says.

Settings that cannot be read are never treated as "not set up, so let it in".
They answer 503 on every route. The same goes for stored sign-in settings that
are present but unusable: that is a broken Engine, not a new one, and it
answers 503 everywhere, the setup page included. (To repair it, an operator
with database access clears `engine_settings.access`; the Engine is then in
setup mode again.)

The Engine leaves setup mode without a restart. The settings are re-read from
the database at most every five seconds while in setup mode, and at once when
setup completes.

## 3. The setup page: what protects it

Setup runs through three routes of the app: `GET /setup`, `POST
/setup/preview` and `POST /setup/apply`. A person can use them in a browser
(the setup page). `kbe access setup` uses the same two POST routes and asks
for the answer as data. Everything in this section holds for both: there is
one gate, one code check, one lockout and one validation.

The setup page's code is public. Anyone can read it and anyone can find a
new Engine's address. **Nothing here relies on the page being hard to find or
its workings being unknown.** During the setup window the page is protected
by four things:

1. **The setup code.** A long random code (at least 32 characters), made by
   `kbe access setup` for its own run or by `kbe access init` for a person
   to type. Without it the page validates nothing, shows no
   preview and does nothing. It is checked twice: by the service, in constant
   time, against its `SETUP_CODE`; and by the database, against the SHA-256
   it stores. It works once: completing setup erases the stored hash.
2. **The lockout.** Five wrong codes inside 15 minutes lock setup for one
   hour. While locked, the right code is refused too. The count is kept in
   the database, so restarting the app does not reset it, and the database
   functions enforce it even for a caller that skips the service's own check.
   Code checks are also run one at a time, so a burst of parallel guesses
   cannot slip under the limit. One exception keeps a lock from spoiling a
   setup that is already running: a right code that was checked in the last
   10 minutes may still complete after a lock begins.
3. **The empty database.** Pullers do not run until setup is complete. During
   the window the database holds no knowledge, so there is nothing to read
   even if every other protection failed.
4. **The single-use token.** The Cloudflare API token is given at the last
   step, used for that one request, and not kept. There is no stored
   credential for anyone to steal later.

In front of those sit a rate limit by address, a ceiling of 60 form posts a
minute across all addresses, and a 16 KB limit on the form. Only one apply
runs at a time.

### What an attacker could try

| Attempt | What stops it |
|---|---|
| Guess the setup code | 32+ random characters; five wrong guesses lock setup for an hour |
| Reach `/mcp` or `/status` before sign-in exists | Setup mode: 503, with or without an assertion |
| Send the form from another site (CSRF) | The post needs the setup code, which the other site does not have. As a second check the post must be same-origin (`Sec-Fetch-Site`, then `Origin`) |
| Change the choices between preview and apply | They are signed (HMAC-SHA256, key derived from the setup code with HKDF), expire after 30 minutes, and are fully validated again after the signature checks out |
| Skip the preview and post choices straight to apply | Apply accepts only signed choices |
| Make the app call another server with the token (SSRF) | One fixed base URL; paths are built from checked segments; the finished URL is checked again; redirects are never followed; the process-wide outbound allowlist permits `api.cloudflare.com` only when a setup code is configured |
| Point sign-in at a key server they control | The team domain is read from Cloudflare, and both the service and the database accept only `https://<team>.cloudflareaccess.com` |
| Abuse the `Host` header | In setup mode the page answers on any hostname (there is no expected one yet). The header is never used to build a link. It is used for one thing: in setup mode it is the app's own address, the target of the DNS record, and it must be a plain hostname. Only the person sending the request controls it, and they need the setup code. Once set up, only the configured hostname answers |
| Send the new hostname to someone else's server | In setup mode the DNS target is the address the page was opened on, not a form field. A preview made on one address cannot be applied on another |
| Take over a hostname or application that is in use | A DNS record that points elsewhere, or an application setup did not make, is left alone unless "Replace what is already there" was ticked (and that choice is signed with the rest) |
| Leave a weak setting behind on an existing rule or application | A rule is rewritten with exactly the wanted fields. An application keeps only cosmetic fields. Either counts as "different" while it carries a switched-off second factor, a longer session, or open cross-origin settings |
| Learn the owner's email from the open page | The form does not show it. It appears in the preview, after the setup code |
| Inject script into the page | Everything is escaped; the page's policy allows no script at all (`default-src 'none'`, no `script-src`), no inline style, and no framing |
| Use `/setup` after setup | It needs the admin-pages sign-in (second factor) **and** an active administrator, and shows no form unless setup was reopened |
| Read a secret from the logs | See section 4 |
| Ask for the answer as data to get round a check | There is no second set of routes. A request that asks for JSON passes the same gate, code check, lockout, same-origin and form checks, signature and validation; only the shape of the answer changes. Neither secret is in any answer |
| Make `kbe access setup` send the code or the token somewhere else | It sends them only over HTTPS to the app's `ondigitalocean.app` address, which it reads from DigitalOcean. Any other address is refused before anything is changed. Redirects are not followed |
| Read the code or the token off the owner's screen, shell history or disk | `kbe access setup` never prints either, takes neither as an argument, and writes neither to a file. Text that comes back from `doctl` or from the app has both removed before it is shown |

### The command line: where the two secrets are

`kbe access setup` exists so that the owner handles neither secret by hand.

- **The setup code** is made in the command's own memory. Its SHA-256 goes
  to the database. The code itself goes to the app inside the app spec, on
  `doctl`'s standard input, and is stored there as an encrypted variable. It
  exists in two places only: the memory of that one process, and the app's
  encrypted environment. It never reaches the screen, the clipboard, a file
  or a command line. When the command ends, however it ends, it blanks
  `SETUP_CODE` on the app again.
- **Nobody knows the code.** So a run that is interrupted cannot be picked
  up with the same code. Running the command again makes a new one; the
  old one stops working at once.
- **The token** goes: Cloudflare's screen, the owner's clipboard, the
  command's memory, HTTPS, the app, Cloudflare. It is stored at none of
  those stops. The command accepts only something shaped like a current
  Cloudflare API token (`cfut_` or `cfat_` in front), and refuses a clipboard that holds a value from the local env
  file. After a successful run it clears the clipboard.
- **No wrong code is sent.** The command waits until the deployment that
  carries the new code is the one serving, and only then calls the app. It
  never retries a refused code, so it cannot run the lockout up.
- **Only a new Engine.** Once the Engine has sign-in settings, the setup
  routes answer only behind the admin sign-in with its second factor. The
  command has no such sign-in and does not try to get one. To change
  sign-in later, use `kbe access reopen` and the page.

### What is left

- **The token is on the clipboard for a few minutes.** Other programs on
  the owner's machine can read a clipboard. The command clears it after a
  successful run; after a failed one it leaves the token there for the next
  run and says so. Give the token an end date, and delete it afterwards.
- **A token made from the link is wider than it needs to be** unless the
  owner narrows it. Cloudflare's link can fill in the permissions, not the
  account, the zone or the end date (section 4). The command and the page
  both say what to set, and setup warns when the token reaches more than
  one zone.
- **Lockout as a nuisance.** Someone who finds a new Engine can keep setup
  locked by sending five wrong codes an hour. They gain nothing and cannot
  spoil a setup that is already running, but the owner cannot start one while
  the lock holds. `kbe access reopen` gives a new code and clears the lock,
  but the same person can lock it again. The count is for the whole page, not
  per visitor, because the visitor's address cannot be trusted here. With a
  32-character random code the lockout adds little against guessing; whether
  to keep it page-wide is an open product decision.
- **A person who has the setup code** during the window can run setup with
  their own Cloudflare account and point the Engine at it. The database is
  empty then, and the owner would notice that their own setup fails. Treat
  the setup code like a password, and complete setup soon after deploying.
- **The per-address rate limit can be dodged.** It reads the first
  `X-Forwarded-For` entry, which a caller who reaches the platform hostname
  directly can set. That is why the setup routes also have a ceiling across
  all addresses, and why the lockout, not the rate limit, bounds guessing.
- **The company-domain check is a guard, not a proof.** It refuses well-known
  mail providers and shared endings, not every one that exists. The preview
  says in words that anyone with an address at the domain gets in.
- **The database secret.** Anyone who holds the project's JWT secret can act
  as the service's database roles, reopen setup with a code of their own and
  complete it. That is the same trust as a database administrator.
- **`api.cloudflare.com` stays allowed for outbound calls** as long as
  `SETUP_CODE` is set. `kbe access setup` blanks it when it ends. After the
  page, remove `SETUP_CODE` from the app by hand.
- **Browsers may offer to save the token.** On the page, the token box is a
  password field. Say no, and delete the token in Cloudflare afterwards.

## 4. The Cloudflare API token

### Permissions

The token needs exactly these four permissions. `kbe access setup` prints,
and the setup page shows (on the form and again next to the token box), a
link that opens Cloudflare's "create token" screen with them filled in.
Cloudflare's current screen groups them into **Policies** cards ("Account
policy", "Zone policy") and calls the level **Write**; older screens said
Edit:

| Card | Permission | Level | Used for |
|---|---|---|---|
| Account policy | Access: Apps and Policies | Write | The two Access applications and their rules |
| Account policy | Access: Organizations, Identity Providers, and Groups | Write | Reading the team name, adding one-time PIN sign-in, switching on the second factor |
| Zone policy | DNS | Write | The one DNS record, in the one zone |
| Zone policy | Zone | Read | Finding the zone the hostname is on: `GET /zones` accepts only Zone Read, so without it the zone list comes back empty or refused |

The link cannot set the next three. Set them on that screen:

- **Account policy card:** click the pencil and narrow it to your one account.
- **Zone policy card:** click the pencil, pick **Specific zone**, and pick the
  domain your hostname is on.
- **Expiration:** Custom (or 7 days).

When the token check fails, the setup page and the app log say which check
failed (the verify routes' answers, `zones?name=...: no match`, or the
refused Access/DNS read) with Cloudflare's status and error codes. The token
itself is never logged or shown. Tokens in Cloudflare's newer formats
(`cfut_` for a user token, verified on `/user/tokens/verify`; `cfat_` for an
account token, verified on `/accounts/{id}/tokens/verify`) and the older
unprefixed form are all accepted.

Then delete the token when setup is done.

About the link. Cloudflare documents it as an
[API token template URL](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/).
What that page gives is all the link uses: the user-token address
`https://dash.cloudflare.com/profile/api-tokens`, `permissionGroupKeys` (the
keys `access`, `access_acct` and `dns` at `edit`, and `zone` at `read`), `accountId=*`,
`zoneId=all` and a `name`. The page documents no way to limit the token to
one zone or one account from the link, and no parameter for the end date.
It also says a key Cloudflare does not know is dropped without a message.
So the four permissions are always listed in words next to the link, for
the owner to check, and setup itself checks the token before it changes
anything. If the link opens an empty screen, create a custom token and
add the four by hand.

A token with more than this still works; the page warns when the token can
reach more than one zone.

### How it is handled

- In the app, it exists only as a function argument for the life of the
  apply request.
- In `kbe access setup`, it exists only in the command's memory, from the
  moment it is read from the clipboard (or from `--token-file`) until the
  command ends. It is sent once, in the body of the apply request, over
  HTTPS, to the app's own address.
- It is sent only as an `Authorization: Bearer` header, only to
  `https://api.cloudflare.com/client/v4/`. Redirects are not followed. Every
  call has a 15 second timeout, and the whole run has one 75 second deadline:
  no call starts or is waited for past it.
- It is never written to a log, an error message, a response, or the
  database. Errors raised by the Cloudflare client carry a kind, an HTTP
  status and Cloudflare's numeric codes; any text Cloudflare sent back has the
  token removed before it is kept. The underlying network error is dropped,
  not attached.
- The logger redacts fields named like a token or a setup code, and removes
  the setup code's value from every finished log line.
- A value typed into the wrong box is not written back into the page unless
  it is a valid hostname or email, so a mis-pasted token or code is not echoed.
- Tests run whole requests (success, refusals, Cloudflare failures, Cloudflare
  echoing the token back, a network error that carries the request) and search
  every log line, response body, response header and the stored row for the
  token and the setup code. They do so for the page's answers and for the
  JSON answers.
- The command's tests run whole setups against stand-ins for `doctl`, the
  clipboard and the app (success, a refusal, a failed step, an app that
  echoes both secrets, a network error that carries the request) and search
  everything printed, every command line and the local state file for the
  token, the setup code and the values of the local env file.

## 5. What setup stores

One JSON object, in `workspace.engine_settings.access`. Nothing in it is
secret.

```json
{
  "team_domain": "https://<team>.cloudflareaccess.com",
  "aud": "<AUD tag of the hostname application>",
  "status_aud": "<AUD tag of the admin-pages application>",
  "host": "engine.example.com",
  "resource_url": "https://engine.example.com/mcp",
  "level": "owner | people | domain"
}
```

The list of emails or domains is not stored. It lives in the Cloudflare rule.

## 6. What setup changes in Cloudflare

In this order. Each step looks first and only writes what is missing or
different, so running setup twice makes nothing twice. Cloudflare's `PUT`
replaces a whole object, so every update is read, merge, write. What is kept
depends on the object: the organization keeps everything it had; an
application keeps only cosmetic fields; a sign-in rule keeps nothing (it is
setup's own, found by a name setup made up).

1. **Account second factor.** Reads the Zero Trust organization (for the team
   name). If the account has no second factor allowed yet, allows
   authenticator app, biometrics and security key. It is not made mandatory
   for your other applications.
2. **One-time PIN.** Adds the one-time PIN sign-in method if the account has
   none.
3. **DNS.** `CNAME <host> -> <the app's own address>`, proxied, with a
   comment that marks it as setup's own. A CNAME that points somewhere else is
   repointed only if setup made it, or if you ticked "Replace what is already
   there". Records of another kind are never replaced: setup stops and asks
   you to remove them.
4. **Sign-in rule** `KB Engine sign-in: <host>`: allow, the emails or domains
   for the chosen level, 24 hour session. An existing rule of that name is
   rewritten to say exactly this and nothing else.
5. **Hostname application** `KB Engine: <host>`: self-hosted, the whole
   hostname, one-time PIN only, 24 hour sessions, Managed OAuth on with dynamic
   client registration, allowed redirect addresses
   `https://claude.ai/api/mcp/auth_callback` and
   `https://claude.com/api/mcp/auth_callback` plus localhost and loopback
   clients. The rule from step 4 is the only rule attached; any other rule is
   detached. An application for this hostname that setup did not make is
   taken over only if you ticked "Replace what is already there". When an
   existing application is updated, only its cosmetic fields are kept (logo,
   deny messages, custom pages, tags); everything else comes from the plan.
6. **Administrators rule** `KB Engine administrators: <host>`: allow, the
   owner's email only, 12 hour session.
7. **Admin-pages application** `KB Engine admin pages: <host>`: self-hosted,
   `<host>/status` and `<host>/setup`, one-time PIN only, second factor
   required, 12 hour sessions.

Then the team domain and both AUD tags are read back and stored, and the setup
window closes.

**The read-back.** When every step has succeeded, setup lists the
applications once more and looks at three settings: Managed OAuth on the
hostname application, Claude's two redirect addresses on its allowed list,
and a second factor on the admin-pages application. For each one that is
not in place it gives one line with where to click, on the result page and
in `kbe access setup`. This is one read, with the token the run already
holds. It writes nothing, and it cannot turn a finished setup into a failed
one: a read that fails is reported as "could not be checked". It reports
what the application holds, not that Cloudflare enforces it (section 7,
item 15).

If a step fails, setup stops there. Nothing is undone. The result page says
which steps were done, which failed and which were not started. Setup stays
open, and running it again with the same choices finishes the job.

Setup never deletes anything in Cloudflare. If you run setup again with a
different hostname, the old hostname's record, rules and applications stay
until you remove them.

## 7. What has been checked against a live Cloudflare account

The setup page was written from Cloudflare's documentation. Its tests use a
stand-in for the Cloudflare API written from the same documentation, so they
prove the page's own logic, not Cloudflare's behaviour. On 2026-11-17 the
calls were run against a real account, with throwaway objects that were
deleted afterwards. The first list is what that run confirmed. The second is
what it did not cover: treat each of those as an item that may need a manual
step in the Cloudflare dashboard;
`engine/deploy/cloudflare-access-setup.md` shows each step by hand.

### Verified against a live account (2026-11-17)

Each item matches what the setup page sends and expects.

- **Zone lookup.** `GET /zones?name=<name>` returns the zone, and the zone
  object carries `account.id`. (Run with a token that could also read
  zones; see item 1 below.)
- **Token verify.** A token owned by the account is verified at
  `GET /accounts/{id}/tokens/verify` (`status: "active"`). The same token
  gets a 401 at `GET /user/tokens/verify`. So a 401 on the user route does
  not mean a bad token: the page tries the account route before it refuses.
- **Organization read.** `GET /accounts/{id}/access/organizations` returns
  `auth_domain` as `<team>.cloudflareaccess.com`, and an `mfa_config` with
  `allowed_authenticators` and `session_duration`.
- **Identity providers, read.** The one-time PIN method has
  `type: "onetimepin"`.
- **DNS.** `GET /zones/{id}/dns_records?name=<host>` filters by name;
  `POST` with `{ type: "CNAME", name, content, proxied: true, ttl: 1, comment }`
  works and returns `comment`; `PATCH` updates in place.
- **Reusable rules.** `POST /accounts/{id}/access/policies` with
  `{ name, decision: "allow", include, exclude: [], require: [], session_duration }`
  works. Both rule shapes, `{ "email": { "email": ... } }` and
  `{ "email_domain": { "domain": ... } }`, come back unchanged. `PUT` with
  the same body works, and `session_duration` reads back exactly as written,
  so running setup again changes nothing.
- **Applications.** `POST /accounts/{id}/access/apps` with
  `type: "self_hosted"`, `domain`, `destinations: [{ type: "public", uri }]`,
  `session_duration`, `app_launcher_visible`, `allowed_idps: [<id>]` and
  `policies: [{ id, precedence }]` works; the answer carries `id` and a
  64-character `aud`. On a read, `policies` come back as objects that carry
  `id` and `precedence`.
- **Two paths in one application.** `destinations` with `<host>/status` and
  `<host>/setup`, and `domain` set to the first, is accepted and read back.
- **Second factor on one application.**
  `mfa_config: { mfa_disabled: false, allowed_authenticators: ["totp", "biometrics", "security_key"], session_duration }`
  is accepted on the path application and read back. (See item 15 below for
  what was not shown.)
- **Path precedence**, checked at the edge. `/status`, a file under
  `/status`, `/setup` and `/setup/preview` are all handled by the path
  application. `/`, `/mcp` and a look-alike such as `/statusx` are handled
  by the hostname application. So a path application covers what is under
  it, wins over the hostname application, and does not catch a path that
  merely starts with the same letters.
- **Managed OAuth.**
  `oauth_configuration: { enabled, dynamic_client_registration: { enabled, allow_any_on_localhost, allow_any_on_loopback, allowed_uris }, grant: { access_token_lifetime: "15m", session_duration: <the chosen sign-in length, default "8760h"> } }`
  (the connector re-approves as often as a person signs in; both lengths are
  shown on the Sign-in and Health screens)
  is accepted and read back unchanged. At the edge, `/` and `/mcp` without a
  sign-in answer 401 with a `WWW-Authenticate: Bearer` header that points at
  the resource metadata, and both `/.well-known/oauth-authorization-server`
  and `/.well-known/oauth-protected-resource` answer. The protected resource
  is named as the bare hostname, not `/mcp`.
- **Claude's redirect addresses.** Client registration succeeds for exactly
  `https://claude.ai/api/mcp/auth_callback`, exactly
  `https://claude.com/api/mcp/auth_callback`, and a localhost address. It is
  refused (`invalid_client_metadata`) for any other site. The exact
  addresses are enough; no wildcard is needed.
- **Timing.** Right after the records are created the edge answers 404 on
  every path for a short while. About 90 seconds later everything behaved
  as above. The result page says so, and `kbe verify` asks again for up to
  three minutes before it calls a 404 a failure.

### Not yet verified

These are still from the documentation only. The numbers are the ones this
section has always used, so older notes still point at the right item.

1. `GET /zones?name=<name>` with a token that has only Zone DNS Edit and no
   Zone Read. (The live run used a token that could read zones.)
3. Error shapes: 401 (or code 1000 / 6003) for a bad token, 403 for a missing
   permission, 404 for a missing object. The page maps these to its messages.
   Only the 401 on the user verify route was seen live.
4. `GET /accounts/{id}/access/organizations` answers 404 when Zero Trust has
   never been opened. (The page treats a 404 or a missing `auth_domain` as
   "open Zero Trust once and pick a team name".)
5. `PUT /accounts/{id}/access/organizations` accepts the whole object read by
   `GET` (minus `created_at` / `updated_at`), and `GET` returns every field
   that `PUT` would otherwise reset (if it leaves one out, an account-wide
   setting could change), with
   `mfa_config: { allowed_authenticators: ["totp", "biometrics", "security_key"], session_duration: "24h" }`,
   and that this is what switches on independent second factor for the
   account. Not run live: it changes an account-wide setting. If the page
   cannot do it, switch it on by hand as
   `engine/deploy/cloudflare-access-setup.md` shows.
6. Creating the one-time PIN method with
   `POST /accounts/{id}/access/identity_providers` and
   `{ name, type: "onetimepin", config: {} }`. (Reading it is verified.)
10. `PUT /accounts/{id}/access/apps/{app_id}` accepts a body made of the
    plan's fields plus the cosmetic ones (`logo_url`, `custom_deny_message`,
    `custom_deny_url`, `custom_non_identity_deny_url`, `custom_pages`,
    `tags`) and resets everything else to its default. The names of the
    fields treated as loosening sign-in (`cors_headers`,
    `options_preflight_bypass`, `allow_authenticate_via_warp`,
    `allow_iframe`, `read_service_tokens_from_header`,
    `service_auth_401_redirect`, `skip_interstitial`) and of the rule fields
    (`approval_required`, `approval_groups`, `isolation_required`,
    `purpose_justification_required`, `connection_rules`) are from the
    documentation too.
15. That `mfa_config` on one application makes Cloudflare ask for a second
    factor there when it is **not** required account-wide. On the account
    used, independent second factor was already on for the whole account.
16. List endpoints accept `page` and `per_page` and report
    `result_info.total_pages`.
17. Permission names in the dashboard: "Access: Apps and Policies",
    "Access: Organizations, Identity Providers, and Groups", Zone "DNS", each
    at level "Edit" (the API calls the same level "Write").
18. That these four permissions are enough for every call above, in
    particular the identity-provider calls and the organization `PUT`. The
    token used for the live run was broader.
19. The hosting platform routes requests for the custom hostname to the app
    only once that hostname is listed on the app, and issues or accepts a
    certificate for it while Cloudflare proxies the record.
20. A real person signing in through Claude, from the first connector click
    to a first answer.
21. The token link. That Cloudflare's short keys `access` and `access_acct`
    select the permissions the dashboard calls "Access: Apps and Policies"
    and "Access: Organizations, Identity Providers, and Groups", and `dns`
    selects Zone "DNS", each at Edit. The link's form is from Cloudflare's
    documentation; it has not been opened against a live account. If a
    permission is missing on the screen, add it by hand.
22. What `kbe access setup` expects of the hosting platform: that the
    answer to an app update names the deployment it started, and that a
    declared secret sent back with no value is blanked. Without the first,
    the command falls back to watching for a new active deployment. If the
    second does not hold, `SETUP_CODE` keeps its (already useless) value:
    remove it in the dashboard.

Anything that turns out to have no working API becomes a manual step on the
page, checked before the page moves on.

## 8. Text from your sources and the summarising model

The Engine sends the text of meetings, Drive files and mail to a model that
writes a short summary of each document. Other people write that text. Any
of it can hold a sentence addressed to the model, such as "ignore your
instructions and label this document as ...". This is called prompt
injection.

### What the Engine does

Before any source text is put in a prompt, it passes through one step
(`scripts/knowledge/prompt_guard.py`):

1. Look-alike forms of characters (a full-width `＜`, a ligature) are folded
   to the plain character, and characters that hide text from a reader are
   removed.
2. Anything that imitates a chat role, or the Engine's own delimiters, is
   defanged.
3. The best-known "ignore your instructions" phrasings are replaced with the
   visible marker `[instruction-like text removed]`.
4. The text is placed between two delimiter lines that carry a random id made
   for that one prompt. The source cannot know the id, so it cannot end the
   block early.
5. The prompt tells the model that everything inside the block is material to
   describe, not instructions.

The same step is used for the summary prompt
(`scripts/knowledge/distill.py`) and for the prompt that picks related pages
for a meeting (`pullers/meeting_links.py`). The stored document is not
changed; only the copy sent to the model is.

### What this does not do

It lowers the risk. It does not remove it. A model can still be steered by
text this step does not recognise: other wording, another language, or
letters from another alphabet that only look the same. No filter of this
kind is complete.
A summary may therefore be wrong, or may say what a hostile document wanted
it to say.

### What holds even when the model is fooled

These do not depend on the model behaving:

| Protection | Where | Effect |
| --- | --- | --- |
| A model can only narrow a document's topics | `labels.arbitrate` | The topics come from the tag at the source. The model's proposal can remove readers, never add one. A proposal for another topic is refused and the document is flagged for review. |
| Key terms must be written in the source | `distill.verify_terms` | Every term the model returns is checked against the original text. A term that is not there is dropped. If more than half are dropped, the whole summary is refused. |
| The reply must have the expected shape | `model_client`, `distill.parse` | Anything that is not the expected JSON object is refused. |
| Related pages come from a closed list | `meeting_links.parse_llm_titles` | The model can only pick titles of pages that exist. |
| The model has no tools | all prompts | It cannot read other documents, call an API or send anything. One document goes in; one summary comes out. |

### What is left

- **A misleading summary.** The `what` and `why` sentences are the model's
  words. A hostile document can make its own summary misleading. The summary
  is shown with the document it came from, to people who can already see that
  document. Read the document itself when accuracy matters.
- **A document that hides itself.** A document may persuade the model to
  narrow its topics, so fewer people see it. It cannot widen them.
- **Tag proposals are a model's suggestion.** `python -m kbe tags suggest`
  asks a model to propose a topic for untagged items. A proposal changes
  nothing until a person reads it and runs `kbe tags apply`; that person is
  the check. Read each proposal as you would read a stranger's advice.
- **Your own assistant reads this text too.** The step above protects the
  summarising model only. Document text, summaries and issue titles are
  later returned by the connector to the assistant of whoever asks, and that
  assistant may have tools, the admin tools included. Text in a document or
  in a reported issue can therefore try to steer it. The admin tools answer
  this with their two steps: nothing changes until the person has read the
  preview and said yes. Read the preview; do not let an assistant confirm on
  its own.
- **The model provider sees the text.** Summarising sends each document to
  the provider named in `models.distill`. Choose a provider you are allowed
  to send that text to.

### The curator (pages written from raw items)

The curator changes pages, so it is held more tightly than the summariser
(`engine/src/curator/`, migration 0053):

| Rule | Where it holds |
|---|---|
| Items that look written to steer an AI never reach the model; they wait for their owner to release them, and everything from a released item waits for a yes | `curator/guard.ts` `screen`, `curator_claim` |
| The item's text is neutralised and delimited the same way as above (a port of `prompt_guard.py`) | `curator/guard.ts` |
| It writes only the item owner's pages, only pages with exactly the item's topic (one topic per page, 0063); a new page gets the item's topic. Facts from an item in another topic go to a separate page. No owner or topic comes from the model | `curator_candidates`, `curator_page_save` (database) |
| It can change page text, fields and new pages only. Nothing it returns can touch people, grants, topics, sharing or settings | the reply contract, `curator/output.ts` |
| A reply outside the contract is refused whole: unknown page or field, a value the drawer does not allow, a patch that does not apply, text copied from another page, a link (`related`) to a page that is neither on the shortlist nor made in the same reply | `curator/output.ts` |
| Large changes (stage, value, new deal, large text) wait in `curator_reviews` for the owner's yes; only the owner can decide, and only on the app screen `/app/reviews` (no MCP tool can approve) | `curator/policy.ts`, `app_review_decide` (0054) |
| The tick address takes a shared secret checked against Supabase Vault; the service never holds it. The model key is read from the vault and never logged | `curator_tick_secret_ok`, `curator/model.ts` |
| Outbound calls: `inference.do-ai.run` is added to the allowlist when the curator first calls the model | `curator/model.ts` |

What is left: a fooled model can still write a wrong but well-formed small
change to a page the item really belongs to (a wrong next step, a misleading
dated line). Each such change names its source item and model in the page's
`sources` and `generated`, and history keeps the version before it.

### The app screens (Step D, migration 0054)

**First-run claim.** A new Engine deployed without `SETUP_CODE` makes a
random one-time code at boot and writes it once to its own run log (the only
line that ever holds it; the logger scrubs it from every other line). Opening
`/setup?code=<code>` claims the app: the code is spent in that process and the
claimant gets a signed, HttpOnly, SameSite=Strict cookie on `/setup` for two
hours. Five wrong codes from one client (CF-Connecting-IP, else the first
X-Forwarded-For address) lock that client out for an hour; 100 wrong codes
from anyone in 15 minutes lock claiming for everyone. The locks live in the
process: restarting the app resets them (and makes a new code). A restart before setup is
finished makes a new code. Run one instance during setup: each instance makes
its own code. Once the Engine has sign-in settings, the claim and Database
screens answer 404.

**Database screen.** The claimant types the Supabase project ref and one
access token. The ref must be the project in the app's `SUPABASE_URL`; the
token is used for that one request (Management API) and is never stored,
logged or shown. The screen checks the app's JWT secret and anon key belong
to that project, applies the migrations, exposes the schema, deploys the
embed function, makes the embed token (hash on the principal, token in Vault),
stores the claimant as the first administrator (refused if another owner
exists), with the name they typed for "What should your pages call you?" as
their display name and name used on pages (1 to 60 characters, one line; the
email when left out), and opens the sign-in step for this claim. A token that can reach more
than one project gets a warning: prefer a token for this project only.

**Your name** (`/setup/people`, 0077): an administrator changes only their
OWN display name and name used on pages (`app_my_names_set` takes the row from
the signed-in email, never from the form), with the screen's form token. The
page name goes into the curator's prompt as one line with no quotes or control
characters, and the database enforces the same shape.

**Settings screens** (`/setup/people`, `/setup/template`, `/setup/model`,
`/setup/timer`, `/setup/health`) sit behind the admin application (second
factor), and the service re-checks the assertion and that the person is an
active administrator, as for `/status`. The model key goes straight into
Vault (`kbe_model_key`) through `app_secret_set`, which returns nothing; the
timer secret is made inside the database and never leaves it, and the timer
can only call the Engine's own host: the screen sends the signed-in Access
host, and `app_timer_set` refuses any host but the one sign-in setup stored,
then builds the address itself.

**Backup screen** (`/setup/backup`, migration 0056) is the Engine owner's
alone: the admin application lets administrators reach it, and every
`app_backup_*` function then refuses anyone but the owner (the config's
`engine.owner.email`, else the first administrator), because the backup
repository holds every page with no row protection. The GitHub token goes
into Vault (`kbe_backup_token`) through `app_secret_set` (owner only for this
name) and is read back only by `backup_token()`, granted to the service role,
just before a backup. It is sent to `api.github.com` in the Authorization
header and nowhere else (that host is allowed only for a claimed backup run);
the stored error and the log carry the step and HTTP status only. The run
checks the repository is private before every write. `page_import` (the
`kbe pages import` command) is granted to no API role. Only it can set a
page's created and updated dates (migration 0074, from the old wiki's
frontmatter); every other save dates the page now.

**Owner screens** (`/app/...`) need the Engine's own sign-in and an active
person. Every function behind them (0054) takes the verified email and acts on
that person's own rows only: their review queue, their flagged items, their
pages and history. Page edits and restores go through the same write core as
`save_page`, with the content-hash check.

**Sources and inclusion rules** (`/app/sources`, migration 0063). What
Gmail and Fireflies ingest keeps is decided by each person's own rules,
enforced in the database, never by the ingest run
([source-rules.md](source-rules.md)):

| Rule | Where it holds |
|---|---|
| Default-deny: an item no include rule matches is counted and never stored; an exclude rule always wins; the first include match decides | `source_item_record`, `_source_rules_eval` |
| The topic comes from the rule; any `topics` or `owner` the run passes is ignored; the owner is the signed-in subject | `source_item_record`; also dropped in `tools/pages/source.ts` |
| A rule maps only to a topic its author holds (or private); a rule whose topic was taken away, or whose label or channel is gone, matches nothing | `_source_rules_normalize`, `_src_rule_broken` |
| Each person reads and changes only their own accounts and rules, administrators included; an administrator sees a count of rules per person and nothing else | `_src_own_account`, `app_people_rule_counts` |
| Rule lists are append-only versions; every change is audited; each kept item stamps its rule and version | `source_rule_sets` (trigger), `source_rule_audit` |
| Narrowing re-files kept items owner-only at once and flags their pages | `_src_refile` |
| The dry-run sample is metadata only (addresses, label or channel ids, participants, date); a subject or text is refused at the tool | `report_ingest_candidates` schema, `_src_meta` |
| Topics are made by administrators only | `app_topic_add` (admin check); `app_source_tag_set` is no longer callable by the service |

What is left: the provider query is built from the rules to list less, but
the run could list more; that is harmless (the database drops it) but the
run's model still reads those items. Addresses are matched as the provider
reports them; a forged From header matches like a real one.

**Forms.** Every post must come from the same site (Sec-Fetch-Site or
Origin), be a plain form post, and carry a token that is an HMAC of the
signed-in email, the form and the hour, keyed from the project JWT secret.

**The timer path skips Cloudflare sign-in.** Sign-in setup adds a third
Access application for `<host>/internal/curator/tick` only, with a bypass
rule, because Supabase cron cannot sign in. That path answers POST only and
checks the timer secret against Vault on every poke (401 otherwise).

## 9. Mail (the Gmail source)

The Gmail source is optional and off by default. Mail is the most personal
source, so it has rules the other sources do not.

### What is read

- **One mailbox.** `sources.gmail.mailboxes` names it; left empty, it is the
  owner's (`engine.owner.email`). One mailbox is supported for now.
- **Only labelled threads.** A thread is read only if it carries a label
  named the tag prefix plus a topic (`kx/consulting`). The prefix is
  `sources.gmail.prefix`, or `tagging.prefix` when that is not set. Threads
  are listed by label, so mail without a tag label is never listed, fetched
  or stored. There is no sender list and no search query.
- **Read-only.** The sign-in asks Google for `gmail.readonly`. The Engine
  cannot send, change or delete mail.
- **Removal follows the label.** Take the label off and the thread is
  removed from the index at the next run. The raw text of mail is not kept
  in the raw-capture layer, which is never deleted from.

### The sign-in

`python -m kbe sources gmail auth` opens a browser sign-in and produces one
secret, `GMAIL_TOKEN_JSON_B64`. It goes to the clipboard or into a new file
only its owner can read, and is never printed. It is stored as an encrypted
value on the `puller-gmail` job and in the local env file, nowhere else.
`python -m kbe sources gmail check` proves the sign-in works and is for the
mailbox the config names; if it is for another address, the job stops before
it lists anything. The check lists no thread and reads no mail.

### Who can see a thread

Every thread carries the owner of the mailbox it came from.

| Who asks | What they see |
| --- | --- |
| The owner of the mailbox | Their own labelled threads, at once |
| Anyone else, administrators included | A thread only when all three hold: it has been **approved** in review, the person holds one of its topics, and the mailbox's owner is still an active person |
| Anyone, for a thread with no owner recorded | Nothing |

An administrator has no way round this rule. An administrator sees approved
mail in the topics an administrator holds, which is every topic that is not
sensitive, and nothing more. This is a decision, not an accident: once the
mailbox's owner has approved a thread for a shared topic, the people who
hold that topic may read it, and an administrator holds every topic that is
not sensitive. Mail that is unapproved, or in a sensitive topic the
administrator was not granted by name, stays out of their reach.

The rule is enforced in the database (`_document_visible`, migrations 0038
to 0040) for search, `get_document` and `who_knows`, on both the connector
path and the token path.

### What is left

- Approving a thread shares all of it: every message, and the names and
  addresses of everyone on it, with everyone who holds its topic.
- A label is put on by whoever uses the mailbox. A filter that labels mail
  automatically decides what the Engine reads.
- The summarising model's provider sees the text of every labelled thread,
  approved or not (section 8).

## 10. Smaller rules worth knowing

- **`kbe access setup` hands no secret to anyone.** It makes the setup
  code and uses it itself. It has no flag that shows the code or takes the
  token as a value.
- **A new secret is never printed by default.** `kbe access init`,
  `kbe access reopen` and `kbe support enable` hand their secret to the
  clipboard (`--clipboard`) or to a new owner-only file (`--out FILE`).
  `--show` prints it, and is refused when the output is not a terminal, so
  a program or an assistant cannot use it. `kbe tokens mint` has no way to
  print at all. With no flag, each command refuses before it changes
  anything.
- **A reactivated person does not get an old token back.** Reactivating
  clears the stored token hash.
- **Drive tags count only on items the Engine's Google account owns**
  (`sources.drive.trust_tags_from: owner`, the default). This does not
  cover an editor changing the description of an item you own; see
  [tagging.md](tagging.md#google-drive).
- **Issue text is other people's words.** `kbe issues` removes control
  characters before it prints a title or a detail, so text in an issue
  cannot drive the terminal.
