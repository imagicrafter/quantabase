"""Per-source tag readers, and the resolver's answer on a fixture set for all
four sources."""

from __future__ import annotations

import dataclasses

import pytest

from knowledge.tag_resolver import resolve
from knowledge.tag_sources import drive, fireflies, gmail, wiki

# --- wiki ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "frontmatter, expected",
    [
        ({"domains": ["consulting", "properties"]}, ("consulting", "properties")),
        ({"domains": "consulting"}, ("consulting",)),
        ({"domains": "consulting, properties"}, ("consulting", "properties")),
        ({"domains": "[consulting, properties]"}, ("consulting", "properties")),
        ({"domains": []}, ()),
        ({"domains": None}, ()),
        ({"domains": [None, "", "  "]}, ()),
        ({"domains": [None, {"a": 1}, ["x"], True]}, ("?unreadable",)),
        ({"domains": {"private": True}}, ("?unreadable",)),
        ({"domains": False}, ("?unreadable",)),
        ({"domains": ["consulting", ["private"]]}, ("consulting", "?unreadable")),
        ({"domains": 7}, ("7",)),
        ({"tags": ["consulting"]}, ()),
        ({}, ()),
        (None, ()),
        ("domains: consulting", ()),
    ],
)
def test_wiki_reads_only_the_frontmatter_key(frontmatter, expected):
    assert wiki.content_tags(frontmatter) == expected


def test_wiki_key_name_is_configurable():
    assert wiki.content_tags({"topics": ["consulting"]}, "topics") == ("consulting",)
    assert wiki.content_tags({"domains": ["consulting"]}, "topics") == ()
    assert wiki.has_key({"topics": ["consulting"]}, "topics")
    assert not wiki.has_key({"topics": []}, "topics")


@pytest.mark.parametrize(
    "text, frontmatter, expected",
    [
        ("---\ndomains: [private]\n---\nbody", {"domains": ["private"]}, ("private",)),
        ("---\ndomains: [private]\nnever closed", {}, ("?unreadable",)),
        ("\ufeff---\ndomains: [private]\n---\nbody", {}, ("?unreadable",)),
        ("# No frontmatter\n\n---\n", {}, ()),
        ("", {}, ()),
        (None, None, ()),
    ],
)
def test_wiki_frontmatter_that_cannot_be_read_is_not_treated_as_untagged(
    text, frontmatter, expected
):
    readable = wiki.frontmatter_for_tags(text, frontmatter)
    assert wiki.content_tags(readable) == expected


def test_wiki_unreadable_tags_never_take_the_source_default(example_config):
    wiki_source = dataclasses.replace(example_config.sources.wiki, default_domain="consulting")
    config = dataclasses.replace(
        example_config, sources=dataclasses.replace(example_config.sources, wiki=wiki_source)
    )
    for frontmatter in ({"domains": {"private": True}}, {"domains": [["private"]]}, {"domains": False}):
        got = resolve("wiki", wiki.content_tags(frontmatter), (), config)
        assert got.domains == ("unclassified",) and "unknown_tag" in got.signals
    assert resolve("wiki", wiki.content_tags({"domains": []}), (), config).domains == ("consulting",)


# --- drive --------------------------------------------------------------------


@pytest.mark.parametrize(
    "description, expected",
    [
        ("kx/consulting", ("kx/consulting",)),
        ("Signed copy. kx/consulting.", ("kx/consulting",)),
        ("KX/Consulting and kx/properties", ("kx/Consulting", "kx/properties")),
        ("(kx/rental-homes)", ("kx/rental-homes",)),
        ("kx/consulting kx/consulting", ("kx/consulting",)),
        ("kx/consulting/secret", ("kx/consulting/secret",)),
        ("kx/consulting/ and more", ("kx/consulting",)),
        ("see linkx/consulting", ()),
        ("kx/ consulting", ()),
        ("no tag here", ()),
        ("", ()),
        (None, ()),
        (42, ()),
    ],
)
def test_drive_finds_tags_anywhere_in_a_description(description, expected):
    assert drive.tags_in(description, "kx/") == expected


def test_drive_prefix_is_matched_literally():
    assert drive.tags_in("a.b+consulting", "a.b+") == ("a.b+consulting",)
    assert drive.tags_in("aXb+consulting", "a.b+") == ()
    with pytest.raises(ValueError):
        drive.tags_in("kx/consulting", "")


def test_drive_item_tags_keep_folders_nearest_first():
    item = {"id": "f1", "description": "kx/private"}
    folders = [
        {"id": "near", "description": None},
        {"id": "mid", "description": "kx/properties"},
        {"id": "far", "description": "kx/consulting"},
    ]
    content, containers = drive.item_tags(item, folders, "kx/")
    assert content == ("kx/private",)
    assert containers == ((), ("kx/properties",), ("kx/consulting",))
    assert drive.item_tags({}, None, "kx/") == ((), ())


# --- fireflies ----------------------------------------------------------------


