# Changelog

All notable changes to Quantabase are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

To update a running Engine, open **Staff & settings > Updates**: it shows
the version you run, the latest on `stable` and what changed in between. An
entry says so when updating needs more than the steps in
[`docs/operations.md`](docs/operations.md#updates).

## 1.0.0-rc.3 - 2026-11-28

**Updating needs one extra step:** after Force Rebuild and Deploy, open the
Database screen and apply the pending update (migration 0080).

- **Claude helps you set up Gmail rules.** Each Gmail account on the Sources
  screen has a prompt with a Copy button. Paste it into Claude: the new
  `/qb-engine:suggest-rules` skill reads only who wrote to whom and when
  (never subjects or text) from the last 90 days, asks a few short
  questions, and sends your picks to the Engine. On the account page the
  "Suggested from your mail" card has them ticked; you save the rule there.
  Claude never creates a rule. Update the plugin to 0.5.0 to get the skill.
- **"Subscriptions" is now "Sources"**, and the screen starts with a short
  note: rules decide what is kept (nothing is kept without an include rule)
  and they replace the older source tags.

## 1.0.0-rc.2 - 2026-11-26

**Updating needs one extra step:** after Force Rebuild and Deploy, open the
Database screen and apply the pending update (migration 0079).

- **Long pages are kept whole on import.** `kbe pages import` no longer cuts
  a page over the 200,000-character limit. It splits it into linked parts
  ("<title> (part 2)", ...), each pointing to the next and the previous. The
  dry run says "Split into linked parts, nothing cut".
- **Recurring meetings are no longer dropped on import.** Meetings with the
  same name on different dates used to match each other, so only the first
  was kept. Meetings now match only on their own key (date and title).
  Re-run the import after the update to add the missing ones; pages already
  there are left alone.

## 1.0.0-rc.1 - 2026-11-24

The first public release.

- **The Engine**: one DigitalOcean service, deployed with the README's
  "Deploy to DO" button from `stable`, that reads the sources each person
  chooses (a wiki repository, Google Drive, Fireflies, and items their own
  Claude sends), keeps curated pages per person, and serves them to Claude
  over MCP, filtered by who is asking. Sign-in through Cloudflare Access.
- **Setup in the browser**: claim the Engine with the one-time code from its
  run log, build the database from the Database screen, then add people and
  topics under Staff & settings.
- **The `qb-engine` Claude plugin**: `/qb-engine:ingest` copies new Gmail,
  Drive, Fireflies and Calendar items into your Engine;
  `/qb-engine:schedule-setup` schedules one ingest task per source;
  `/qb-engine:send-session` sends a short note of what a Claude Code session
  found. Install with `/plugin marketplace add imagicrafter/quantabase`, then
  `/plugin install qb-engine@quantabase`.
- **Updates screen**: shows the running version, the latest release and what
  is new, and links to the DigitalOcean app (Actions -> Force Rebuild and
  Deploy) and the Database screen.
- **Nightly backup** of every page to a GitHub repository of your own, and
  restore from it.
