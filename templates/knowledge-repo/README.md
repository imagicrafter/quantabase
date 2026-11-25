# Knowledge repo

This private repository is the written knowledge behind your Engine. Each
Markdown page here is read by the Engine once a day, indexed, and served to
the people who are allowed to see its topic.

It is also an [Obsidian](https://obsidian.md) vault: open the folder in
Obsidian ("Open folder as vault") to read and edit pages with links and
search. Any Markdown editor works too.

## What is where

| Folder | Holds |
|---|---|
| `concepts/` | How something works: an idea, a method, a term |
| `decisions/` | A choice that was made, when, and why |
| `projects/` | One page (or folder) per piece of ongoing work |
| `people/` | Who someone is and how you work with them |
| `meetings/` | Meeting notes. The Engine can write these for you |
| `index.md` | The front page: links to the pages that matter most |
| `.kb-engine/engine.yaml` | The Engine's config: owner, topics, sources |

## Tagging a page

Every page says which topic it belongs to, in the block at the very top:

```markdown
---
title: How invoicing works
domains: [consulting]
---
```

The topic ids are the ones listed under `domains:` in
`.kb-engine/engine.yaml`. A page with no topic is still indexed, but only the
owner can find it. A topic id that is not in the config counts as no topic;
`python -m kbe tags audit`, run from the Engine repository, lists such pages
so you can fix them.

## Changing the config

Edit `.kb-engine/engine.yaml`, commit and push. The Engine checks the file on
its next daily run and applies it if it is valid. A file with a mistake in it
is rejected whole: the last good config stays in force and an issue is
logged. To apply it at once, run `python -m kbe config apply` from the Engine
repository.

## Rules

- No passwords, keys or tokens in any page.
- One subject per page; link pages to each other instead of repeating them.
- `CLAUDE.md` holds the rules an AI assistant follows when it works here.
