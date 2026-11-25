"""What `kbe sources list` shows: the enabled sources and each one's last run.

The sources come from the config applied in the database; the runs from the
`connector_state` table, read as `kb_ingest`. A stored error message is never
read, let alone shown -- it may carry content. Only whether the last run
failed, and how many in a row.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Mapping, Sequence

from . import ingest_client, pg, proc, schema as kb
from .errors import KbeError

SOURCE_ORDER = ("wiki", "drive", "fireflies", "gmail")
STATE_TABLE = "connector_state"
STATE_COLUMNS = ("source", "last_run_at", "last_success_at", "consecutive_failures")


@dataclass(frozen=True)
class SourceStatus:
    source: str
    enabled: bool
    last_run_at: str | None = None
    last_success_at: str | None = None
    consecutive_failures: int = 0

    @property
    def state(self) -> str:
        if not self.last_run_at:
            return "never run"
        return "failing" if self.consecutive_failures > 0 else "ok"

    def as_json(self) -> dict[str, Any]:
        return {**asdict(self), "state": self.state}


def enabled_sources(config: Mapping[str, Any] | None) -> dict[str, bool]:
    """Every known source, and whether the applied config turns it on."""
    if not config:
        raise KbeError(
            "No Engine config has been applied to this database yet. Run: "
            "python -m kbe config apply <path to engine.yaml>"
        )
    declared = config.get("sources")
    sources = declared if isinstance(declared, Mapping) else {}
    return {
        name: isinstance(sources.get(name), Mapping) and bool(sources[name].get("enabled"))
        for name in SOURCE_ORDER
    }


def _rows_api(values: Mapping[str, str]) -> list[Mapping[str, Any]]:
    try:
        response = (
            ingest_client.client(values).schema()
            .table(STATE_TABLE).select(", ".join(STATE_COLUMNS)).execute()
        )
    except KbeError:
        raise
    except Exception as error:  # noqa: BLE001 - any transport or driver failure
        raise KbeError(
            f"Could not read the sources' last runs ({type(error).__name__})."
        ) from error
    return list(response.data or [])


def _rows_db(values: Mapping[str, str], runner: proc.Runner) -> list[Mapping[str, Any]]:
    table = f"{kb.chosen(values)}.{STATE_TABLE}"
    found = pg.connect(values, runner).rows(
        f"select {', '.join(STATE_COLUMNS)} from {table} order by 1;"
    )
    return [
        {name: (cell or None) for name, cell in zip(STATE_COLUMNS, row)} for row in found
    ]


def state_rows(values: Mapping[str, str], runner: proc.Runner) -> list[Mapping[str, Any]]:
    """Connector state rows: over the API as kb_ingest, else the direct connection."""
    if all(values.get(key) for key in ingest_client.API_KEYS):
        return _rows_api(values)
    if values.get(pg.DATABASE_URL_KEY):
        return _rows_db(values, runner)
    raise KbeError(
        "No way to reach the database. Set SUPABASE_URL, SUPABASE_ANON_KEY and "
        f"SUPABASE_JWT_SECRET, or {pg.DATABASE_URL_KEY}, in your local env file."
    )


def _count(value: Any) -> int:
    try:
        return max(int(value or 0), 0)
    except (TypeError, ValueError):
        return 0


def combine(
    enabled: Mapping[str, bool], rows: Sequence[Mapping[str, Any]]
) -> tuple[SourceStatus, ...]:
    """One status per known source, enabled ones first, in a fixed order."""
    by_source = {str(row.get("source")): row for row in rows}
    statuses = tuple(
        SourceStatus(
            source=name,
            enabled=enabled.get(name, False),
            last_run_at=(by_source.get(name) or {}).get("last_run_at") or None,
            last_success_at=(by_source.get(name) or {}).get("last_success_at") or None,
            consecutive_failures=_count((by_source.get(name) or {}).get("consecutive_failures")),
        )
        for name in SOURCE_ORDER
    )
    return tuple(sorted(statuses, key=lambda status: not status.enabled))


def _line(status: SourceStatus) -> str:
    switch = "enabled " if status.enabled else "disabled"
    if status.state == "never run":
        return f"{status.source:<10} {switch}  never run"
    if status.state == "failing":
        count = status.consecutive_failures
        return (
            f"{status.source:<10} {switch}  last run {status.last_run_at} FAILED "
            f"({count} in a row); last good run {status.last_success_at or 'never'}"
        )
    return f"{status.source:<10} {switch}  last run {status.last_run_at} ok"


def render(statuses: Sequence[SourceStatus]) -> str:
    return "\n".join(_line(status) for status in statuses)
