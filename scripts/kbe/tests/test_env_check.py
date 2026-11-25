"""`kbe env check`: the shape of each line of the local env file, never a value."""

from __future__ import annotations

from pathlib import Path

import pytest

from kbe import cli, env_check, secrets
from kbe.errors import KbeError
from kbe.tests.helpers import make_context

ROOT = Path(__file__).resolve().parents[3]
EXAMPLE_NAME = ".env" + ".example"
EXAMPLE = (ROOT / EXAMPLE_NAME).read_text(encoding="utf-8")
URL = "https://fixture-project.supabase.co"
DB = "postgresql://postgres:fixture-password-0123@db.fixture-project.supabase.co:5432/postgres"
SECRET = "fixture-secret-value-0123456789"
GOOD = {
    "SUPABASE_URL": URL, "SUPABASE_ANON_KEY": SECRET, "SUPABASE_JWT_SECRET": SECRET + "-jwt",
    "KBE_DATABASE_URL": DB, "KNOWLEDGE_EMBED_URL": URL + "/functions/v1/embed",
}


def _run(tmp_path, local, example=EXAMPLE):
    ctx, seen = make_context(tmp_path)
    if example is not None:
        (tmp_path / EXAMPLE_NAME).write_text(example, encoding="utf-8")
    ctx.env_file.write_text("".join(f"{k}={v}\n" for k, v in local.items()), encoding="utf-8")
    code = cli.main(["env", "check"], ctx)
    return code, seen


def _line(seen, name):
    found = [line for line in seen if line.split()[:1] == [name]]
    assert len(found) == 1, f"{name}: {found}"
    return found[0]


def _no_values(seen, local):
    text = "\n".join(seen)
    for value in local.values():
        if len(value) > 5:
            assert value not in text
            assert value.strip("<>") not in text
    assert "chars" not in text


# --- one value (no I/O) -----------------------------------------------------------


@pytest.mark.parametrize("value, example, expected", [
    (SECRET, "<your-anon-key>", env_check.SET),
    ("", "<your-anon-key>", env_check.EMPTY),
    (None, "<your-anon-key>", env_check.EMPTY),
    ("<your-anon-key>", "<your-anon-key>", env_check.PLACEHOLDER),
    (" <your-anon-key> ", "<your-anon-key>", env_check.PLACEHOLDER),
    (f"<{SECRET}>", "<your-anon-key>", env_check.WRAPPED),
    (f"<{SECRET}>", None, env_check.WRAPPED),
    ("<pass<word>", "<your-anon-key>", env_check.WRAPPED),
    ("x<y>z", "<your-anon-key>", env_check.SET),
])
def test_the_status_of_one_value(value, example, expected):
    assert env_check.status(value, example) == expected


def test_every_name_in_the_example_has_one_place_in_the_table():
    example = env_check.read(ROOT / EXAMPLE_NAME)
    assert {"SUPABASE_URL", "SUPABASE_JWT_SECRET", "KBE_DATABASE_URL"} <= set(example)
    for name in example:
        assert env_check.when(name)[0] in (env_check.NOW, env_check.LATER, env_check.OPTIONAL)
    assert env_check.when("KBE_DATABASE_URL")[0] == env_check.NOW
    assert env_check.when("GITHUB_TOKEN")[0] == env_check.LATER
    assert env_check.when("KNOWLEDGE_TOKEN_JANE_DOE")[0] == env_check.LATER
    assert env_check.when("SUPABASE_ACCESS_TOKEN")[0] == env_check.OPTIONAL
    assert env_check.when("SOMETHING_ELSE")[0] == env_check.OPTIONAL
    # The table names nothing the example file does not have.
    assert set(env_check.WHEN) <= set(example)


# --- the command ------------------------------------------------------------------


def test_a_filled_in_file_passes_and_shows_no_value(tmp_path):
    local = {**GOOD, "GITHUB_TOKEN": "", "DO_INFERENCE_KEY": "<your-inference-key>"}
    code, seen = _run(tmp_path, local)
    assert code == 0
    _no_values(seen, local)
    assert _line(seen, "SUPABASE_URL").endswith("set")
    assert "empty" in _line(seen, "GITHUB_TOKEN")
    assert "still the example placeholder" in _line(seen, "DO_INFERENCE_KEY")
    text = "\n".join(seen)
    now, later, optional = (text.index(title) for title in (
        "Needed now", "Filled in by a later step", "Optional"))
    assert now < text.index("KBE_DATABASE_URL") < later < text.index("GITHUB_TOKEN") < optional