def test_fireflies_channel_names_tolerate_every_shape():
    assert fireflies.channel_names({"channels": [{"id": "1", "title": "kx/consulting"}]}) == (
        "kx/consulting",
    )
    assert fireflies.channel_names({"channels": [{"name": " Sales "}, "Ops", None, 3]}) == (
        "Sales",
        "Ops",
    )
    assert fireflies.channel_names({"channels": {"title": "Sales"}}) == ("Sales",)
    for raw in ({}, {"channels": None}, {"channels": []}, {"channels": 5}, None):
        assert fireflies.channel_names(raw) == ()


def test_fireflies_ignores_channels_on_a_meeting_someone_else_shared():
    raw = {"channels": [{"title": "kx/consulting"}], "_shared": True}
    assert fireflies.channel_names(raw) == ()


def test_fireflies_channel_tags_from_a_prefixed_name_or_the_map():
    names = ("KX/Consulting", "Sales Calls", "Random")
    tags = fireflies.channel_tags(names, "kx/", {"sales calls": "properties"})
    assert tags == ("KX/Consulting", "properties")
    assert fireflies.channel_tags(("Random",), "kx/", {}) == ()
    assert fireflies.channel_tags(None, "kx/", None) == ()


def test_fireflies_page_frontmatter_is_the_content_tag():
    raw = {"channels": [{"title": "kx/consulting"}]}
    content, containers = fireflies.meeting_tags(raw, {"domains": ["private"]}, prefix="kx/")
    assert content == ("private",)
    assert containers == (("kx/consulting",),)
    assert fireflies.meeting_tags(raw, None, prefix="kx/") == ((), (("kx/consulting",),))
    assert fireflies.meeting_tags({}, {"tags": ["meeting"]}, prefix="kx/") == ((), ())


# --- gmail --------------------------------------------------------------------


def test_gmail_keeps_only_labels_that_start_with_the_prefix():
    labels = ["INBOX", "kx/consulting", "KX/Properties", "kx", "kx/", "clients/kx/x", None, 4]
    assert gmail.label_tags(labels, "kx/") == ("kx/consulting", "KX/Properties")
    assert gmail.label_tags("kx/consulting", "kx/") == ("kx/consulting",)
    assert gmail.label_tags(None, "kx/") == ()
    assert gmail.label_tags({"kx/b", "kx/a"}, "kx/") == ("kx/a", "kx/b")
    with pytest.raises(ValueError):
        gmail.label_tags(["kx/consulting"], "")


# --- the resolver on a fixture set, all four sources --------------------------


def _config(base):
    ff = dataclasses.replace(
        base.sources.fireflies, channels={"Sales Calls": "consulting"}
    )
    drive_source = dataclasses.replace(base.sources.drive, default_domain="properties")
    gmail_source = dataclasses.replace(base.sources.gmail, prefix="ai/")
    sources = dataclasses.replace(
        base.sources, fireflies=ff, drive=drive_source, gmail=gmail_source
    )
    return dataclasses.replace(base, sources=sources)


def _wiki(config, frontmatter):
    key = config.tagging.frontmatter_key
    return resolve("wiki", wiki.content_tags(frontmatter, key), (), config)


def _drive(config, item, folders):
    content, containers = drive.item_tags(item, folders, "kx/")
    return resolve("drive", content, containers, config)


def _fireflies(config, raw, page):
    content, containers = fireflies.meeting_tags(
        raw, page, prefix="kx/", channel_map=config.sources.fireflies.channels
    )
    return resolve("fireflies", content, containers, config)


def _gmail(config, labels):
    return resolve("gmail", gmail.label_tags(labels, "ai/"), (), config)


def test_fixture_set_resolves_as_expected_for_every_source(example_config):
    config = _config(example_config)
    tagged_folder = {"description": "Client work kx/consulting"}
    cases = [
        (_wiki(config, {"domains": ["consulting"]}), ("consulting",), "content"),
        (_wiki(config, {"domains": "private"}), ("private",), "content"),
        (_wiki(config, {"tags": ["consulting"]}), ("unclassified",), "default"),
        (_wiki(config, {"domains": ["nope"]}), ("unclassified",), "content"),
        (_drive(config, {"description": "kx/private"}, [tagged_folder]), ("private",), "content"),
        (_drive(config, {}, [{}, tagged_folder]), ("consulting",), "container"),
        (_drive(config, {"name": "consulting plan"}, []), ("properties",), "source_default"),
        (_drive(config, {}, [{"description": "kx/typo"}]), ("unclassified",), "container"),
        (_fireflies(config, {"channels": [{"title": "Sales Calls"}]}, None), ("consulting",), "container"),
        (
            _fireflies(config, {"channels": [{"title": "Sales Calls"}]}, {"domains": ["private"]}),
            ("private",),
            "content",
        ),
        (_fireflies(config, {"title": "consulting sync"}, None), ("unclassified",), "default"),
        (_gmail(config, ["INBOX", "ai/properties"]), ("properties",), "content"),
        (_gmail(config, ["INBOX", "kx/properties"]), ("unclassified",), "default"),
    ]
    for assignment, domains, matched_by in cases:
        assert (assignment.domains, assignment.matched_by) == (domains, matched_by)
