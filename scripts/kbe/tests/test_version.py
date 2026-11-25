"""One version: the VERSION file, the `kbe` command and the service agree."""

from __future__ import annotations

import json
import re
from pathlib import Path

import kbe
from kbe import cli

ROOT = Path(__file__).resolve().parents[3]


def _version() -> str:
    return (ROOT / "VERSION").read_text(encoding="utf-8").strip()


def test_the_version_file_holds_one_semantic_version():
    assert re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?", _version())


def test_kbe_reports_the_version_file(capsys):
    assert kbe.__version__ == _version()
    try:
        cli.main(["--version"])
    except SystemExit:
        pass
    assert capsys.readouterr().out.strip() == f"kbe {_version()}"


def test_the_service_package_has_the_same_version():
    package = json.loads((ROOT / "engine" / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((ROOT / "engine" / "package-lock.json").read_text(encoding="utf-8"))
    assert package["version"] == _version()
    assert lock["version"] == _version() and lock["packages"][""]["version"] == _version()
