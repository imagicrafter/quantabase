# Rules for working in this vault

This folder is a knowledge repo: Markdown pages that an Engine indexes and
serves to people according to each page's topic. Follow these rules whenever
you read or write here.

## Where a page goes

- `concepts/`: how something works (an idea, a method, a term).
- `decisions/`: a choice that was made, with the date and the reason.
- `projects/`: ongoing work, one page or one folder per project.
- `people/`: who someone is and how the owner works with them.
- `meetings/`: meeting notes. The Engine writes some of these itself; do not
  rename or move a page it wrote.
- `index.md`: the front page. Add a link when you add an important page.

File names are lower-case words joined by dashes, ending in `.md`.

## Tagging (this decides who can see a page)

1. Every page starts with a frontmatter block that carries the topic key:

   ```markdown
   ---
   title: A short, plain title
   domains: [topic-id]
   ---
   ```

2. Use only topic ids that are declared under `domains:` in
   `.kb-engine/engine.yaml`. Read that file before you tag anything.
3. Never invent a topic id. If no declared topic fits, leave the key out and
   tell the owner; do not guess.
4. A page with no topic is still indexed, but only the owner can see it.
   That is the safe default, so when in doubt, leave it untagged.
5. A page may list more than one topic. Anyone granted any of them can see
   the whole page, so list a second topic only when the whole page belongs
   there.
6. Never widen who can see an existing page (adding a topic, or swapping a
   locked topic for an open one) unless the owner asked for exactly that.

## Things you must not do

- Do not put passwords, API keys, tokens or connection strings in any page.
- Do not edit `.kb-engine/engine.yaml` unless the owner asked you to. If you
  do, change only what was asked and say what you changed.
- Do not delete or rewrite pages in bulk. Propose the change first.
- Do not copy private details about a person into a page with an open topic.

## Writing style

- One subject per page. Link to other pages with `[[page-name]]`.
- Lead with the answer; put background after it.
- Give dates in full (2026-03-01), never "last week".
- Say where a fact came from when it is not the owner's own knowledge.
