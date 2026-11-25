# Setting up Cloudflare Access by hand

The setup page (`/setup`) does all of this for you; see
[`docs/security.md`](../../docs/security.md). Use this page when you want to
create the Cloudflare side yourself, or when the setup page reports a step it
could not do and you need to finish that step by hand.

Examples use the hostname `engine.example.com`.

## 1. DNS

Create the app first (`python -m kbe deploy render`, then
`python -m kbe deploy apply`) to get its own `*.ondigitalocean.app` address.
The app fails to start until its secrets are set; only the address is needed
here.

In the Cloudflare DNS for your domain:

| Type  | Name     | Target                     | Proxy                  |
| ----- | -------- | -------------------------- | ---------------------- |
| CNAME | `engine` | `<app>.ondigitalocean.app` | Proxied (orange cloud) |

The record must be proxied. Access cannot protect a DNS-only record.

## 2. The hostname application

Zero Trust, Access controls, Applications, Add an application,
**Self-hosted and private**, **Public DNS**.

- Hostname: `engine.example.com`
- Policy: Allow, `Emails` = an explicit list. This is what decides who can
  sign in.
- Additional settings, OAuth, **Managed OAuth**: on.

Note the application's AUD tag (Additional settings) and the account's team
domain (Settings, Team name and domain: `https://<team>.cloudflareaccess.com`).

## 3. The admin-pages application

A second self-hosted application for the paths `engine.example.com/status`
and `engine.example.com/setup`, with a policy that allows the owner's email
only and requires a second factor. Note its AUD tag. It must differ from the
first application's: the service refuses to serve those pages otherwise.

## 4. Store the settings

```
python -m kbe access adopt --team-domain https://<team>.cloudflareaccess.com --aud <AUD of the hostname application> --status-aud <AUD of the admin-pages application> --host engine.example.com --level people --dry-run
```

Run it again without `--dry-run`. None of these values is a secret. Setup is
then complete and the jobs start reading on their next run.

## 5. The allowed redirect list starts empty

**Symptom:** on Connect, Claude shows a message such as "Couldn't register
with the sign-in service".

**Cause:** Additional settings, OAuth, **Allowed redirect URIs** is empty by
default. Client registration refuses every redirect address that is not on
the list (localhost and loopback aside) with
`{"error":"invalid_client_metadata","error_description":"redirect_uri is not allowed by the account configuration"}`.
This is separate from the policy and from the hostname.

**Fix:** add the connecting client's redirect addresses. For Claude:

```
https://claude.ai/api/mcp/auth_callback
https://claude.com/api/mcp/auth_callback
```

If registration still fails with the exact addresses, a trailing `/*`
matches any path on an HTTP or HTTPS origin (`https://claude.ai/*`). Test
registration with curl before trying the client again:

```bash
curl -s -X POST https://<team>.cloudflareaccess.com/cdn-cgi/access/oauth/registration \
  -H "Content-Type: application/json" \
  -d '{"redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"client_name":"probe"}'
# 200 with a client_id means the list is right.
```

`python -m kbe verify --phases authentication` runs the same test.

## 6. Discovery is answered by Cloudflare

Cloudflare Access itself answers `/.well-known/oauth-protected-resource`
(with and without the `/mcp` suffix) on the application's hostname. The
request does not reach the service. `engine/src/auth/access/protected-resource.ts`
is a fallback only.

## 7. The sign-in test

On a new Zero Trust account the one-time PIN is the only sign-in method.
That is expected. Cloudflare sends a PIN to whatever address is typed and
applies the policy afterwards, so a PIN can arrive for an address the policy
then refuses. If no PIN arrives within a couple of minutes, try a second
address that is on the list before assuming something is broken: an address
can be on a domain that accepts mail and still have no mailbox.
