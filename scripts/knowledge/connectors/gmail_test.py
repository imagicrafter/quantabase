"""The Gmail connector: only labelled threads, topics from the label, an owner.

Every test runs against a stand-in for the Gmail API (gmail_fake.py). Nothing
here touches the network.
"""

from __future__ import annotations

import dataclasses

import pytest

from knowledge.connectors import gmail
from knowledge.connectors.gmail_fake import FakeGmail, message, service, text_part
from knowledge.engine_config_gmail import Mailbox

OWNER = "owner@example.com"
MAILBOX = Mailbox(email=OWNER, owner_email=OWNER)

LABELS = [
    {"id": "INBOX", "name": "INBOX", "type": "system"},
    {"id": "L1", "name": "kx/consulting", "type": "user"},
    {"id": "L2", "name": "KX/Properties", "type": "user"},
    {"id": "L3", "name": "kx/nonsense", "type": "user"},
    {"id": "L4", "name": "clients/acme", "type": "user"},
    {"id": "L5", "name": "share-private", "type": "user"},
]


def _fake(threads: dict, labels=None, **kwargs) -> FakeGmail:
    return FakeGmail(email=OWNER, labels=LABELS if labels is None else labels,
                     threads=threads, **kwargs)


def _gmail_source(config, **changes):
    updated = dataclasses.replace(config.sources.gmail, **changes)
    return dataclasses.replace(
        config, sources=dataclasses.replace(config.sources, gmail=updated)
    )


def _collect(fake: FakeGmail, config, mailbox: Mailbox = MAILBOX):
    return gmail.collect(service(fake), config, mailbox)


# --- which labels are tags ----------------------------------------------------


def test_tag_labels_are_user_labels_that_start_with_the_prefix(example_config):
    assert gmail.tag_labels(LABELS, "kx/") == {
        "L1": "kx/consulting", "L2": "KX/Properties", "L3": "kx/nonsense",
    }
    assert gmail.tag_labels(LABELS, "share-") == {"L5": "share-private"}


def test_a_system_label_is_never_a_tag_whatever_the_prefix():
    labels = [
        {"id": "CATEGORY_SOCIAL", "name": "CATEGORY_SOCIAL", "type": "system"},
        {"id": "L9", "name": "CATEGORY_consulting", "type": "user"},
        {"id": "L8", "name": "CATEGORY_x"},  # no type: not trusted to be a user label
    ]
    assert gmail.tag_labels(labels, "CATEGORY_") == {"L9": "CATEGORY_consulting"}


@pytest.mark.parametrize("bad", [None, "kx/consulting", [None, 3, {"id": "", "name": "kx/a"}],
                                 [{"id": "L1"}, {"name": "kx/a", "type": "user"}]])
def test_tag_labels_ignores_anything_that_is_not_a_label(bad):
    assert gmail.tag_labels(bad, "kx/") == {}


def test_the_prefix_comes_from_the_source_or_the_general_one(example_config):
    assert gmail.tag_prefix(example_config) == "kx/"
    assert gmail.tag_prefix(_gmail_source(example_config, prefix="share-")) == "share-"
    general = dataclasses.replace(
        example_config, tagging=dataclasses.replace(example_config.tagging, prefix="team:")
    )
    assert gmail.tag_prefix(general) == "team:"


# --- which threads are read ---------------------------------------------------


def test_only_labelled_threads_are_listed_and_fetched(example_config):
    fake = _fake({
        "t1": [message("m1", ["INBOX", "L1"])],
        "t2": [message("m2", ["INBOX"])],
        "t3": [message("m3", ["L4"])],
        "t4": [message("m4", ["INBOX", "L2"])],
    })
    documents, result = _collect(fake, example_config)

    assert sorted(d.external_id for d in documents) == ["t1", "t4"]
    assert fake.fetched() == ["t1", "t4"], "an unlabelled thread must never be fetched"
    lists = [c[1] for c in fake.calls if c[0] == "list"]
    assert lists and all(len(c.get("labelIds") or []) == 1 for c in lists)
    assert all("q" not in c for c in lists), "threads are found by label id, never by search"
    assert {c["labelIds"][0] for c in lists} == {"L1", "L2", "L3"}
    assert result.threads_listed == 2 and result.documents == 2


def test_no_tag_label_means_nothing_is_listed_at_all(example_config):
    fake = _fake({"t1": [message("m1", ["INBOX"])]}, labels=LABELS[:1] + LABELS[4:])
    documents, result = _collect(fake, example_config)
    assert documents == [] and result.threads_listed == 0
    assert [c[0] for c in fake.calls] == ["profile", "labels"]


