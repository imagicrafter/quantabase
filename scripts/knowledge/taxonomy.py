"""Removed. Topics are no longer guessed from tags, names or folders.

A document's topics now come only from tags a person can see and change at
the source. Use `knowledge.tag_resolver.resolve(...)` with the readers in
`knowledge.tag_sources`. See docs/tagging.md.

This module is kept for one release so an old import fails with a clear
message instead of an ImportError.
"""

from __future__ import annotations

_MESSAGE = (
    "knowledge.taxonomy.assign_domains was removed: topics are decided by tags "
    "at the source. Call knowledge.tag_resolver.resolve(source, content_tags, "
    "container_tags, config) instead (see docs/tagging.md)."
)


class TaxonomyRemovedError(RuntimeError):
    """The keyword rules are gone; the caller must use the tag resolver."""


def assign_domains(*_args, **_kwargs):
    raise TaxonomyRemovedError(_MESSAGE)
