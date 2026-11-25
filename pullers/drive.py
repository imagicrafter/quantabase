"""Drive puller -- wraps `knowledge.connectors.drive`.

Same shape as `pullers/wiki.py`: the connector lists the whole (filtered)
Drive corpus every run and builds Documents directly, so `fetch()` is the
`collect()` call and `to_document()` is identity. Unlike wiki, Drive artifacts
DO get a raw copy -- `runner.py` calls `bronze.capture()` on each Document's
body before ingest.

**The stored sign-in** is two values in the local settings file,
`DRIVE_TOKEN_JSON_B64` and `DRIVE_TOKEN_CLIENT_JSON_B64`, made by
`python -m kbe sources drive auth`. `connectors/drive_client.py` decodes them
in memory; no token file is written. On a deployed job the start command has
already copied both from the job's environment into the settings file (both
names start with `DRIVE_TOKEN_`, which is what that copy keeps).
"""

from __future__ import annotations

from typing import Any, Iterable

from knowledge.connectors import drive as _drive
from knowledge.contract import Document

SOURCE = "drive"
BRONZE = True
FULL_SYNC = True


def fetch(cursor: dict, *, sb: Any = None) -> tuple[Iterable[Document], dict]:
    """Ignore `cursor` -- Drive has none; lists the whole indexed corpus.

    `include_sensitive=True` is NOT optional. This is a full sync: a row the
    connector leaves out is read as deleted at the source and tombstoned. Run
    with the connector's own default (`False`), every sensitive row would be
    removed from the index. Topic tags gate access; this connector indexes
    everything.
    """
    documents, _audits = _drive.collect(include_sensitive=True)
    return documents, {}


def to_document(raw: Document) -> Document:
    """Identity -- `fetch()` already returned validated Documents."""
    return raw
