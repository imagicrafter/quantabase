# Changelog

All notable changes to Quantabase are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

To update a running Engine, open **Staff & settings > Updates**: it shows
the version you run, the latest on `stable` and what changed in between. An
entry says so when updating needs more than the steps in
[`docs/operations.md`](docs/operations.md#updates).

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
