"""Migration planning, adopt, dry-run -- against a fake database."""

from __future__ import annotations

import pytest

from kbe import db, migrations as mig
from kbe.errors import KbeError, UsageError


class FakeExecutor:
    """Remembers what it was asked to do; optionally fails on one file."""

    def __init__(self, applied=None, exists=None, fail_on=None, schema="workspace",
                 recorded=(), has_schema=True, unusable=None):
        self.rows = dict(applied or {})
        self.exists = bool(applied) if exists is None else exists
        self.fail_on = fail_on
        self.schema = schema
        self.recorded = tuple(recorded)
        self.has_schema = has_schema
        self.unusable = unusable
        self.calls = []

    def schema_exists(self):
        return self.has_schema

    def recorded_schemas(self):
        return self.recorded

    def prepare(self, migrations):
        for item in migrations:
            if item.filename == self.unusable:
                raise KbeError(f"{item.filename} cannot be applied.")

    def tracking_exists(self):
        return self.exists

    def applied(self):
        assert self.exists, "must not read a table that is not there"
        return dict(self.rows)

    def ensure_tracking(self):
        self.calls.append("ensure")
        self.exists = True

    def apply(self, migration):
        if migration.filename == self.fail_on:
            raise KbeError(f"{migration.filename} failed and was rolled back.")
        self.calls.append(f"apply {migration.filename}")
        self.rows[migration.filename] = migration.checksum

    def record(self, migrations):
        for item in migrations:
            self.calls.append(f"record {item.filename}")
            self.rows[item.filename] = item.checksum


@pytest.fixture
def folder(tmp_path):
    for name in ("0002_second.sql", "0000_prelude.sql", "0010_tenth.sql", "0001_first.sql"):
        (tmp_path / name).write_text(f"-- {name}\nselect 1;\n")
    return tmp_path


def _lines():
    seen = []
    return seen, seen.append


def test_discover_sorts_by_filename_and_checksums(folder):
    found = mig.discover(folder)
    assert [m.filename for m in found] == [
        "0000_prelude.sql", "0001_first.sql", "0002_second.sql", "0010_tenth.sql",
    ]
    assert [m.number for m in found] == [0, 1, 2, 10]
    assert all(len(m.checksum) == 64 for m in found)
    assert len({m.checksum for m in found}) == 4


def test_discover_rejects_bad_names_and_repeated_numbers(folder, tmp_path):
    (folder / "notes.sql").write_text("select 1;")
    with pytest.raises(KbeError, match="notes.sql"):
        mig.discover(folder)
    (folder / "notes.sql").unlink()
    (folder / "0002_again.sql").write_text("select 1;")
    with pytest.raises(KbeError, match="share a number: 0002"):
        mig.discover(folder)
    with pytest.raises(KbeError, match="No migrations folder"):
        mig.discover(tmp_path / "absent")


def test_migrate_from_empty_applies_everything_in_order(folder):
    fake = FakeExecutor()
    seen, out = _lines()
    assert db.migrate(fake, mig.discover(folder), out) == 0
    assert fake.calls == [
        "ensure",
        "apply 0000_prelude.sql", "apply 0001_first.sql",
        "apply 0002_second.sql", "apply 0010_tenth.sql",
    ]
    assert seen[-1] == "Applied 4 migration(s)."


def test_migrate_twice_is_a_no_op(folder):
    fake = FakeExecutor()
    found = mig.discover(folder)
    db.migrate(fake, found, lambda _: None)
    fake.calls.clear()
    seen, out = _lines()
    assert db.migrate(fake, found, out) == 0
    assert fake.calls == []
    assert seen == ["Nothing to apply: the database is up to date."]


def test_migrate_only_runs_what_is_pending(folder):
    found = mig.discover(folder)
    fake = FakeExecutor({m.filename: m.checksum for m in found[:2]})
    db.migrate(fake, found, lambda _: None)
    assert fake.calls == ["ensure", "apply 0002_second.sql", "apply 0010_tenth.sql"]


def test_migrate_stops_at_the_first_failure(folder):
    fake = FakeExecutor(fail_on="0002_second.sql")
    with pytest.raises(KbeError, match="0002_second.sql failed"):
        db.migrate(fake, mig.discover(folder), lambda _: None)
    assert fake.calls == ["ensure", "apply 0000_prelude.sql", "apply 0001_first.sql"]
    assert "0010_tenth.sql" not in fake.rows


def test_changed_checksum_refuses_and_runs_nothing(folder):
    found = mig.discover(folder)
    fake = FakeExecutor({found[0].filename: found[0].checksum, found[1].filename: "old"})
    with pytest.raises(KbeError) as caught:
        db.migrate(fake, found, lambda _: None)
    message = str(caught.value)
    assert "0001_first.sql" in message
    assert "--accept-changed 0001_first.sql" in message
    assert fake.calls == []


