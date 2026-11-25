"""Per-source tag readers.

Each module turns what a source exposes (frontmatter, a Drive description, a
Fireflies channel, a Gmail label) into `content_tags` / `container_tags` for
`knowledge.tag_resolver.resolve`. Pure functions, no I/O, no config cache.
"""
