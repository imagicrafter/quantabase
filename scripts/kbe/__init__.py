"""kbe -- the command line for setting up and looking after an Engine.

Run as `python -m kbe <group> <command>` with `PYTHONPATH=scripts:.`.
See scripts/kbe/README.md.
"""

from pathlib import Path

_VERSION_FILE = Path(__file__).resolve().parents[2] / "VERSION"


def _read_version() -> str:
    """The release this checkout is: the one line in the repository's VERSION file."""
    try:
        return _VERSION_FILE.read_text(encoding="utf-8").strip() or "unknown"
    except OSError:
        return "unknown"


__version__ = _read_version()
