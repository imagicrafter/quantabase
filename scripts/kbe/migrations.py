"""Working out which migration files to run. No database access here.

A migration is a file `NNNN_snake_case.sql` under supabase/migrations. They
run in filename order. What has run is remembered by filename and checksum
(SHA-256 of the file), so an edited file is noticed instead of silently
skipped.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Collection, Mapping, Sequence

from .errors import KbeError, UsageError

_NAME = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")
_NUMBER = re.compile(r"^\d{1,4}$")


@dataclass(frozen=True)
class Migration:
    number: int
    filename: str
    path: Path
    checksum: str
    # Checksums this file had before a comment-only rewording (reworded.json).
    earlier: tuple[str, ...] = ()

    def matches(self, recorded: str) -> bool:
        return recorded == self.checksum or recorded in self.earlier


@dataclass(frozen=True)
class Plan:
    """What `migrate` would do against a database that has `applied`."""

    pending: tuple[Migration, ...] = ()
    # Already applied, but the file has changed since.
    changed: tuple[Migration, ...] = ()
    # Changed, and the caller said the new content is fine (--accept-changed).
    accepted: tuple[Migration, ...] = ()
    # Recorded in the database with no file here any more.
    missing: tuple[str, ...] = ()
    # Pending, but numbered below something already applied.
    out_of_order: tuple[Migration, ...] = ()

    @property
    def blocked(self) -> bool:
        return bool(self.changed)


def checksum(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


REWORDED = "reworded.json"


def _reworded(directory: Path) -> dict[str, tuple[str, ...]]:
    """{file: earlier checksums} from reworded.json; {} when there is none."""
    path = directory / REWORDED
    if not path.is_file():
        return {}
    try:
        files = json.loads(path.read_text(encoding="utf-8"))["files"]
        return {str(name): tuple(str(c) for c in sums) for name, sums in files.items()}
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise KbeError(f"{REWORDED} in {directory} could not be read ({type(error).__name__}).") from error


def discover(directory: Path) -> tuple[Migration, ...]:
    """Every migration file, in the order it must run."""
    if not directory.is_dir():
        raise KbeError(f"No migrations folder at {directory}.")
    found = []
    reworded = _reworded(directory)
    for path in sorted(directory.glob("*.sql")):
        match = _NAME.fullmatch(path.name)
        if match is None:
            raise KbeError(
                f"{path.name} is not named like 0001_some_change.sql. "
                "Rename it or move it out of the migrations folder."
            )
        found.append(Migration(int(match.group(1)), path.name, path, checksum(path),
                               reworded.get(path.name, ())))
    unknown = sorted(set(reworded) - {m.filename for m in found})
    if unknown:
        raise KbeError(f"{REWORDED} names a file that does not exist: {', '.join(unknown)}.")
    numbers = [m.number for m in found]
    repeated = sorted({n for n in numbers if numbers.count(n) > 1})
    if repeated:
        listed = ", ".join(f"{n:04d}" for n in repeated)
        raise KbeError(f"Two migration files share a number: {listed}.")
    return tuple(found)


def plan(
    migrations: Sequence[Migration],
    applied: Mapping[str, str],
    accept_changed: Collection[str] = (),
) -> Plan:
    """Compare the files with what the database has recorded."""
    by_name = {m.filename: m for m in migrations}
    unknown = sorted(name for name in accept_changed if name not in by_name)
    if unknown:
        raise UsageError(
            f"--accept-changed names a file that does not exist: {', '.join(unknown)}."
        )
    differs = tuple(
        m for m in migrations if m.filename in applied and not m.matches(applied[m.filename])
    )
    pending = tuple(m for m in migrations if m.filename not in applied)
    highest = max((by_name[n].number for n in applied if n in by_name), default=-1)
    return Plan(
        pending=pending,
        changed=tuple(m for m in differs if m.filename not in accept_changed),
        accepted=tuple(m for m in differs if m.filename in accept_changed),
        missing=tuple(sorted(name for name in applied if name not in by_name)),
        out_of_order=tuple(m for m in pending if m.number < highest),
    )


def parse_number(text: str) -> int:
    """`0028` or `28` -> 28."""
    if not _NUMBER.fullmatch(text.strip()):
        raise UsageError(f'"{text}" is not a migration number. Use four digits, such as 0028.')
    return int(text)


def through(migrations: Sequence[Migration], number: int) -> tuple[Migration, ...]:
    """Every migration numbered up to and including `number`."""
    if number not in {m.number for m in migrations}:
        raise UsageError(f"There is no migration numbered {number:04d}.")
    return tuple(m for m in migrations if m.number <= number)