def test_changed_checksum_refuses_even_in_dry_run(folder):
    found = mig.discover(folder)
    fake = FakeExecutor({found[0].filename: "old"})
    with pytest.raises(KbeError, match="changed since"):
        db.migrate(fake, found, lambda _: None, dry_run=True)


def test_accept_changed_updates_the_checksum_without_re_running(folder):
    found = mig.discover(folder)
    fake = FakeExecutor({m.filename: m.checksum for m in found} | {"0001_first.sql": "old"})
    seen, out = _lines()
    db.migrate(fake, found, out, accept_changed=["0001_first.sql"])
    assert fake.calls == ["ensure", "record 0001_first.sql"]
    assert fake.rows["0001_first.sql"] == found[1].checksum
    assert "will accept the new content of 0001_first.sql (not re-run)" in seen


def test_accept_changed_covers_only_the_named_file(folder):
    found = mig.discover(folder)
    fake = FakeExecutor({"0001_first.sql": "old", "0002_second.sql": "old"})
    with pytest.raises(KbeError) as caught:
        db.migrate(fake, found, lambda _: None, accept_changed=["0001_first.sql"])
    assert "0002_second.sql" in str(caught.value)
    assert "  0001_first.sql" not in str(caught.value)
    assert fake.calls == []


def test_accept_changed_must_name_a_real_file(folder):
    with pytest.raises(UsageError, match="does not exist: 0099_typo.sql"):
        db.migrate(FakeExecutor(), mig.discover(folder), lambda _: None,
                   accept_changed=["0099_typo.sql"])


def test_dry_run_lists_and_changes_nothing(folder):
    found = mig.discover(folder)
    fake = FakeExecutor({found[0].filename: found[0].checksum})
    seen, out = _lines()
    assert db.migrate(fake, found, out, dry_run=True) == 0
    assert fake.calls == []
    assert seen == [
        "would apply 0001_first.sql", "would apply 0002_second.sql",
        "would apply 0010_tenth.sql", "Dry run: 3 to apply, nothing was changed.",
    ]


def test_dry_run_on_a_database_with_no_tracking_table(folder):
    fake = FakeExecutor(exists=False)
    seen, out = _lines()
    db.migrate(fake, mig.discover(folder), out, dry_run=True)
    assert fake.calls == [] and not fake.exists
    assert seen[-1] == "Dry run: 4 to apply, nothing was changed."


def test_notes_for_missing_files_and_out_of_order(folder):
    found = mig.discover(folder)
    fake = FakeExecutor({"0010_tenth.sql": found[3].checksum, "0005_gone.sql": "x"})
    seen, out = _lines()
    db.migrate(fake, found, out, dry_run=True)
    assert "note: 0005_gone.sql is recorded in the database but is not a file here" in seen
    assert "note: 0002_second.sql is numbered below a migration already applied" in seen


def test_adopt_records_through_the_number_without_running(folder):
    fake = FakeExecutor(exists=False)
    seen, out = _lines()
    assert db.adopt(fake, mig.discover(folder), out, through=2) == 0
    assert fake.calls == [
        "ensure", "record 0000_prelude.sql", "record 0001_first.sql", "record 0002_second.sql",
    ]
    assert "0010_tenth.sql" not in fake.rows
    assert "None were run" in seen[-1]


def test_adopt_then_migrate_runs_only_the_rest(folder):
    fake = FakeExecutor(exists=False)
    found = mig.discover(folder)
    db.adopt(fake, found, lambda _: None, through=2)
    fake.calls.clear()
    db.migrate(fake, found, lambda _: None)
    assert fake.calls == ["ensure", "apply 0010_tenth.sql"]


def test_adopt_refuses_when_rows_exist_unless_forced(folder):
    found = mig.discover(folder)
    fake = FakeExecutor({"0000_prelude.sql": found[0].checksum})
    with pytest.raises(KbeError, match="already has 1 recorded"):
        db.adopt(fake, found, lambda _: None, through=2)
    assert fake.calls == []
    db.adopt(fake, found, lambda _: None, through=2, force=True)
    assert fake.calls[0] == "ensure" and len(fake.calls) == 4


def test_adopt_with_an_empty_tracking_table_is_allowed(folder):
    fake = FakeExecutor(exists=True)
    db.adopt(fake, mig.discover(folder), lambda _: None, through=1)
    assert sorted(fake.rows) == ["0000_prelude.sql", "0001_first.sql"]


def test_adopt_dry_run_and_bad_numbers(folder):
    fake = FakeExecutor(exists=False)
    seen, out = _lines()
    db.adopt(fake, mig.discover(folder), out, through=1, dry_run=True)
    assert fake.calls == []
    assert seen[-1] == "Dry run: 2 to record, nothing was changed."
    with pytest.raises(UsageError, match="no migration numbered 0007"):
        db.adopt(fake, mig.discover(folder), out, through=7)
    with pytest.raises(UsageError, match="not a migration number"):
        mig.parse_number("twenty")
    assert mig.parse_number("0028") == 28


