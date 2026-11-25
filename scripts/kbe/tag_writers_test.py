"""Writing a tag back to its source changes the tag and nothing else."""

from __future__ import annotations

import pytest

from kbe import tag_writers
from kbe.tag_writers import (
    TagWriteError,
    set_frontmatter_key,
    tagged_description,
    write_drive_tag,
    write_gmail_labels,
    write_wiki_tag,
)
from knowledge.frontmatter import parse

BODY = "\n# Title\n\nText with --- dashes, `domains: nope`, tabs\tand trailing space \n"
PAGE = "---\ntitle: \"A: b\"\ntags: [meeting, x]\nrelated:\n  - '[[One]]'\n---\n" + BODY

# --- wiki ---------------------------------------------------------------------


def test_adds_the_key_and_keeps_every_other_byte():
    updated = set_frontmatter_key(PAGE, "domains", ["consulting"])
    assert updated == PAGE.replace("---\n\n# Title", "domains: [consulting]\n---\n\n# Title", 1)
    assert parse(updated).frontmatter["domains"] == ["consulting"]
    assert updated.endswith(BODY)


@pytest.mark.parametrize(
    "existing",
    [
        "domains: [properties]\n",
        "domains: properties\n",
        "domains:\n  - properties\n  - private\n",
        "domains:\n- properties\n",
        "domains: []\n",
        "domains:\n",
    ],
)
def test_replaces_an_existing_value_in_place(existing):
    page = f"---\ntitle: T\n{existing}tags: [a]\n---\nbody\n"
    updated = set_frontmatter_key(page, "domains", ["consulting", "private"])
    assert updated == "---\ntitle: T\ndomains: [consulting, private]\ntags: [a]\n---\nbody\n"


def test_a_page_without_frontmatter_gets_one_above_its_untouched_text():
    for text in ("# Just a page\n", "", "--- not frontmatter\ntext\n"):
        updated = set_frontmatter_key(text, "domains", ["consulting"])
        assert updated == f"---\ndomains: [consulting]\n---\n{text}"


@pytest.mark.parametrize(
    "text", ["---\ntitle: T\nnever closed\n", "\ufeff---\ntitle: T\n---\nbody\n", "\ufeffplain\n"]
)
def test_a_page_with_unreadable_frontmatter_is_refused_not_rewritten(text, tmp_path):
    with pytest.raises(TagWriteError):
        set_frontmatter_key(text, "domains", ["consulting"])
    (tmp_path / "a.md").write_bytes(text.encode("utf-8"))
    with pytest.raises(TagWriteError):
        write_wiki_tag(tmp_path, "a.md", ["consulting"], "domains")
    assert (tmp_path / "a.md").read_bytes() == text.encode("utf-8")


def test_windows_line_endings_are_kept():
    page = "---\r\ntitle: T\r\n---\r\nbody\r\n"
    updated = set_frontmatter_key(page, "domains", ["consulting"])
    assert updated == "---\r\ntitle: T\r\ndomains: [consulting]\r\n---\r\nbody\r\n"


def test_the_same_tag_twice_changes_nothing():
    once = set_frontmatter_key(PAGE, "domains", ["consulting"])
    assert set_frontmatter_key(once, "domains", ["consulting"]) == once


def test_a_similar_key_or_an_indented_one_is_not_mistaken_for_the_key():
    page = "---\nmy_domains: [x]\nmeta:\n  domains: [y]\n---\nbody\n"
    updated = set_frontmatter_key(page, "domains", ["consulting"])
    assert updated == "---\nmy_domains: [x]\nmeta:\n  domains: [y]\ndomains: [consulting]\n---\nbody\n"


@pytest.mark.parametrize("topics", [[], ["Not A Slug"], ["a]\nevil: true"], [5], ["x, y"]])
def test_only_topic_ids_can_be_written(topics):
    with pytest.raises(TagWriteError):
        set_frontmatter_key(PAGE, "domains", topics)


def test_a_bad_key_is_refused():
    with pytest.raises(TagWriteError):
        set_frontmatter_key(PAGE, "do mains:\nx", ["consulting"])


def test_write_wiki_tag_edits_only_the_named_page(tmp_path):
    (tmp_path / "concepts").mkdir()
    page = tmp_path / "concepts" / "a.md"
    other = tmp_path / "concepts" / "b.md"
    page.write_bytes(PAGE.encode("utf-8"))
    other.write_bytes(PAGE.encode("utf-8"))

    assert write_wiki_tag(tmp_path, "concepts/a.md", ["consulting"], "domains") is True
    assert page.read_bytes().decode("utf-8").endswith(BODY)
    assert parse(page.read_text(encoding="utf-8")).frontmatter["domains"] == ["consulting"]
    assert other.read_bytes() == PAGE.encode("utf-8")
    assert write_wiki_tag(tmp_path, "concepts/a.md", ["consulting"], "domains") is False


@pytest.mark.parametrize(
    "external_id",
    ["../outside.md", "/etc/hosts", "concepts/a.md#00-part", "concepts/missing.md", "concepts/a.txt", ""],
)
def test_write_wiki_tag_refuses_paths_that_are_not_pages_in_the_clone(tmp_path, external_id):
    (tmp_path / "wiki" / "concepts").mkdir(parents=True)
    (tmp_path / "wiki" / "concepts" / "a.md").write_text(PAGE, encoding="utf-8")
    (tmp_path / "wiki" / "concepts" / "a.txt").write_text("x", encoding="utf-8")
    (tmp_path / "outside.md").write_text(PAGE, encoding="utf-8")
    with pytest.raises(TagWriteError):
        write_wiki_tag(tmp_path / "wiki", external_id, ["consulting"], "domains")
    assert (tmp_path / "outside.md").read_text(encoding="utf-8") == PAGE


