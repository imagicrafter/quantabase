"""The knowledge (wiki) repo as a puller sees it -- clone/pull, then commit + push.

Shared by `pullers.wiki` (read-only: index the pages) and
`pullers.meeting_writeback` (write meeting pages back). A DO job container
starts from nothing every run, so the repo is cloned into the job's own
ephemeral filesystem. Where `knowledge.config.WIKI_ROOT` already points at a
real checkout (a developer machine, a long-lived host) it is used as-is.

Which repo: `sources.wiki.repo` in the Engine config.

Pushes never force. A rejected push is rebased onto the remote and retried
(MAX_PUSH_ATTEMPTS); anything still failing raises with the token redacted.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from knowledge.env_file import read as read_env_file

from knowledge.config import WORKSPACE_ROOT
from knowledge.engine_config import get_config

# Cloned fresh into the job's own ephemeral filesystem, never into WORKSPACE_ROOT
# -- KNOWLEDGE_WIKI_ROOT in .env, when set, overrides this.
CHECKOUT_DIR = WORKSPACE_ROOT / ".puller-cache" / "knowledge"
MAX_PUSH_ATTEMPTS = 3
BOT_NAME = "kb-engine puller"
BOT_EMAIL = "kb-engine-puller@users.noreply.github.com"
GIT_TIMEOUT_SECONDS = 120


class KnowledgeRepoError(RuntimeError):
    """The knowledge repo could not be cloned, pulled, committed or pushed."""


def wiki_repo() -> str:
    """GitHub "owner/name" of the knowledge repo, from the Engine config."""
    repo = get_config().sources.wiki.repo
    if not repo:
        raise KnowledgeRepoError(
            "No knowledge repo is configured. Set sources.wiki.repo in the "
            "Engine config (for example acme/knowledge)."
        )
    return repo


def github_token() -> str:
    values = read_env_file(WORKSPACE_ROOT / ".env")
    token = (values.get("GITHUB_TOKEN") or values.get("GH_TOKEN") or "").strip()
    if not token:
        raise KnowledgeRepoError(
            "GITHUB_TOKEN (or GH_TOKEN) not set in .env -- required to clone "
            f"{wiki_repo()} from a job container with no pre-existing checkout."
        )
    return token


def _redact(text: str, token: str | None) -> str:
    return text.replace(token, "***") if token else text


def _git(root: Path, *args: str, token: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True, text=True, timeout=GIT_TIMEOUT_SECONDS,
    )


def ensure_checkout() -> Path:
    """Clone the knowledge repo if absent, pull if already there. Returns its root."""
    repo = wiki_repo()
    token = github_token()
    clone_url = f"https://x-access-token:{token}@github.com/{repo}.git"

    if (CHECKOUT_DIR / ".git").exists():
        result = _git(CHECKOUT_DIR, "pull", "--ff-only")
    else:
        CHECKOUT_DIR.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["git", "clone", "--depth", "50", clone_url, str(CHECKOUT_DIR)],
            capture_output=True, text=True, timeout=GIT_TIMEOUT_SECONDS,
        )

    if result.returncode != 0:
        # Never let the token leak into a log via a git error message.
        raise KnowledgeRepoError(
            f"git checkout of {repo} failed: {_redact(result.stderr or '', token)}"
        )
    return CHECKOUT_DIR


def resolve_root() -> Path:
    """An existing local checkout wins; otherwise clone (a job container).

    A local checkout must be on `main` with nothing unpushed, so a bot push can
    only ever carry the bot's own commit. It is rebased onto origin/main first.
    """
    from knowledge.config import WIKI_ROOT

    if not WIKI_ROOT.exists():
        return ensure_checkout()
    prepare_local(WIKI_ROOT)
    return WIKI_ROOT


def _ahead_count(root: Path) -> int:
    result = _git(root, "rev-list", "--count", "origin/main..HEAD")
    if result.returncode != 0:
        raise KnowledgeRepoError(f"git rev-list failed in {root}: {result.stderr.strip()}")
    return int((result.stdout or "0").strip() or 0)


def prepare_local(root: Path) -> None:
    branch = (_git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout or "").strip()
    if branch != "main":
        raise KnowledgeRepoError(f"{root} is on branch {branch!r}, not main -- refusing to write meeting pages")
    fetched = _git(root, "fetch", "origin", "main")
    if fetched.returncode != 0:
        raise KnowledgeRepoError(f"git fetch failed in {root}: {fetched.stderr.strip()}")
    if _ahead_count(root):
        raise KnowledgeRepoError(
            f"{root} has unpushed commits -- push or resolve them before meeting pages are written"
        )
    pulled = _git(root, "pull", "--rebase", "--autostash", "origin", "main")
    if pulled.returncode != 0:
        _git(root, "rebase", "--abort")
        raise KnowledgeRepoError(f"git pull failed in {root}: {pulled.stderr.strip()}")


def on_main(root: Path, rel_path: str) -> bool:
    """Is this exact file content committed on origin/main?"""
    remote = _git(root, "rev-parse", f"origin/main:{rel_path}")
    local = _git(root, "hash-object", "--", rel_path)
    return remote.returncode == 0 and remote.stdout.strip() == local.stdout.strip()


def commit_and_push(root: Path, rel_paths: list[str], message: str) -> str:
    """Commit ONLY `rel_paths` and push to origin main. Returns the sha, or "".

    Other dirty files in a local checkout are left alone: the commit is scoped
    to the given paths and the rebase autostashes around them.
    """
    if not rel_paths:
        return ""

    token = None
    try:
        token = github_token()
    except KnowledgeRepoError:
        pass  # Local checkout: the user's own git credentials push.

    def _fail(step: str, result: subprocess.CompletedProcess) -> KnowledgeRepoError:
        detail = _redact((result.stderr or result.stdout or "").strip(), token)
        return KnowledgeRepoError(f"git {step} failed in {root}: {detail}")

    added = _git(root, "add", "--", *rel_paths)
    if added.returncode != 0:
        raise _fail("add", added)

    staged = _git(root, "diff", "--cached", "--name-only", "--", *rel_paths)
    if not (staged.stdout or "").strip():
        return ""

    committed = _git(
        root,
        "-c", f"user.name={BOT_NAME}", "-c", f"user.email={BOT_EMAIL}",
        "commit", "-m", message, "--", *rel_paths,
    )
    if committed.returncode != 0:
        raise _fail("commit", committed)

    def _undo_commit() -> None:
        # Drop the bot commit but keep the files, so the next run re-commits
        # them instead of treating a never-pushed page as already published.
        _git(root, "reset", "--soft", "HEAD~1")

    last: subprocess.CompletedProcess | None = None
    for _attempt in range(MAX_PUSH_ATTEMPTS):
        if _ahead_count(root) != 1:
            _undo_commit()
            raise KnowledgeRepoError(
                f"refusing to push from {root}: HEAD is not exactly one bot commit ahead of origin/main"
            )
        pushed = _git(root, "push", "origin", "HEAD:main")
        if pushed.returncode == 0:
            sha = _git(root, "rev-parse", "HEAD")
            return (sha.stdout or "").strip()
        last = pushed
        rebased = _git(root, "pull", "--rebase", "--autostash", "origin", "main")
        if rebased.returncode != 0:
            _git(root, "rebase", "--abort")
            _undo_commit()
            raise _fail("pull --rebase", rebased)

    _undo_commit()
    raise _fail("push", last)  # type: ignore[arg-type]
