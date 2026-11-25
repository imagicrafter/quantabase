"""No ingestion before sign-in is set up.

During the setup window the database must hold no knowledge: until someone
has decided who may sign in, nothing is indexed. The runner asks this module
before every run.

THE RULE. A run may ingest when either of these is true:

  1. The database holds sign-in settings: `engine_access_status().access` has
     a team domain, an AUD tag and a hostname. The setup page stores them
     when setup completes, and `kbe access adopt` stores them for a deployment
     set up by hand. They stay in force while setup is reopened, so a reopened
     setup does not stop ingestion.

  2. The job's own settings carry both CF_ACCESS_TEAM_DOMAIN and
     CF_ACCESS_AUD: a deployment that gives the service its sign-in settings
     through variables gives the same two (non-secret) values to its jobs.
     `kbe deploy render --cf-team-domain ... --cf-aud ...` does that. They are
     read from the job's local env file and from the process, the same two
     places KB_SCHEMA is read from.

Otherwise the run stops before it touches a source: one log line, exit code
0, and no issue is opened (an Engine that is not set up yet is not broken).

One exception, logged when used: a database from before migration 0035 has
no `engine_access_status()`. It was built before the setup page existed, so
it is allowed. Any other failure to ask is raised -- not knowing whether
sign-in is set up is never treated as a yes.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any, Mapping

from knowledge.env_file import read as read_env_file

from knowledge import config
from knowledge.kb_schema import db

ENV_KEYS = ("CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD")
STORED_KEYS = ("team_domain", "aud", "host")
FUNCTION = "engine_access_status"


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reason: str


def decide(status: Any, settings: Mapping[str, Any]) -> Decision:
    """The rule, with no I/O. `status` is what engine_access_status() returned."""
    access = status.get("access") if isinstance(status, Mapping) else None
    if isinstance(access, Mapping) and all(access.get(key) for key in STORED_KEYS):
        return Decision(True, "sign-in settings are stored in the database")
    if all(str(settings.get(key) or "").strip() for key in ENV_KEYS):
        return Decision(True, "sign-in settings come from this job's environment")
    return Decision(
        False,
        "setup not complete: no sign-in settings yet, so nothing is ingested. "
        "Finish the setup page (or run `kbe access adopt`), then this job will run.",
    )


def job_settings(root: Any = None) -> dict[str, str]:
    """The two sign-in variables, from the local env file and the process."""
    path = (root or config.WORKSPACE_ROOT) / ".env"
    from_file = dict(read_env_file(path)) if path.is_file() else {}
    return {key: from_file.get(key) or os.environ.get(key) or "" for key in ENV_KEYS}


def _predates_the_gate(error: BaseException) -> bool:
    """True only when the database says this one function is not there."""
    text = f"{getattr(error, 'message', '')} {error}"
    if FUNCTION not in text:
        return False
    return (
        getattr(error, "code", None) == "PGRST202"
        or "Could not find the function" in text
        or re.search(rf"function \S*{FUNCTION}\b.*does not exist", text) is not None
    )


def check(sb: Any, settings: Mapping[str, Any] | None = None) -> Decision:
    """Ask the database (as kb_ingest) and apply the rule."""
    chosen = job_settings() if settings is None else settings
    try:
        status = db(sb).rpc(FUNCTION, {}).execute().data
    except Exception as error:  # noqa: BLE001 -- sorted into "old database" or re-raised
        if _predates_the_gate(error):
            return Decision(True, "this database predates the setup gate (migration 0035)")
        raise
    return decide(status, chosen)