def test_each_shape_is_named_and_a_wrapped_value_fails(tmp_path):
    local = {**GOOD, "SUPABASE_ANON_KEY": f"<{SECRET}>", "SUPABASE_JWT_SECRET": "<your-jwt-secret>",
             "KBE_DATABASE_URL": "", "FIREFLIES_API_KEY": f"<{SECRET}-ff>"}
    code, seen = _run(tmp_path, local)
    assert code == 1
    _no_values(seen, local)
    assert "wrapped in <...> (remove the brackets)" in _line(seen, "SUPABASE_ANON_KEY")
    assert "still the example placeholder" in _line(seen, "SUPABASE_JWT_SECRET")
    assert "empty" in _line(seen, "KBE_DATABASE_URL")
    assert "wrapped in <...> (remove the brackets)" in _line(seen, "FIREFLIES_API_KEY")
    fix = "\n".join(seen).split("To fix")[1]
    for name in ("SUPABASE_ANON_KEY", "SUPABASE_JWT_SECRET", "KBE_DATABASE_URL", "FIREFLIES_API_KEY"):
        assert name in fix
    assert "SUPABASE_URL" not in fix


def test_a_name_missing_from_the_file_is_listed(tmp_path):
    local = {name: value for name, value in GOOD.items() if name != "SUPABASE_JWT_SECRET"}
    code, seen = _run(tmp_path, local)
    assert code == 1
    assert "not in the file" in _line(seen, "SUPABASE_JWT_SECRET")
    assert "not in the file" in _line(seen, "GITHUB_TOKEN")  # a later step: listed, not a failure
    assert "GITHUB_TOKEN" not in "\n".join(seen).split("To fix")[1]


def test_a_name_the_example_does_not_have_is_still_reported(tmp_path):
    local = {**GOOD, "MY_OWN_SETTING": SECRET, "KNOWLEDGE_TOKEN_JANE": f"<{SECRET}>"}
    code, seen = _run(tmp_path, local)
    assert code == 1
    assert _line(seen, "MY_OWN_SETTING").endswith("set")
    assert "wrapped" in _line(seen, "KNOWLEDGE_TOKEN_JANE")
    _no_values(seen, local)


def test_shape_hints_show_no_value(tmp_path):
    local = {**GOOD, "SUPABASE_ACCESS_TOKEN": SECRET, "KBE_DATABASE_URL": URL,
             "KNOWLEDGE_EMBED_URL": "fixture-project.supabase.co/functions/v1/embed"}
    code, seen = _run(tmp_path, local)
    assert code == 1  # a needed-now value with the wrong shape
    _no_values(seen, local)
    assert "does not start with sbp_" in _line(seen, "SUPABASE_ACCESS_TOKEN")
    assert "does not start with postgres" in _line(seen, "KBE_DATABASE_URL")
    assert "does not start with http" in _line(seen, "KNOWLEDGE_EMBED_URL")
    assert "does not start" not in _line(seen, "SUPABASE_URL")


def test_an_optional_shape_hint_alone_does_not_fail(tmp_path):
    code, seen = _run(tmp_path, {**GOOD, "SUPABASE_ACCESS_TOKEN": SECRET})
    assert code == 0 and "does not start with sbp_" in _line(seen, "SUPABASE_ACCESS_TOKEN")
    code, seen = _run(tmp_path, {**GOOD, "SUPABASE_ACCESS_TOKEN": "sbp_" + SECRET})
    assert code == 0 and _line(seen, "SUPABASE_ACCESS_TOKEN").endswith("set")


def test_without_an_example_file_it_still_reports(tmp_path):
    code, seen = _run(tmp_path, {**GOOD, "GITHUB_TOKEN": "<your-github-token>"}, example=None)
    assert code == 1 and "wrapped in <...>" in _line(seen, "GITHUB_TOKEN")


def test_a_missing_env_file_is_an_error(tmp_path, capsys):
    ctx, _seen = make_context(tmp_path)
    assert cli.main(["env", "check"], ctx) == 1
    assert "No local env file" in capsys.readouterr().err


# --- the message every other command gives ------------------------------------------


def test_the_missing_value_error_says_what_wrapped_means(tmp_path):
    path = tmp_path / "local.env"
    path.write_text(f"SUPABASE_URL=<{URL}>\n", encoding="utf-8")
    values = secrets.load(path)
    with pytest.raises(KbeError) as caught:
        secrets.require(values, "SUPABASE_URL", "OTHER")
    message = str(caught.value)
    assert "SUPABASE_URL (still the example placeholder)" in message
    assert "A value wrapped in <...> counts as not filled in; remove the brackets." in message
    assert URL not in message
    with pytest.raises(KbeError) as caught:
        secrets.require(values, "OTHER")
    assert "wrapped" not in str(caught.value)
