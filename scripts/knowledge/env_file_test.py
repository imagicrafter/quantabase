"""The settings file: an unfilled example placeholder is not a value."""

from __future__ import annotations

import pytest

from knowledge import env_file


def test_placeholders_read_as_empty_and_real_values_are_kept(tmp_path):
    path = tmp_path / "settings"
    path.write_text("A=<your-key>\nB=real-value\nC=\nD=\"<quoted placeholder>\"\nE=x<y>z\n")
    assert env_file.read(path) == {"A": "", "B": "real-value", "C": "", "D": "", "E": "x<y>z"}


@pytest.mark.parametrize("value, expected", [
    ("<x>", True), (" <a b c> ", True), ("<>", True), ("<a><b>", False),
    ("plain", False), ("", False), (None, False),
])
def test_is_placeholder(value, expected):
    assert env_file.is_placeholder(value) is expected


def test_the_rule_matches_the_command_line(tmp_path):
    from kbe import secrets

    for value in ("<x>", " <a b> ", "<a><b>", "x<y>", ""):
        assert env_file.is_placeholder(value) == secrets.is_placeholder(value)