def test_write_wiki_tag_needs_a_real_clone(tmp_path):
    with pytest.raises(TagWriteError, match="not found"):
        write_wiki_tag(tmp_path / "nope", "concepts/a.md", ["consulting"], "domains")


# --- drive --------------------------------------------------------------------


class FakeDrive:
    def __init__(self, descriptions: dict[str, str | None]):
        self.descriptions = dict(descriptions)
        self.updates: list[tuple[str, str]] = []

    def get_description(self, file_id: str) -> str:
        return self.descriptions[file_id]

    def set_description(self, file_id: str, description: str) -> None:
        self.updates.append((file_id, description))


@pytest.mark.parametrize(
    "current, expected",
    [
        (None, "kx/consulting"),
        ("", "kx/consulting"),
        ("Signed copy.", "Signed copy.\nkx/consulting"),
        ("Signed copy. kx/consluting", "Signed copy.\nkx/consulting"),
        ("kx/properties and notes", "and notes\nkx/consulting"),
        ("Signed. KX/Consulting", "Signed. KX/Consulting"),
    ],
)
def test_drive_description_gets_exactly_the_tag(current, expected):
    assert tagged_description(current, ["consulting"], "kx/") == expected


def test_drive_write_goes_through_the_injected_client_only():
    client = FakeDrive({"f1": "Signed copy.", "f2": "kx/consulting"})
    assert write_drive_tag(client, "f1", ["consulting", "properties"], "kx/") is True
    assert client.updates == [("f1", "Signed copy.\nkx/consulting kx/properties")]
    assert write_drive_tag(client, "f2", ["consulting"], "kx/") is False
    assert len(client.updates) == 1


def test_drive_failures_are_reported_without_a_partial_write():
    class Broken(FakeDrive):
        def get_description(self, file_id):
            raise ConnectionError("secret detail")

    with pytest.raises(TagWriteError, match="f1") as caught:
        write_drive_tag(Broken({}), "f1", ["consulting"], "kx/")
    assert "secret detail" not in str(caught.value)
    with pytest.raises(TagWriteError):
        write_drive_tag(FakeDrive({}), " ", ["consulting"], "kx/")
    with pytest.raises(TagWriteError):
        write_drive_tag(FakeDrive({"f1": ""}), "f1", ["Bad Topic"], "kx/")


# --- gmail --------------------------------------------------------------------


class FakeGmail:
    def __init__(self, labels=None, threads=None):
        self.names: dict[str, str] = dict(labels or {})
        self.threads: dict[str, set[str]] = {k: set(v) for k, v in (threads or {}).items()}
        self.changes: list[tuple[str, list[str], list[str]]] = []

    def labels(self):
        return dict(self.names)

    def create_label(self, name: str) -> str:
        self.names[name] = f"Label_{len(self.names) + 1}"
        return self.names[name]

    def thread_label_ids(self, thread_id: str):
        return sorted(self.threads.get(thread_id, set()))

    def modify_thread(self, thread_id: str, add, remove) -> None:
        self.changes.append((thread_id, list(add), list(remove)))
        self.threads[thread_id] = (self.threads.get(thread_id, set()) | set(add)) - set(remove)


def test_gmail_label_is_created_once_and_put_on_the_thread():
    client = FakeGmail()
    assert write_gmail_labels(client, "t1", ["consulting"], "ai/") is True
    assert write_gmail_labels(client, "t2", ["consulting", "properties"], "ai/") is True
    assert client.names == {"ai/consulting": "Label_1", "ai/properties": "Label_2"}
    assert client.changes == [("t1", ["Label_1"], []), ("t2", ["Label_1", "Label_2"], [])]
    assert write_gmail_labels(client, "t1", ["consulting"], "ai/") is False
    assert len(client.changes) == 2


def test_gmail_takes_off_a_tag_label_for_another_topic_and_nothing_else():
    client = FakeGmail(
        labels={"INBOX": "INBOX", "AI/Private": "L1", "ai/consulting": "L2", "clients": "L3"},
        threads={"t1": {"INBOX", "L1", "L3"}},
    )
    assert write_gmail_labels(client, "t1", ["consulting"], "ai/") is True
    assert client.changes == [("t1", ["L2"], ["L1"])]
    assert client.threads["t1"] == {"INBOX", "L2", "L3"}
    assert "ai/consulting" in client.names and len(client.names) == 4, "no duplicate label"


def test_gmail_refuses_bad_input_before_calling_the_client():
    client = FakeGmail()
    for thread_id, topics, prefix in (
        ("", ["consulting"], "ai/"), ("t1", [], "ai/"), ("t1", ["Nope!"], "ai/"),
        ("t1", ["consulting"], ""),
    ):
        with pytest.raises(TagWriteError):
            write_gmail_labels(client, thread_id, topics, prefix)
    assert client.changes == [] and client.names == {}


def test_gmail_failures_are_reported_by_thread_id():
    class Broken(FakeGmail):
        def labels(self):
            raise ConnectionError("secret detail")

    with pytest.raises(TagWriteError, match="t1") as caught:
        write_gmail_labels(Broken(), "t1", ["consulting"], "ai/")
    assert "secret detail" not in str(caught.value)


def test_the_module_never_builds_a_client_itself():
    source = tag_writers.__file__
    text = open(source, encoding="utf-8").read()
    assert "googleapiclient" not in text and "build(" not in text
