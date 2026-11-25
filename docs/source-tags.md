# Topics from source tags

> **Changed by migration 0063.** Gmail and Fireflies now use inclusion rules
> ([source-rules.md](source-rules.md)): labels and channels found at ingest
> are the rule builder's picker, per account, and no longer switch topics on.
> Topics are made by administrators only, so no tag can be switched on any
> more. Drive (and Calendar) keep the behaviour below for tags already
> switched on. Claude Code session notes (0076) work like Drive: the
> project tag is noted switched off, so a note stays with its owner until an
> administrator files the project under a topic. The provider interface at the end still applies.

In Quantabase a topic is never typed in. It is made from a tag that already
exists in one of your sources:

| Source | What counts as a tag |
|---|---|
| Gmail | a label you made (Gmail's own labels such as INBOX or CATEGORY_* never count) |
| Google Drive | the folder a file is in, and a `kx/<name>` tag written in a file's description |
| Fireflies | a channel |
| Google Calendar | nothing: events stay with their owner |
| Claude Code session notes (`claude-code`) | the project: the name of the folder the session ran in (kind `project`; its lower-case name is the id) |

## How it works

1. **Found.** Each ingest run (the plugin's `ingest` skill) hands every
   item over with its labels, folders or channels, unchanged
   (`record_source_item`, field `tags`). The Engine notes each tag it has not
   seen before. Nothing else happens: a tag starts **off**.
2. **Shown.** The tags appear on **Settings > Topics and people**, under
   **Found in your sources**, each with a switch. You only ever see and switch
   tags from your own sources.
3. **Switched on.** Turning a tag on first shows a preview: the topic it makes
   (its id comes from the tag's name, e.g. the label "Clients/Acme" becomes
   `clients-acme`), or the existing topic with that id it would reuse and how
   many people hold it. Only after you say yes is the topic made (or reused),
   given to you, and the tag switched on.
4. **Stamped.** From then on, every new item carrying that tag is filed under
   that topic. The rule is exact and nothing else decides: an item's topics
   are the topics of its switched-on tags that you still hold. An item with no
   switched-on tag has no topic and stays yours alone.
5. **Switched off.** New items stop getting the topic. Items already filed
   keep it. (Turning off is not retroactive.)

The same tag id from two sources (a Gmail label id and a Drive folder id) is
two different tags. Your tags are yours: another person's label with the
same name or id is a separate row they switch themselves.

Topics declared in the config file (`domains:` in `engine.yaml`) remain the
path for the older wiki, Drive and Fireflies pullers and for migrating an
existing Engine. A config apply never removes a topic that a source tag uses.

## Adding a source: the provider interface

Each source has one small module in `engine/src/sources/providers/` that
exports a `TagProvider` (`engine/src/sources/types.ts`):

```ts
export type TagProvider = {
  readonly source: string;              // the source name, e.g. "gmail"
  readonly kinds: readonly string[];    // tag kinds it returns, e.g. ["label"]
  readonly howToRead: string;           // plain words for the ingest run: what to pass in `tags`
  readonly normalize: (raw: readonly RawTag[]) => readonly SourceTag[];
};

type RawTag = { id?: string; name?: string; kind?: string };   // as the run passed it
type SourceTag = { kind: string; id: string; name: string };    // clean
```

- **`id`** is the source's stable id for the tag (a Gmail label id, a Drive
  folder id, a Fireflies channel id). Prefer an id that survives a rename;
  the name is only shown.
- **`name`** is what a person sees. It also seeds the topic id.
- **`normalize`** must be deterministic and must drop anything that can never
  be a topic (system labels, empty names). Use the helpers in
  `engine/src/sources/clean.ts` (`tag`, `unique`): they trim, cut ids to 300
  and names to 200 characters, drop repeats and cap an item at 50 tags.
- **`howToRead`** is sent to the ingest run in `get_ingest_plan`
  (`scope.tags`). Tell the run what to pass, never to judge or pick.

Then list the provider in `engine/src/sources/index.ts`, add the source to
`INGEST_SOURCES` in `engine/src/tools/pages/ingest-plan.ts` with its listing
steps, and add tests next to `engine/tests/sources/providers.test.ts`. A
source with no provider keeps no tags, so its items stay with their owner.
