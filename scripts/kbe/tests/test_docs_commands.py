"""The docs cannot name a `kbe` command or flag the tool does not have.

Every `kbe ...` command written in the setup manifest, the skills and the
docs is resolved against the real argparse tree. Two written forms are read:

    python -m kbe <group> <command> ...     (also `{python} -m kbe ...`)
    `kbe <group> <command> ...`             (inside backticks)

The first form is a command as it is run, so it must name a complete command.
The second also appears in prose (`kbe people`), so a group on its own is
accepted there. Every `--flag` written after a command must be one the
command, or `kbe` itself, takes.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Iterator

import pytest

from kbe import cli

ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "setup" / "manifest.yaml"
SKILLS = ("kb-engine-setup", "kb-engine-admin", "kb-engine-tagging")
SKILL_FILES = tuple(ROOT / ".claude" / "skills" / name / "SKILL.md" for name in SKILLS)
OTHER_DOCS = (
    ROOT / "CLAUDE.md", ROOT / "README.md", ROOT / "SETUP.md",
    ROOT / "scripts" / "kbe" / "README.md",
    *sorted((ROOT / "docs").glob("*.md")),
)

_RUN_FORM = re.compile(r"-m kbe[ \t]+([^\n`\"|;&)]*)")
_TICK_FORM = re.compile(r"`kbe[ \t]+([^`\n]*)`")
_WORD = re.compile(r"[a-z][a-z-]*")
_FLAG = re.compile(r"(?<![\w-])(--[a-z][a-z-]*)")
_PLACEHOLDER = ("<", "$", '"$', "{")


def _subcommands(parser: argparse.ArgumentParser) -> dict[str, argparse.ArgumentParser]:
    for action in parser._actions:  # noqa: SLF001 - argparse has no public walk
        if isinstance(action, argparse._SubParsersAction):  # noqa: SLF001
            return dict(action.choices)
    return {}


def _flags(parser: argparse.ArgumentParser) -> set[str]:
    return {text for action in parser._actions for text in action.option_strings}  # noqa: SLF001


def resolve(
    tokens: list[str], parser: argparse.ArgumentParser, complete: bool,
    path: tuple[str, ...] = (),
) -> str | None:
    """Walk `tokens` down the parser tree. Returns a problem, or None."""
    if not tokens:
        if complete and _subcommands(parser):
            return f'`{" ".join(("kbe", *path))}` is not a complete command'
        return None
    choices = _subcommands(parser)
    if not choices:
        return None  # a leaf: what follows are its own arguments
    token, rest = tokens[0].strip("[]()*,.:"), tokens[1:]
    if token.startswith(_PLACEHOLDER):
        if "|" not in token:
            return None  # <name>, $source: any one command
        options = [part for part in token.strip('<>"').split("|")]
        problems = [resolve([option, *rest], parser, complete, path) for option in options]
        return next((problem for problem in problems if problem), None)
    if token in ("--help", "-h", "--version"):
        return None  # complete at any level
    if token.startswith("-"):
        # A `kbe`-level option; --env-file takes a value.
        return resolve(rest[1:] if token == "--env-file" else rest, parser, complete, path)
    if token not in choices:
        if not _WORD.fullmatch(token) and not complete:
            return None  # prose after a group name
        return f'"{token}" is not a command of `{" ".join(("kbe", *path))}`'
    return resolve(rest, choices[token], complete, (*path, token))


def leaf(tokens: list[str], parser: argparse.ArgumentParser) -> argparse.ArgumentParser:
    current = parser
    for raw in tokens:
        choices = _subcommands(current)
        token = raw.strip("[]()*,.:")
        if token not in choices:
            break
        current = choices[token]
    return current


def commands_in(text: str) -> Iterator[tuple[str, bool]]:
    """(the words after `kbe`, written as a command to run) for each mention."""
    for match in _RUN_FORM.finditer(text):
        yield match.group(1).strip(), True
    for match in _TICK_FORM.finditer(text):
        yield match.group(1).strip(), False


def problems_in(text: str, parser: argparse.ArgumentParser) -> list[str]:
    found = []
    for written, complete in commands_in(text):
        tokens = written.split()
        problem = resolve(tokens, parser, complete)
        if problem:
            found.append(f"kbe {written}: {problem}")
            continue
        if any(token.startswith(_PLACEHOLDER) and "|" in token for token in tokens[:3]):
            continue  # several commands at once: their flags differ
        known = _flags(leaf(tokens, parser)) | _flags(parser)
        unknown = sorted(set(_FLAG.findall(written)) - known)
        if unknown:
            found.append(f"kbe {written}: no such flag {', '.join(unknown)}")
    return found


@pytest.fixture(scope="module")
def parser() -> argparse.ArgumentParser:
    return cli.build_parser()


def test_the_checker_itself(parser):
    def check(text: str) -> list[str]:
        return problems_in(text, parser)

    assert check("python -m kbe db migrate --dry-run") == []
    assert check("`kbe sources <wiki|fireflies|drive> check`") == []
    assert check("the `kbe people` group, and `kbe access reopen`.") == []
    assert check("python -m kbe --env-file x.env doctor") == []
    assert check("python -m kbe --help") == [] and check("python -m kbe db --help") == []
    assert "not a command" in check("python -m kbe db migrat")[0]
    assert "not a command" in check("`kbe sources gmail nope`")[0]
    assert "not a complete command" in check("python -m kbe sources drive")[0]
    assert "no such flag --force" in check("python -m kbe deploy apply --force")[0]
    assert "not a command" in check("`kbe sources <wiki|nope> check`")[0]


@pytest.mark.parametrize("path", [MANIFEST, *SKILL_FILES], ids=lambda p: p.parent.name)
def test_manifest_and_skills_name_real_commands(path, parser):
    assert path.is_file(), f"{path} is missing"
    text = path.read_text(encoding="utf-8")
    assert list(commands_in(text)), f"{path} names no kbe command"
    assert problems_in(text, parser) == []


@pytest.mark.parametrize("path", OTHER_DOCS, ids=lambda p: p.name)
def test_docs_name_real_commands(path, parser):
    if not path.is_file():
        pytest.skip(f"{path.name} is not in this checkout")
    assert problems_in(path.read_text(encoding="utf-8"), parser) == []


def test_every_manifest_phase_command_is_checked(parser):
    """Each phase's `command:` is either a kbe command or says why not."""
    import yaml

    phases = yaml.safe_load(MANIFEST.read_text(encoding="utf-8"))["phases"]
    commands = [phase["command"] for phase in phases if phase.get("command")]
    assert len(commands) >= 9
    for command in commands:
        assert "python -m kbe " in command, command
        assert problems_in(command, parser) == [], command