def test_every_page_of_a_label_is_read(example_config):
    threads = {f"t{i}": [message(f"m{i}", ["L1"])] for i in range(5)}
    documents, _ = _collect(_fake(threads, page_size=2), example_config)
    assert len(documents) == 5


def test_a_custom_prefix_selects_other_labels(example_config):
    config = _gmail_source(example_config, prefix="share-")
    fake = _fake({
        "t1": [message("m1", ["L1"])],
        "t5": [message("m5", ["L5"])],
    })
    documents, _ = _collect(fake, config)
    assert [(d.external_id, d.domains) for d in documents] == [("t5", ("private",))]
    assert fake.fetched() == ["t5"]


# --- topics -------------------------------------------------------------------


def test_the_label_sets_the_topic(example_config):
    fake = _fake({"t1": [message("m1", ["INBOX", "L1"])]})
    (doc,), _ = _collect(fake, example_config)
    assert doc.domains == ("consulting",)
    assert (doc.tag_source, doc.tag_signals) == ("content", ("consulting",))
    assert doc.metadata["labels"] == ["kx/consulting"]


def test_label_names_match_whatever_their_case(example_config):
    fake = _fake({"t4": [message("m4", ["L2"])]})
    (doc,), _ = _collect(fake, example_config)
    assert doc.domains == ("properties",)


def test_two_labels_give_two_topics(example_config):
    fake = _fake({"t1": [message("m1", ["L1"]), message("m2", ["L2"])]})
    (doc,), _ = _collect(fake, example_config)
    assert doc.domains == ("consulting", "properties")


def test_a_label_for_an_unknown_topic_is_unclassified(example_config):
    fake = _fake({"t1": [message("m1", ["L3"])], "t2": [message("m2", ["L1", "L3"])]})
    documents, _ = _collect(fake, example_config)
    for doc in documents:
        assert doc.domains == ("unclassified",)
        assert doc.tag_source == "content"
        assert doc.tag_signals[0] == "unknown_tag"
        assert "unknown_tag:nonsense" in doc.tag_signals


def test_a_nested_label_does_not_borrow_its_parents_topic(example_config):
    labels = LABELS + [{"id": "L6", "name": "kx/consulting/2026", "type": "user"}]
    fake = _fake({"t1": [message("m1", ["L6"])]}, labels=labels)
    (doc,), _ = _collect(fake, example_config)
    assert doc.domains == ("unclassified",)
    assert doc.tag_signals[0] == "unknown_tag"


def test_the_subject_and_body_never_set_a_topic(example_config):
    fake = _fake({"t1": [message("m1", ["L3"], subject="kx/consulting properties",
                                 body="kx/private consulting")]})
    (doc,), _ = _collect(fake, example_config)
    assert doc.domains == ("unclassified",)


# --- the owner ----------------------------------------------------------------


def test_every_thread_carries_the_mailbox_owner(example_config):
    mailbox = Mailbox(email=OWNER, owner_email="pat@example.com")
    fake = _fake({"t1": [message("m1", ["L1"])]})
    (doc,), _ = _collect(fake, example_config, mailbox)
    assert doc.owner_email == "pat@example.com"
    assert doc.metadata["mailbox"] == OWNER


def test_refuses_a_sign_in_for_another_mailbox(example_config):
    fake = FakeGmail(email="someone.else@example.com", labels=LABELS,
                     threads={"t1": [message("m1", ["L1"])]})
    with pytest.raises(gmail.GmailConnectorError, match="another mailbox"):
        _collect(fake, example_config)
    assert fake.fetched() == [] and not [c for c in fake.calls if c[0] == "list"]


@pytest.mark.parametrize("owner", [None, "", "  "])
def test_refuses_a_mailbox_with_no_owner(example_config, owner):
    fake = _fake({"t1": [message("m1", ["L1"])]})
    with pytest.raises(gmail.GmailConnectorError, match="owner"):
        _collect(fake, example_config, Mailbox(email=OWNER, owner_email=owner))


# --- the document -------------------------------------------------------------


def test_the_document_holds_the_whole_thread(example_config):
    fake = _fake({"t1": [
        message("m1", ["L1"], subject="Budget", body="First message."),
        message("m2", ["L1"], sender="Sam <sam@partner.example>", to=OWNER,
                subject="Re: Budget", body="Second message.",
                date="Tue, 6 Jan 2026 09:00:00 +0000"),
    ]})
    (doc,), _ = _collect(fake, example_config)
    assert doc.source == "gmail" and doc.external_id == "t1"
    assert doc.title == "Re: Budget"
    assert "First message." in doc.body and "Second message." in doc.body
    assert doc.metadata["participants"] == [OWNER, "sam@partner.example"]
    assert doc.metadata["message_ids"] == ["m1", "m2"]
    assert doc.metadata["message_count"] == 2
    assert doc.source_created_at.isoformat() == "2026-01-06T09:00:00+00:00"
    assert doc.url.endswith("#all/t1")


