"""suggest-rules: counting mail headers into per-address and per-domain totals.

Every address here is made up (acme.example, beta.example and the like).
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "plugin" / "qb-engine" / "skills" / "suggest-rules" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
mc = importlib.import_module("mail_contacts")

ME = "ann@work.example"


def msg(thread, frm, to=(), cc=(), date="2026-11-01T10:00:00Z", labels=("INBOX",)):
    return {"thread_id": thread, "from": frm, "to": list(to), "cc": list(cc), "date": date, "label_ids": list(labels)}


def sent(thread, to, cc=(), date="2026-11-02T10:00:00Z"):
    return msg(thread, f"Ann <{ME}>", to, cc, date, ("SENT",))


def run(messages, **kw):
    return mc.aggregate(messages, account=ME, me=kw.pop("me", ()), days=kw.pop("days", 90), **kw)


def by(rows, key):
    return {r[key]: r for r in rows}


@pytest.mark.parametrize("raw, out", [
    ("Bob Smith <Bob@Acme.example>", ["bob@acme.example"]),
    ('"Smith, Bob" <bob@acme.example>, carol@beta.example', ["bob@acme.example", "carol@beta.example"]),
    (["Bob <bob@acme.example>", "not an address"], ["bob@acme.example"]),
    ("", []),
    (None, []),
])
def test_addresses_are_parsed_lower_case_without_names(raw, out):
    assert mc.addresses(raw) == out


def test_sent_mail_counts_per_recipient_and_per_domain():
    out = run([
        sent("t1", ["Bob <bob@acme.example>"], ["carol@acme.example"]),
        sent("t2", ["bob@acme.example"]),
        sent("t3", ["dave@beta.example"]),
    ])
    people = by(out["addresses"], "address")
    assert people["bob@acme.example"]["sent_to"] == 2
    assert people["carol@acme.example"]["sent_to"] == 1
    assert people["bob@acme.example"]["threads"] == 2
    domains = by(out["domains"], "domain")
    assert domains["acme.example"]["sent_to"] == 3
    assert domains["acme.example"]["people"] == 2
    assert domains["beta.example"]["sent_to"] == 1
    assert out["messages_read"] == 3


def test_received_mail_and_replies():
    out = run([
        msg("t1", "bob@acme.example", [ME], date="2026-11-01T09:00:00Z"),
        sent("t1", ["bob@acme.example"], date="2026-11-01T10:00:00Z"),
        msg("t2", "bob@acme.example", [ME], date="2026-11-05T09:00:00Z"),
        msg("t3", "erin@gamma.example", [ME]),
    ])
    bob = by(out["addresses"], "address")["bob@acme.example"]
    assert bob["received_from"] == 2
    assert bob["replied"] == 1
    assert bob["threads"] == 2
    assert bob["last_seen"] == "2026-11-05T09:00:00Z"
    erin = by(out["addresses"], "address")["erin@gamma.example"]
    assert erin["replied"] == 0
    assert by(out["domains"], "domain")["acme.example"]["replied"] == 1


def test_the_owners_own_addresses_are_dropped():
    out = run([
        sent("t1", [ME, "ann.other@home.example", "bob@acme.example"]),
        msg("t2", "ann.other@home.example", [ME]),
    ], me=["Ann.Other@home.example"])
    assert [r["address"] for r in out["addresses"]] == ["bob@acme.example"]
    assert "home.example" not in by(out["domains"], "domain")


@pytest.mark.parametrize("sender", [
    "noreply@acme.example", "no-reply@acme.example", "do-not-reply@acme.example", "donotreply@acme.example",
    "notifications@acme.example", "notification@acme.example", "mailer-daemon@acme.example",
    "newsletter@acme.example", "alerts@acme.example", "bounce-123@acme.example", "noreply-billing@acme.example",
])
def test_bulk_senders_are_dropped(sender):
    out = run([msg("t1", sender, [ME])])
    assert out["addresses"] == [] and out["domains"] == []
    assert out["dropped"]["bulk"] == 1


@pytest.mark.parametrize("label", ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"])
def test_bulk_categories_are_dropped(label):
    out = run([msg("t1", "bob@acme.example", [ME], labels=("INBOX", label))])
    assert out["addresses"] == []
    assert out["dropped"]["category"] == 1


def test_spam_trash_and_drafts_are_dropped():
    out = run([msg("t1", "bob@acme.example", [ME], labels=(lbl,)) for lbl in ("SPAM", "TRASH", "DRAFT")])
    assert out["addresses"] == []


def test_free_mail_is_person_only_never_a_domain():
    out = run([sent("t1", ["pat@gmail.com", "lee@outlook.com", "bob@acme.example"])])
    people = by(out["addresses"], "address")
    assert people["pat@gmail.com"]["free_mail"] is True
    assert people["bob@acme.example"]["free_mail"] is False
    assert set(by(out["domains"], "domain")) == {"acme.example"}


def test_sent_is_known_by_the_sent_label_or_the_from_address():
    out = run([msg("t1", f"Ann <{ME}>", ["bob@acme.example"], labels=())])
    assert by(out["addresses"], "address")["bob@acme.example"]["sent_to"] == 1


def test_ranked_strongest_first_and_capped():
    messages = [sent(f"t{i}", [f"p{i}@acme.example"] * 1) for i in range(5)] + [sent("x", ["top@beta.example"])] * 4
    out = run(messages, max_addresses=3, max_domains=1)
    assert out["addresses"][0]["address"] == "top@beta.example"
    assert len(out["addresses"]) == 3
    assert len(out["domains"]) == 1


def test_output_holds_counts_only_never_names_subjects_or_ids():
    m = msg("thread-secret-id", "Bob Smith <bob@acme.example>", [ME])
    m["subject"] = "Quarterly numbers"
    m["snippet"] = "the text"
    m["message_id"] = "msg-secret-id"
    text = json.dumps(run([m]))
    for leak in ("Bob Smith", "Quarterly", "the text", "thread-secret-id", "msg-secret-id"):
        assert leak not in text
    assert set(run([m])) == {"account", "days", "messages_read", "addresses", "domains", "dropped"}


def test_mail_header_dates_are_read_too():
    out = run([msg("t1", "bob@acme.example", [ME], date="Sun, 01 Nov 2026 05:00:00 -0500")])
    assert by(out["addresses"], "address")["bob@acme.example"]["last_seen"] == "2026-11-01T10:00:00Z"


def test_bad_dates_do_not_break_the_count():
    out = run([msg("t1", "bob@acme.example", [ME], date="not a date")])
    assert by(out["addresses"], "address")["bob@acme.example"]["last_seen"] is None


def test_cli_reads_jsonl_and_prints_the_report(tmp_path, capsys):
    src = tmp_path / "headers.jsonl"
    src.write_text("\n".join(json.dumps(m) for m in [sent("t1", ["bob@acme.example"]), msg("t2", "bob@acme.example", [ME])]) + "\n\nnot json\n", encoding="utf-8")
    assert mc.main(["aggregate", "--in", str(src), "--account", ME, "--days", "90"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["account"] == ME and out["days"] == 90
    assert out["dropped"]["unreadable"] == 1
    assert by(out["addresses"], "address")["bob@acme.example"]["sent_to"] == 1


def test_cli_refuses_a_bad_account(tmp_path, capsys):
    src = tmp_path / "h.jsonl"
    src.write_text("", encoding="utf-8")
    assert mc.main(["aggregate", "--in", str(src), "--account", "nobody"]) == 2


def test_help_works():
    assert mc.main(["aggregate", "--help"]) == 0


# ── choose: the person's answers become `chosen` on the report ───────────────

def _report():
    return run([sent("t1", ["bob@acme.example"]), sent("t2", ["carol@beta.example"]), msg("t3", "pat@gmail.com", [ME])])


def test_choose_marks_picked_domains_and_people_and_unmarks_the_rest():
    out = mc.choose(_report(), ["acme.example", "pat@gmail.com"])
    assert by(out["domains"], "domain")["acme.example"]["chosen"] is True
    assert by(out["domains"], "domain")["beta.example"]["chosen"] is False
    assert by(out["addresses"], "address")["pat@gmail.com"]["chosen"] is True
    assert by(out["addresses"], "address")["bob@acme.example"]["chosen"] is False


def test_choose_is_case_and_at_sign_tolerant_and_does_not_change_its_input():
    report = _report()
    out = mc.choose(report, [" @ACME.example ", "Carol@Beta.Example"])
    assert by(out["domains"], "domain")["acme.example"]["chosen"] is True
    assert by(out["addresses"], "address")["carol@beta.example"]["chosen"] is True
    assert "chosen" not in report["domains"][0]


def test_choose_refuses_a_value_not_in_the_report():
    with pytest.raises(ValueError, match="nobody@else.example"):
        mc.choose(_report(), ["nobody@else.example"])


def test_choose_with_nothing_picked_leaves_every_box_unticked():
    out = mc.choose(_report(), [])
    assert all(r["chosen"] is False for r in out["addresses"] + out["domains"])


def test_cli_choose_reads_the_report_and_prints_it_with_choices(tmp_path, capsys):
    src = tmp_path / "report.json"
    src.write_text(json.dumps(_report()), encoding="utf-8")
    assert mc.main(["choose", "--report", str(src), "--pick", "acme.example", "--pick", "pat@gmail.com"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert by(out["domains"], "domain")["acme.example"]["chosen"] is True


def test_cli_choose_refuses_an_unknown_pick(tmp_path, capsys):
    src = tmp_path / "report.json"
    src.write_text(json.dumps(_report()), encoding="utf-8")
    assert mc.main(["choose", "--report", str(src), "--pick", "zzz.example"]) == 2
    assert "zzz.example" in capsys.readouterr().err
