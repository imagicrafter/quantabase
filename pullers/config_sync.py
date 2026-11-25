"""Apply the Engine config from the knowledge repo, when it changed.

The config lives in the owner's knowledge repo at `.kb-engine/engine.yaml`.
The wiki puller has that repo checked out, so on each run it:

  1. reads the file (no file: nothing to do; a file that is not what the
     repo's main branch holds -- an unpushed edit in a local checkout -- is
     left alone);
  2. validates it -- the same validator `kbe config validate` uses;
  3. compares its hash with the config the database has applied
     (`knowledge.config_hash`, the one implementation `kbe config apply` uses);
  4. if they differ, applies it through `engine_config_apply`, before any
     page is ingested.

An invalid file is rejected whole. So is one the database refuses (a new
owner, an unsafe topic change). The previous config stays in force and an
issue is opened (category `config_invalid`, dedupe key `config`). The next
valid file closes it. The issue never holds text from the file: only a count
of problems, or the class of the refusal.

Nothing here raises: a bad config must not stop the wiki from being indexed
under the config that is still in force.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from knowledge import engine_config, engine_config_schema, issues
from knowledge.config_hash import config_hash
from knowledge.kb_schema import db
from pullers import knowledge_repo

CONFIG_PATH = Path(".kb-engine") / "engine.yaml"
ISSUE_KEY = "config"
ISSUE_CATEGORY = "config_invalid"

ABSENT, UNPUBLISHED, UNCHANGED, APPLIED, INVALID, REFUSED = (
    "absent", "unpublished", "unchanged", "applied", "invalid", "refused",
)


def _log(text: str) -> None:
    print(f"[config] {text}", file=sys.stderr)


def _issue(error_class: str, detail: str) -> issues.SystemIssue:
    return issues.SystemIssue(
        category=ISSUE_CATEGORY,
        title="engine config in the knowledge repo was not applied",
        detail=detail,
        source="wiki",
        error_class=error_class,
        dedupe_key=ISSUE_KEY,
    )


def _open_issue(sb: Any, error_class: str, detail: str) -> None:
    try:
        issues.upsert(sb, _issue(error_class, detail))
    except Exception as error:  # noqa: BLE001 -- the issue log must not stop a run
        _log(f"WARNING could not log the issue: {type(error).__name__}")


def _close_issue(sb: Any, proof: str) -> None:
    try:
        issues.close(sb, ISSUE_KEY, proof)
    except Exception as error:  # noqa: BLE001
        _log(f"WARNING could not close the issue: {type(error).__name__}")


def _read(path: Path) -> tuple[Any, engine_config.EngineConfig, str]:
    """The parsed file, its validated form and its hash. Raises ConfigurationError."""
    import yaml

    try:
        raw = engine_config_schema.load_yaml(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as error:
        raise engine_config.ConfigurationError(
            f"engine config could not be read: {type(error).__name__}"
        ) from error
    validated = engine_config.validate(raw)
    try:
        return raw, validated, config_hash(raw)
    except ValueError as error:
        raise engine_config.ConfigurationError(f"engine config is invalid:\n  {error}") from error


def _problem_count(error: engine_config.ConfigurationError) -> int:
    return max(1, sum(1 for line in str(error).splitlines()[1:] if line.strip()))


def _applied_hash(sb: Any) -> str | None:
    current = db(sb).rpc("engine_config_get", {}).execute().data
    return config_hash(current) if current else None


def apply_from_checkout(root: Path, sb: Any) -> str:
    """Bring the database's config in line with the checkout. Never raises.

    Returns one of ABSENT, UNPUBLISHED, UNCHANGED, APPLIED, INVALID, REFUSED.
    """
    path = Path(root) / CONFIG_PATH
    if not path.is_file():
        return ABSENT
    if not knowledge_repo.on_main(Path(root), CONFIG_PATH.as_posix()):
        # A checkout someone is working in: only what is on the repo's main
        # branch is ever applied, never an edit that was not pushed.
        _log(f"{CONFIG_PATH} differs from origin/main in this checkout; not applied")
        return UNPUBLISHED
    try:
        raw, validated, digest = _read(path)
    except engine_config.ConfigurationError as error:
        count = _problem_count(error)
        _log(f"{CONFIG_PATH} is invalid ({count} problem(s)); the previous config stays in force")
        _open_issue(
            sb, "ConfigurationError",
            f"{count} problem(s) found. The previous config stays in force. "
            "Check the file with kbe config validate.",
        )
        return INVALID
    try:
        if _applied_hash(sb) == digest:
            _close_issue(sb, "the config in the knowledge repo is valid and applied")
            return UNCHANGED
        db(sb).rpc("engine_config_apply", {"p_config": raw, "p_hash": digest}).execute()
    except Exception as error:  # noqa: BLE001 -- refused or unreachable: keep the old config
        name = issues.error_class_of(error)
        _log(f"{CONFIG_PATH} was not applied ({name}); the previous config stays in force")
        _open_issue(
            sb, name,
            "The database did not accept the config. The previous config stays in "
            "force. Apply it by hand with kbe config apply to see why.",
        )
        return REFUSED
    _log(f"applied {CONFIG_PATH} from the knowledge repo")
    _close_issue(sb, "a valid config was applied from the knowledge repo")
    if not os.environ.get(engine_config.CONFIG_ENV_VAR):
        engine_config.use_config(validated)
    return APPLIED