def test_html_only_mail_is_read_as_text(example_config):
    html = message("m1", ["L1"])
    html["payload"] = {
        "mimeType": "text/html",
        "headers": html["payload"]["headers"],
        **text_part("<p>Hello <b>there</b></p><script>bad()</script>", "text/html"),
    }
    (doc,), _ = _collect(_fake({"t1": [html]}), example_config)
    assert "Hello there" in doc.body
    assert "<p>" not in doc.body and "<b>" not in doc.body
    assert "script" not in doc.body and "bad()" not in doc.body


def test_a_thread_with_no_text_still_makes_a_document(example_config):
    empty = message("m1", ["L1"], subject="Scan attached", body="")
    (doc,), _ = _collect(_fake({"t1": [empty]}), example_config)
    assert doc.title == "Scan attached" and doc.body.strip()


def test_a_very_long_thread_is_cut(example_config):
    from knowledge.config import GMAIL_MAX_THREAD_CHARS

    long = message("m1", ["L1"], body="x" * (GMAIL_MAX_THREAD_CHARS * 2))
    (doc,), _ = _collect(_fake({"t1": [long]}), example_config)
    assert len(doc.body) <= GMAIL_MAX_THREAD_CHARS


# --- failure is never read as absence -----------------------------------------


def test_a_thread_that_cannot_be_read_fails_the_run(example_config):
    fake = _fake({"t1": [message("m1", ["L1"])], "t2": [message("m2", ["L1"])]},
                 broken=frozenset({"t2"}))
    with pytest.raises(gmail.GmailConnectorError, match="could not be read"):
        _collect(fake, example_config)


def test_too_many_threads_fails_the_run_instead_of_reading_some(example_config, monkeypatch):
    monkeypatch.setattr(gmail, "GMAIL_MAX_THREADS_PER_RUN", 2)
    threads = {f"t{i}": [message(f"m{i}", ["L1"])] for i in range(3)}
    fake = _fake(threads)
    with pytest.raises(gmail.GmailConnectorError, match="above the limit"):
        _collect(fake, example_config)
    assert fake.fetched() == []


def test_a_thread_that_lost_its_label_since_the_listing_is_left_out(example_config):
    fake = _fake({"t1": [message("m1", ["L1"])]}, unlabelled_on_get=frozenset({"t1"}))
    documents, result = _collect(fake, example_config)
    assert documents == []
    assert (result.threads_listed, result.skipped_unlabelled) == (1, 1)


# --- label removed ------------------------------------------------------------


def test_confirm_removed_names_threads_that_lost_every_tag_label(example_config):
    fake = _fake({
        "kept": [message("m1", ["L1"])],
        "unlabelled": [message("m2", ["INBOX", "L4"])],
        "broken": [message("m3", ["INBOX"])],
    }, broken=frozenset({"broken"}))
    removed = gmail.confirm_removed(
        service(fake), example_config, MAILBOX, ["kept", "unlabelled", "deleted", "broken"]
    )
    assert removed == frozenset({"unlabelled", "deleted"})
    assert fake.fetched("full") == [], "only labels are read to confirm a removal"


def test_confirm_removed_checks_the_mailbox_first(example_config):
    fake = FakeGmail(email="someone.else@example.com", labels=LABELS, threads={})
    with pytest.raises(gmail.GmailConnectorError, match="another mailbox"):
        gmail.confirm_removed(service(fake), example_config, MAILBOX, ["t1"])


def test_confirm_removed_asks_nothing_when_nothing_is_absent(example_config):
    fake = _fake({})
    assert gmail.confirm_removed(service(fake), example_config, MAILBOX, []) == frozenset()
    assert fake.calls == []


def test_confirm_removed_checks_every_absent_thread(example_config):
    """A cap here would leave the rest held by ingest's guard on every run."""
    ids = [f"t{i}" for i in range(450)]
    fake = _fake({})
    removed = gmail.confirm_removed(service(fake), example_config, MAILBOX, ids)
    assert removed == frozenset(ids) and len(fake.fetched()) == 450


def test_confirm_removed_ignores_ids_that_are_not_thread_ids(example_config):
    fake = _fake({})
    removed = gmail.confirm_removed(
        service(fake), example_config, MAILBOX, ["ok1", "../etc", "a b", "", None])
    assert removed == frozenset({"ok1"}) and fake.fetched() == ["ok1"]
