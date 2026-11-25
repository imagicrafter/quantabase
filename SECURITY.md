# Security policy

## Reporting a vulnerability

Report it privately through GitHub: on this repository's page, open the
**Security** tab and choose **Report a vulnerability**. That opens a private
advisory that only the maintainers can see.

Do not open a public issue or a pull request for a security problem, and do
not include a real secret, a real hostname or real document content in a
report. A description, the affected file or route, and the steps to
reproduce are enough.

What to expect:

- An acknowledgement in the advisory thread.
- A fix on the `stable` branch, and a note in `CHANGELOG.md`, once the
  problem is confirmed.
- Credit in the advisory if you want it.

## What counts

Anything that lets a person see a document outside their topics, reach the
Engine without signing in, read a secret, or use the setup page without the
setup code. [`docs/security.md`](docs/security.md) describes how sign-in and
the setup page are meant to work, what has been left as a known limit, and
what has not yet been verified against a live Cloudflare account. A report
about one of the listed known limits is still welcome if you have found a
way to make it worse than described.

## If a secret of your own Engine leaks

That is not a vulnerability in this repository, but act at once: rotate the
secret at its provider, enter the new value in your hosting dashboard, and
redeploy. [`docs/operations.md`](docs/operations.md) and the
`kb-engine-admin` skill list each secret and how to rotate it.

## Supported versions

Fixes are made on the `stable` branch. Every Engine deploys from it, so an
Engine gets a fix on its next deploy.
