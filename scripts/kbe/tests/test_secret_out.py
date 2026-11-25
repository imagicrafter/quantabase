"""A new secret goes to the clipboard, a 0600 file or (only when asked) the screen."""

from __future__ import annotations

import argparse
import stat

import pytest

from kbe import proc, secret_out
from kbe.errors import KbeError, UsageError
from kbe.tests.helpers import FakeRunner, make_context

SECRET = "not-a-real-secret-0123456789"


def _args(*argv, show=True):
    parser = argparse.ArgumentParser()
    secret_out.add_flags(parser, what="setup code", show=show)
    return parser.parse_args(list(argv))


def test_no_flag_refuses_and_names_the_three_choices():
    with pytest.raises(UsageError) as caught:
        secret_out.choose(_args(), what="setup code")
    message = str(caught.value)
    assert all(flag in message for flag in ("--clipboard", "--out FILE", "--show"))


def test_the_flags_exclude_each_other():
    with pytest.raises(SystemExit):
        _args("--clipboard", "--show")


def test_show_can_be_left_out_of_a_command():
    with pytest.raises(SystemExit):
        _args("--show", show=False)


def test_clipboard_sends_the_value_on_stdin_and_prints_no_secret(tmp_path):
    runner = FakeRunner()
    ctx, seen = make_context(tmp_path, runner)
    lines = secret_out.choose(_args("--clipboard"), what="x").send(ctx, {"SETUP_CODE": SECRET})
    assert runner.calls[0]["stdin"] == SECRET
    assert SECRET not in " ".join(runner.calls[0]["argv"])
    assert SECRET not in "\n".join([*lines, *seen]) and "SETUP_CODE" in lines[0]


def test_clipboard_without_a_tool_fails_plainly(tmp_path):
    missing = proc.ProcResult(proc.NOT_FOUND, "", "")
    runner = FakeRunner({"pbcopy": missing, "wl-copy": missing, "xclip": missing, "clip": missing})
    ctx, _seen = make_context(tmp_path, runner)
    with pytest.raises(KbeError, match="--out FILE"):
        secret_out.Delivery(secret_out.CLIPBOARD).send(ctx, {"A": SECRET})


def test_out_writes_a_new_owner_only_file(tmp_path):
    ctx, seen = make_context(tmp_path)
    target = tmp_path / "code.txt"
    lines = secret_out.choose(_args("--out", str(target)), what="x").send(ctx, {"SETUP_CODE": SECRET})
    assert target.read_text() == f"SETUP_CODE={SECRET}\n"
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert SECRET not in "\n".join([*lines, *seen])


def test_out_refuses_an_existing_file_before_anything_is_made(tmp_path):
    target = tmp_path / "code.txt"
    target.write_text("keep")
    with pytest.raises(UsageError, match="already exists"):
        secret_out.choose(_args("--out", str(target)), what="x")
    assert target.read_text() == "keep"


def test_out_refuses_a_missing_folder(tmp_path):
    with pytest.raises(UsageError, match="does not exist"):
        secret_out.choose(_args("--out", str(tmp_path / "nope" / "code.txt")), what="x")


def test_out_refuses_a_dangling_link_before_anything_is_made(tmp_path):
    target = tmp_path / "code.txt"
    target.symlink_to(tmp_path / "not-there")
    with pytest.raises(UsageError, match="already exists"):
        secret_out.choose(_args("--out", str(target)), what="x")


def test_a_failed_write_is_a_plain_error_and_leaves_no_part_file(tmp_path, monkeypatch):
    from kbe import sources_drive

    class Broken:
        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def write(self, _text):
            raise OSError(28, "No space left on device")

    monkeypatch.setattr(sources_drive.os, "fdopen", lambda fd, *a, **k: (sources_drive.os.close(fd), Broken())[1])
    target = tmp_path / "code.txt"
    with pytest.raises(KbeError) as caught:
        sources_drive.to_file(target, {"A": SECRET})
    assert SECRET not in str(caught.value) and not target.exists()


def test_show_refuses_when_no_person_is_at_the_terminal(tmp_path, monkeypatch):
    monkeypatch.setattr(secret_out, "_at_a_terminal", lambda: False)
    with pytest.raises(UsageError, match="--clipboard or --out FILE"):
        secret_out.choose(_args("--show"), what="x")


def test_show_calls_the_printer_and_only_then(tmp_path, monkeypatch):
    monkeypatch.setattr(secret_out, "_at_a_terminal", lambda: True)
    ctx, seen = make_context(tmp_path)
    secret_out.choose(_args("--show"), what="x").send(
        ctx, {"A": SECRET}, show=lambda c: c.out(f"shown {SECRET}"))
    assert seen == [f"shown {SECRET}"]
