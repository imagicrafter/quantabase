"""The example settings file names every setting the Python code reads, and no real value."""

from __future__ import annotations

import re
from pathlib import Path

from kbe import env_names, secrets

ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / (".env" + ".example")
CODE = (ROOT / "scripts", ROOT / "pullers")
_LINE = re.compile(r"^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$")
# Values that are plainly not secrets and may be written out in the example.
_PLAIN = re.compile(r"|true|false|\d+|remote|local|do|anthropic|workspace|openai-gpt-oss-120b")


def _entries() -> dict[str, tuple[bool, str]]:
    """name -> (the line is on, its value), for every KEY= line, on or off."""
    found: dict[str, tuple[bool, str]] = {}
    for raw in EXAMPLE.read_text(encoding="utf-8").splitlines():
        match = _LINE.match(raw.strip())
        if match:
            found[match.group(2)] = (match.group(1) is None, match.group(3).strip())
    return found


def test_every_setting_the_python_code_reads_is_in_the_example():
    read = env_names.names_read(CODE)
    assert len(read) > 25, "the walk found too few names to be trusted"
    missing = sorted(read - set(_entries()))
    assert not missing, (
        "These settings are read by code under scripts/ or pullers/ but are not in the "
        f"example settings file: {', '.join(missing)}. Add a line for each (a `# NAME=` "
        "line is enough), or list the name in kbe.env_names.NOT_SETTINGS with the reason."
    )


def test_the_named_groups_are_all_there():
    names = set(_entries())
    assert {"KBE_DATABASE_URL", "KBE_ENV_FILE", "KBE_STATE_FILE", "KBE_PSQL"} <= names
    assert {"CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"} <= names      # job sign-in settings
    assert {"GMAIL_TOKEN_JSON_B64", "KB_SCHEMA"} <= names


def test_the_example_holds_no_real_value():
    for name, (_on, value) in _entries().items():
        assert secrets.is_placeholder(value) or _PLAIN.fullmatch(value), (
            f"{name} in the example settings file holds something that is neither a "
            "<placeholder> nor a plain default"
        )


def test_a_copied_example_leaves_every_secret_unset(tmp_path):
    copy = tmp_path / "settings"
    copy.write_text(EXAMPLE.read_text(encoding="utf-8"), encoding="utf-8")
    values = secrets.load(copy)
    assert set(values) <= {
        "KNOWLEDGE_EMBED_BACKEND", "KNOWLEDGE_MODEL_BACKEND", "KNOWLEDGE_MODEL_ID",
        "FIREFLIES_RETENTION_DRY_RUN",
    }
    assert "SUPABASE_URL" in values.placeholders


def test_the_walk_reads_the_forms_the_code_uses():
    source = (
        'A_KEY = "FIRST_NAME"\nNAMES_KEYS = ("SECOND_NAME", "THIRD_NAME")\n'
        'x = values.get("FOURTH_NAME")\ny = values["FIFTH_NAME"]\n'
        'z = os.environ.get("SIXTH_NAME")\nrequire(values, "SEVENTH_NAME")\n'
        'on = _flag("EIGHTH_NAME")\nlabel = "NOT_A_SETTING"\nprint("ALSO_NOT_ONE")\n'
    )
    assert env_names.names_in(source) == {
        "FIRST_NAME", "SECOND_NAME", "THIRD_NAME", "FOURTH_NAME", "FIFTH_NAME",
        "SIXTH_NAME", "SEVENTH_NAME", "EIGHTH_NAME",
    }
