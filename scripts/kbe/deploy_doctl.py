"""The few `doctl apps` calls the deploy commands make.

Every call goes through the context's runner. Nothing secret is ever put on a
command line or written to disk: a spec that holds secret values, stored or
new, is sent on standard input. Output from `doctl` can hold a whole spec,
so on failure only its error text is shown, and that is passed through
`secrets.redact` first.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from . import proc, secrets
from .errors import KbeError, UsageError

_APP_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_ENCRYPTED = re.compile(r"EV\[[^\]\s]*\]")


@dataclass(frozen=True)
class App:
    id: str
    name: str = ""
    default_hostname: str = ""
    phase: str = "unknown"
    deployed_at: str = ""
    in_progress: str = ""
    # Deployment ids, where doctl gives them: the one serving now, and the one
    # on its way (in progress, or still queued).
    active_id: str = ""
    coming_id: str = ""


@dataclass(frozen=True)
class JobRun:
    job: str
    phase: str
    at: str


def check_app_id(app_id: str) -> str:
    if not _APP_ID.fullmatch(app_id or ""):
        raise UsageError("The app id must look like 123e4567-e89b-12d3-a456-426614174000.")
    return app_id


def _hostname(ingress: Any) -> str:
    text = str(ingress or "").strip()
    return re.sub(r"^https?://", "", text).strip("/")


def _app(item: Any) -> App:
    if isinstance(item, list):
        item = item[0] if item else None
    if not isinstance(item, Mapping) or not item.get("id"):
        raise KbeError("doctl answered with something this tool could not read.")
    active = item.get("active_deployment") or {}
    pending = item.get("in_progress_deployment") or {}
    queued = item.get("pending_deployment") or {}
    return App(
        id=str(item["id"]),
        name=str((item.get("spec") or {}).get("name") or ""),
        default_hostname=_hostname(item.get("default_ingress")),
        phase=str(active.get("phase") or "no active deployment"),
        deployed_at=str(active.get("updated_at") or active.get("created_at") or ""),
        in_progress=str(pending.get("phase") or queued.get("phase") or ""),
        active_id=str(active.get("id") or ""),
        coming_id=str(pending.get("id") or queued.get("id") or ""),
    )


def _error_text(result: proc.ProcResult) -> str:
    """What `doctl` said went wrong, and nothing else it printed.

    `doctl` writes its error to standard output, not standard error: as
    `{"errors": [{"detail": ...}]}` with `--output json`, as `Error: ...`
    without. Any other output may be a whole spec and is never shown.
    """
    if result.stderr.strip():
        return result.stderr.strip()
    try:
        parsed = json.loads(result.stdout)
    except ValueError:
        parsed = None
    if isinstance(parsed, Mapping) and isinstance(parsed.get("errors"), list):
        details = [str(e.get("detail") or "") for e in parsed["errors"] if isinstance(e, Mapping)]
        return "\n".join(d for d in details if d)
    return "\n".join(
        line.strip() for line in result.stdout.splitlines()
        if line.strip().lower().startswith("error")
    )


@dataclass(frozen=True)
class Doctl:
    runner: proc.Runner
    hidden: Mapping[str, str] = field(default_factory=dict, repr=False)

    def _run(self, args: list[str], stdin: str | None = None) -> proc.ProcResult:
        result = self.runner(["doctl", *args], stdin=stdin, timeout=180)
        if result.code == proc.NOT_FOUND:
            raise KbeError("doctl is not installed. Run: python -m kbe doctor")
        return result

    def _ok(self, args: list[str], what: str, stdin: str | None = None) -> str:
        result = self._run(args, stdin)
        if not result.ok:
            shown = secrets.redact(_error_text(result), self.hidden)
            reason = _ENCRYPTED.sub("EV[...]", shown) or f"exit {result.code}"
            raise KbeError(f"doctl could not {what}:\n{reason}")
        return result.stdout

    def _json(self, args: list[str], what: str, stdin: str | None = None) -> Any:
        text = self._ok([*args, "--output", "json"], what, stdin)
        try:
            return json.loads(text)
        except ValueError as error:
            raise KbeError("doctl answered with something this tool could not read.") from error

    def create(self, spec_file: Path) -> App:
        return _app(self._json(["apps", "create", "--spec", str(spec_file)], "create the app"))

    def live_spec(self, app_id: str) -> Mapping[str, Any]:
        import yaml

        text = self._ok(["apps", "spec", "get", app_id, "--format", "yaml"], "read the live spec")
        try:
            spec = yaml.safe_load(text)
        except yaml.YAMLError as error:
            raise KbeError("The live spec could not be read as YAML.") from error
        if not isinstance(spec, Mapping):
            raise KbeError("The live spec is empty or not a mapping.")
        return spec

    def update(self, app_id: str, spec_text: str) -> App:
        """Update from a spec on standard input (it holds secret values)."""
        args = ["apps", "update", app_id, "--spec", "-"]
        return _app(self._json(args, "update the app", stdin=spec_text))

    def get(self, app_id: str) -> App:
        return _app(self._json(["apps", "get", app_id], "read the app"))

    def deploy(self, app_id: str) -> str:
        made = self._json(["apps", "create-deployment", app_id], "start a deployment")
        item = made[0] if isinstance(made, list) and made else made
        return str(item.get("id") or "") if isinstance(item, Mapping) else ""

    def job_runs(self, app_id: str) -> list[JobRun] | None:
        """The latest run of each job, or None when doctl cannot say."""
        result = self._run(["apps", "list-job-invocations", app_id, "--output", "json"])
        if not result.ok:
            return None
        try:
            rows = json.loads(result.stdout or "[]")
        except ValueError:
            return None
        latest: dict[str, JobRun] = {}
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, Mapping):
                continue
            at = str(
                row.get("completed_at") or row.get("started_at") or row.get("created_at") or ""
            )
            run = JobRun(str(row.get("job_name") or "?"), str(row.get("phase") or "unknown"), at)
            if run.job not in latest or run.at > latest[run.job].at:
                latest = {**latest, run.job: run}
        return [latest[name] for name in sorted(latest)]