def test_project_ref_order_and_validation():
    ref = "abcdefghijklmnopqrst"
    answers = {"answers": {"supabase_project_ref": "stateref0123456789ab"}}
    values = {"SUPABASE_URL": f"https://{ref}.supabase.co"}
    assert db.project_ref("flagref0123456789abc", answers, values) == "flagref0123456789abc"
    assert db.project_ref(None, answers, values) == "stateref0123456789ab"
    assert db.project_ref(None, {}, values) == ref
    assert db.project_ref(None, {}, {"SUPABASE_PROJECT_REF": ref}) == ref
    with pytest.raises(KbeError, match="No Supabase project ref"):
        db.project_ref(None, {}, {"SUPABASE_URL": "https://db.example.com"})
    with pytest.raises(UsageError):
        db.project_ref("not a ref; rm", {}, {})


# --- the schema a database belongs to ---------------------------------------


def test_migrate_refuses_a_database_built_in_another_schema(folder):
    executor = FakeExecutor(schema="kb_acme", recorded=("workspace",))
    seen, out = _lines()
    with pytest.raises(KbeError, match='holds an Engine in the schema "workspace"'):
        db.migrate(executor, mig.discover(folder), out)
    with pytest.raises(KbeError, match="KB_SCHEMA=workspace"):
        db.migrate(executor, mig.discover(folder), out, dry_run=True)
    assert executor.calls == []


def test_migrate_runs_when_the_recorded_schema_matches(folder):
    executor = FakeExecutor(schema="kb_acme", recorded=("kb_acme",))
    seen, out = _lines()
    assert db.migrate(executor, mig.discover(folder), out) == 0
    assert seen[-1] == "Applied 4 migration(s)."


def test_migrate_checks_every_file_before_running_any(folder):
    executor = FakeExecutor(schema="kb_acme", unusable="0010_tenth.sql")
    seen, out = _lines()
    with pytest.raises(KbeError, match="0010_tenth.sql cannot be applied"):
        db.migrate(executor, mig.discover(folder), out)
    assert executor.calls == []


def test_adopt_refuses_another_schema_and_a_missing_schema(folder):
    seen, out = _lines()
    other = FakeExecutor(schema="kb_acme", recorded=("workspace",))
    with pytest.raises(KbeError, match="holds an Engine in the schema"):
        db.adopt(other, mig.discover(folder), out, through=1)
    absent = FakeExecutor(schema="kb_acme", has_schema=False)
    with pytest.raises(KbeError, match='no schema "kb_acme"'):
        db.adopt(absent, mig.discover(folder), out, through=1)
    assert other.calls == [] and absent.calls == []


def test_adopt_still_works_for_a_default_schema_database(folder):
    executor = FakeExecutor()
    seen, out = _lines()
    assert db.adopt(executor, mig.discover(folder), out, through=1) == 0
    assert executor.calls == ["ensure", "record 0000_prelude.sql", "record 0001_first.sql"]


# ── reworded files (comment-only edits, e.g. for the public release) ────────


def _reworded(folder, files):
    import json

    (folder / "reworded.json").write_text(json.dumps({"files": files}), encoding="utf-8")


def test_a_reworded_file_still_matches_its_earlier_checksum(folder):
    _reworded(folder, {"0001_first.sql": ["old"]})
    found = mig.discover(folder)
    assert found[1].earlier == ("old",)
    fake = FakeExecutor({m.filename: m.checksum for m in found} | {"0001_first.sql": "old"})
    db.migrate(fake, found, lambda _: None)
    assert not [c for c in fake.calls if c.startswith(("apply", "record"))]


def test_an_earlier_checksum_covers_only_its_own_file(folder):
    _reworded(folder, {"0001_first.sql": ["old"]})
    found = mig.discover(folder)
    fake = FakeExecutor({m.filename: m.checksum for m in found} | {"0002_second.sql": "old"})
    with pytest.raises(KbeError, match="0002_second.sql"):
        db.migrate(fake, found, lambda _: None)


def test_reworded_must_name_real_files(folder):
    _reworded(folder, {"0099_gone.sql": ["old"]})
    with pytest.raises(KbeError, match="0099_gone.sql"):
        mig.discover(folder)


def test_the_repository_reworded_list_is_sound():
    from pathlib import Path

    folder = Path(__file__).resolve().parents[3] / "supabase" / "migrations"
    found = mig.discover(folder)
    reworded = [m for m in found if m.earlier]
    assert reworded, "the repository lists its reworded files"
    for m in reworded:
        assert m.checksum not in m.earlier
        assert all(len(c) == 64 for c in m.earlier)
