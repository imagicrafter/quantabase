"""Reading the local settings file, the same way everywhere.

`read(path)` returns the file's values as a plain mapping and exports nothing
into the process. One rule is applied here so every reader agrees with the
`kbe` command line (scripts/kbe/secrets.py):

    a line still holding its example placeholder, `NAME=<what goes here>`,
    is not set. Its value reads as empty.

Without this, a copied example file would hand `<your-key>` to a client as if
it were a key, and the failure would come from the far end with no name in it.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

_PLACEHOLDER = re.compile(r"<[^<>]*>")


def is_placeholder(value: Any) -> bool:
    """True for an unfilled example value such as `<your-project-ref>`."""
    return isinstance(value, str) and _PLACEHOLDER.fullmatch(value.strip()) is not None


def read(path: Path | str) -> dict[str, str | None]:
    """The values in the settings file at `path`. Placeholders read as empty."""
    from dotenv import dotenv_values

    raw = dict(dotenv_values(path))
    return {name: ("" if is_placeholder(value) else value) for name, value in raw.items()}
