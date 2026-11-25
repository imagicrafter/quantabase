"""Credentials come from a local file, stay out of the process, and never print."""

from __future__ import annotations

import os

import pytest

from kbe import secrets
from kbe.errors import KbeError

FAKE = "not-a-real-value-0123456789"


def _write(tmp_path, text):
    path = tmp_path / "local.env"
    path.write_text(text)
    return path


def test_load_reads_values_without_touching_the_process(tmp_path):
    path = _write(tmp_path, f"KBE_DATABASE_URL={FAKE}\nEMPTY=\n# comment\n")
    values = secrets.load(path)
    assert values["KBE_DATABASE_URL"] == FAKE
    assert "KBE_DATABASE_URL" not in os.environ
    assert "EMPTY" not in values


def test_loaded_values_are_read_only(tmp_path):
    values = secrets.load(_write(tmp_path, "A=1\n"))
    with pytest.raises(TypeError):
        values["A"] = "2"


def test_missing_file_names_the_path_only(tmp_path):
    with pytest.raises(KbeError) as caught:
        secrets.load(tmp_path / "absent.env")
    assert "absent.env" in str(caught.value)


def test_load_optional_returns_empty_for_a_missing_file(tmp_path):
    assert dict(secrets.load_optional(tmp_path / "absent.env")) == {}


def test_require_names_missing_keys_and_no_values(tmp_path):
    values = secrets.load(_write(tmp_path, f"SUPABASE_URL={FAKE}\n"))
    assert secrets.require(values, "SUPABASE_URL") == {"SUPABASE_URL": FAKE}
    with pytest.raises(KbeError) as caught:
        secrets.require(values, "SUPABASE_URL", "SUPABASE_ANON_KEY", "X_KEY")
    message = str(caught.value)
    assert "SUPABASE_ANON_KEY" in message and "X_KEY" in message
    assert FAKE not in message


def test_mask_never_shows_any_part_of_the_value():
    masked = secrets.mask(FAKE)
    assert masked == f"******** ({len(FAKE)} chars)"
    for size in range(4, len(FAKE)):
        assert FAKE[:size] not in masked
    assert secrets.mask("") == "(not set)"
    assert secrets.mask(None) == "(not set)"


def test_redact_removes_every_known_value(tmp_path):
    values = secrets.load(_write(tmp_path, f"A_KEY={FAKE}\nSHORT=ab\n"))
    text = f"connection to {FAKE} failed for ab"
    cleaned = secrets.redact(text, values)
    assert FAKE not in cleaned
    assert "********" in cleaned
    # Very short values are left alone: masking "ab" would shred normal text.
    assert "ab" in cleaned


def test_describe_lists_names_with_masked_values(tmp_path):
    values = secrets.load(_write(tmp_path, f"A_KEY={FAKE}\n"))
    lines = secrets.describe(values, ("A_KEY", "B_KEY"))
    assert lines == [f"A_KEY = ******** ({len(FAKE)} chars)", "B_KEY = (not set)"]
    assert FAKE not in "\n".join(lines)


@pytest.mark.parametrize("text", ["<your-project-ref>", "  <paste the key here> ", "<>"])
def test_an_unfilled_placeholder_counts_as_unset(tmp_path, text):
    values = secrets.load(_write(tmp_path, f'SUPABASE_URL="{text}"\nREAL={FAKE}\n'))
    assert "SUPABASE_URL" not in values
    assert values.get("SUPABASE_URL") is None
    assert dict(values) == {"REAL": FAKE}
    assert values.placeholders == frozenset({"SUPABASE_URL"})


def test_a_value_that_only_contains_angle_brackets_is_real(tmp_path):
    values = secrets.load(_write(tmp_path, "A=x<y>z\nB=<a><b>\n"))
    assert values["A"] == "x<y>z" and values["B"] == "<a><b>"


def test_require_names_the_placeholder_key_and_not_its_text(tmp_path):
    values = secrets.load(_write(tmp_path, "SUPABASE_URL=<your-project-url>\n"))
    with pytest.raises(KbeError) as caught:
        secrets.require(values, "SUPABASE_URL", "OTHER")
    message = str(caught.value)
    assert "SUPABASE_URL (still the example placeholder)" in message
    assert "OTHER" in message and "your-project-url" not in message


def test_load_optional_without_a_file_has_no_placeholders(tmp_path):
    values = secrets.load_optional(tmp_path / "absent.env")
    assert dict(values) == {} and values.placeholders == frozenset()
