# Setting up an Engine: the one-page version

Read this before you start. It says what you need, what you will be asked,
what happens in what order, and where you have to act yourself. It is not
the instructions; those are the guided setup or the build manual.

- **Guided:** open this repository in Claude Code and say "set up the
  engine". Claude leads you through every step.
- **By hand:** [`docs/build-manual.md`](docs/build-manual.md).

Most of the time in a first setup goes to creating accounts and waiting for
deployments.

## What you end up with

- A private GitHub repository for your pages and your Engine's config.
- A database that indexes what the Engine reads.
- One small app on DigitalOcean: the service, and a daily job per source.
- Sign-in on your own hostname, with a code sent by email.
- An address to add to Claude: `https://<your hostname>/mcp`.

## What you need

| | Notes |
|---|---|
| Supabase account | A new project, or one you already have |
| DigitalOcean account | With billing set up. Also a serverless inference key, for the summaries |
| Cloudflare account | With a domain on it. Open Zero Trust once and pick a team name |
| GitHub account | For the private knowledge repository |
| Google account | Only for the Drive source. Needs a Google Cloud project with the Drive API on and a "Desktop app" OAuth client |
| Fireflies API key | Only for the meetings source |
| On your computer | `git`, `gh` (GitHub's command line), `doctl` (DigitalOcean's), Node.js 22+, Python 3.10+, `psql` (the Postgres client) and the `supabase` command line. `python -m kbe doctor` checks them and says how to install each one that is missing |

You pay your own providers. There is no licence fee. Check each provider's
current pricing.

## What you will be asked

Have answers ready. (The guided setup asks a few more, such as the
DigitalOcean region and how your name is written in meeting notes.)

1. A short id and a display name for the Engine (`acme`, "Acme's Quantabase").
2. The owner's email. It cannot be changed later.
3. Your topics, and which are sensitive. A sensitive topic cannot be
   unlocked later.
4. Which sources: the wiki always; Drive and Fireflies if you want them.
5. The hostname, for example `engine.example.com`, on your Cloudflare domain.
6. Who may sign in: only you, a list of people, or everyone at your company
   domain.
7. A new knowledge repository, or an existing one.

## The order of things

| # | Step | Who |
|---|---|---|
| 1 | Check the tools (`kbe doctor`) | Claude |
| 2 | Put your Supabase values into a local file, `.env` | **You** |
| 3 | Build the database (`kbe db migrate`) | Claude |
| 4 | Deploy the embed function (`kbe db deploy-functions`) | Claude |
| 5 | Create the knowledge repository (`kbe repo init`) | Claude |
| 6 | Apply the config (`kbe config apply`) | Claude |
| 7 | Make the embed token | Claude; **you** copy one value |
| 8 | Create the app (`kbe deploy render`, `kbe deploy apply`) | Claude; **you** check the billing estimate |
| 9 | Set the app's secrets from your `.env` file (`kbe deploy secrets push`; the DigitalOcean dashboard is the fallback) | **Claude**, with your yes |
| 10 | Set up sign-in (`kbe access setup`) | Claude runs it; **you** open one link, create the Cloudflare token and copy it, and say yes |
| 11 | Connect each source and check it (`kbe sources ... check`) | **You** make the credentials; Claude checks |
| 12 | Add people and grant topics (`kbe people`) | Claude, after your yes |
| 13 | First run of the jobs | Claude |
| 14 | Add the connector in Claude and sign in | **You** |
| 15 | Tag your material | Claude proposes; **you** approve |
| 16 | Optional: support access (`kbe support enable`) | **You** |
| 17 | Final check (`kbe verify`) | Claude |

## Rules that protect you

- Nobody asks you for a secret in a chat. You type secrets into the local
  `.env` file or into your hosting dashboard. If you paste one into a chat
  by mistake, replace it at the provider.
- The Cloudflare token goes from your clipboard into `kbe access setup` (or
  you type it into the setup page). It is never shown, is used once and is
  not kept. Delete it in Cloudflare when you are done.
- Nothing is read from your sources until sign-in is set up.
- Until you tag something, only the owner can see it.
- Every change that lets more people see something is shown to you first.

## Things to know before you commit

- Sign-in is by a code sent to email. There is no other sign-in method yet.
- Adding a person later may need a small change in Cloudflare as well as in
  the Engine, depending on the sign-in level you chose.
- Setup's Cloudflare steps have not been proven against every
  account. If one fails, the page says which, and
  [`engine/deploy/cloudflare-access-setup.md`](engine/deploy/cloudflare-access-setup.md)
  shows the same step by hand.
- Gmail is not part of the guided setup yet.

## If you stop part way

Progress is saved on your computer. Open Claude Code in this repository
again and say "continue my setup".

## After setup

[`docs/operations.md`](docs/operations.md): health, updates, backups. In
Claude Code, the `kb-engine-admin` skill handles day-to-day changes and the
`kb-engine-tagging` skill handles tags.
