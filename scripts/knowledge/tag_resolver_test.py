"""The tag resolver: topics come only from tags a person can see at the source.

Order: content tag, container tag (nearest first), the source's default topic,
then `unclassified`.
"""

from __future__ import annotations

import dataclasses

import pytest

from knowledge.tag_resolver import (
    MATCH_CONTAINER,
    MATCH_CONTENT,
    MATCH_DEFAULT,
    MATCH_SOURCE_DEFAULT,
    UNKNOWN_TAG,
    DomainAssignment,
    has_unknown_tag,
    prefix_for,
    resolve,
)

UNCLASSIFIED = ("unclassified",)


def _with_source(config, source: str, **changes):
    updated = dataclasses.replace(getattr(config.sources, source), **changes)
    return dataclasses.replace(
        config, sources=dataclasses.replace(config.sources, **{source: updated})
    )


def _with_prefix(config, prefix: str):
    return dataclasses.replace(config, tagging=dataclasses.replace(config.tagging, prefix=prefix))


# --- the order of precedence -------------------------------------------------


def test_a_content_tag_wins_over_a_container_tag(example_config):
    got = resolve("drive", ["kx/properties"], [["kx/consulting"]], example_config)
    assert got == DomainAssignment(("properties",), MATCH_CONTENT, ("properties",))


def test_a_container_tag_is_used_when_the_item_has_none(example_config):
    got = resolve("drive", [], [["kx/consulting"]], example_config)
    assert got.domains == ("consulting",) and got.matched_by == MATCH_CONTAINER


def test_the_nearest_tagged_container_wins(example_config):
    nearest_first = [[], ["kx/properties"], ["kx/consulting"]]
    got = resolve("drive", [], nearest_first, example_config)
    assert got.domains == ("properties",) and got.matched_by == MATCH_CONTAINER


def test_a_flat_container_list_is_read_nearest_first(example_config):
    got = resolve("drive", [], ["kx/properties", "kx/consulting"], example_config)
    assert got.domains == ("properties",)


def test_no_tag_falls_back_to_the_sources_default_topic(example_config):
    config = _with_source(example_config, "wiki", default_domain="consulting")
    got = resolve("wiki", [], [], config)
    assert got == DomainAssignment(("consulting",), MATCH_SOURCE_DEFAULT, ())


def test_no_tag_and_no_default_is_unclassified(example_config):
    got = resolve("wiki", [], [], example_config)
    assert got == DomainAssignment(UNCLASSIFIED, MATCH_DEFAULT, ())


def test_gmail_has_no_default_topic_so_untagged_mail_is_unclassified(example_config):
    assert resolve("gmail", [], [], example_config).matched_by == MATCH_DEFAULT


def test_a_default_topic_that_is_not_declared_is_never_used(example_config):
    config = _with_source(example_config, "drive", default_domain="retired")
    got = resolve("drive", [], [], config)
    assert got.domains == UNCLASSIFIED and got.matched_by == MATCH_DEFAULT
    assert "unknown_default:retired" in got.signals


# --- unknown tags -------------------------------------------------------------


def test_an_unknown_topic_is_unclassified_and_recorded(example_config):
    got = resolve("wiki", ["marketing"], [], example_config)
    assert got.domains == UNCLASSIFIED and got.matched_by == MATCH_CONTENT
    assert got.signals == (UNKNOWN_TAG, "unknown_tag:marketing")
    assert has_unknown_tag(got.signals)


def test_an_unknown_content_tag_does_not_fall_through_to_the_container(example_config):
    config = _with_source(example_config, "drive", default_domain="consulting")
    got = resolve("drive", ["kx/marketing"], [["kx/consulting"]], config)
    assert got.domains == UNCLASSIFIED and got.matched_by == MATCH_CONTENT


def test_an_unknown_tag_beside_a_valid_one_keeps_the_item_unclassified(example_config):
    got = resolve("wiki", ["consulting", "privte"], [], example_config)
    assert got.domains == UNCLASSIFIED
    assert got.signals == (UNKNOWN_TAG, "unknown_tag:privte")


def test_an_unknown_tag_on_the_nearest_container_stops_the_walk(example_config):
    got = resolve("drive", [], [["kx/oops"], ["kx/consulting"]], example_config)
    assert got.domains == UNCLASSIFIED and got.matched_by == MATCH_CONTAINER
    assert has_unknown_tag(got.signals)


def test_a_long_unknown_tag_is_cut_short_in_the_signal(example_config):
    got = resolve("wiki", ["x" * 500], [], example_config)
    assert max(len(signal) for signal in got.signals) < 100


# --- several tags, case, whitespace, duplicates -------------------------------


def test_several_valid_tags_give_several_topics(example_config):
    got = resolve("wiki", ["properties", "consulting"], [], example_config)
    assert got.domains == ("consulting", "properties")
    assert got.signals == ("consulting", "properties")


def test_duplicate_tags_give_one_topic(example_config):
    got = resolve("wiki", ["consulting", "Consulting", "kx/consulting"], [], example_config)
    assert got.domains == ("consulting",)


def test_matching_ignores_case_and_whitespace(example_config):
    got = resolve("drive", ["  KX/Consulting  ", '"kx/PROPERTIES"'], [], example_config)
    assert got.domains == ("consulting", "properties")


def test_a_tag_for_a_sensitive_topic_is_honoured(example_config):
    got = resolve("wiki", ["private"], [], example_config)
    assert got.domains == ("private",) and got.matched_by == MATCH_CONTENT
    assert not has_unknown_tag(got.signals)


def test_a_tag_for_unclassified_itself_is_a_real_tag(example_config):
    config = _with_source(example_config, "wiki", default_domain="consulting")
    got = resolve("wiki", ["unclassified"], [], config)
    assert got == DomainAssignment(UNCLASSIFIED, MATCH_CONTENT, ("unclassified",))


# --- garbage ------------------------------------------------------------------


@pytest.mark.parametrize(
    "tags", [None, [], [""], ["   "], [None, 5, {"a": 1}, ["nested"]], ["kx/"], ["''"]]
)
def test_empty_or_garbage_tags_count_as_no_tag(example_config, tags):
    nothing = DomainAssignment(UNCLASSIFIED, MATCH_DEFAULT, ())
    assert resolve("drive", tags, [], example_config) == nothing
    # As containers: one container carrying exactly these tags.
    assert resolve("drive", [], [tags], example_config) == nothing


def test_a_single_string_is_one_tag_not_a_list_of_letters(example_config):
    assert resolve("wiki", "consulting", [], example_config).domains == ("consulting",)
    assert resolve("drive", [], "kx/consulting", example_config).domains == ("consulting",)


def test_an_unknown_source_is_refused(example_config):
    with pytest.raises(ValueError, match="unknown source"):
        resolve("slack", [], [], example_config)


def test_a_missing_config_is_refused():
    with pytest.raises(ValueError, match="config"):
        resolve("wiki", [], [], None)


# --- the prefix ---------------------------------------------------------------


@pytest.mark.parametrize("prefix", ["kx/", "kx-", "topic:", "#", "ai_engine."])
def test_the_prefix_may_use_any_separator(example_config, prefix):
    config = _with_prefix(example_config, prefix)
    got = resolve("drive", [f"{prefix.upper()}Consulting"], [], config)
    assert got.domains == ("consulting",)


def test_the_prefix_is_the_sources_own_when_set(example_config):
    config = _with_source(example_config, "gmail", prefix="ai/")
    assert prefix_for("gmail", config) == "ai/"
    assert prefix_for("drive", config) == "kx/"
    assert resolve("gmail", ["ai/consulting"], [], config).domains == ("consulting",)
    # The general prefix is not this source's prefix, so it is not stripped.
    got = resolve("gmail", ["kx/consulting"], [], config)
    assert got.domains == UNCLASSIFIED and has_unknown_tag(got.signals)


def test_the_general_prefix_is_used_when_the_source_sets_none(example_config):
    config = _with_prefix(example_config, "team-")
    assert prefix_for("gmail", config) == "team-"
    assert resolve("gmail", ["team-properties"], [], config).domains == ("properties",)


# --- shape --------------------------------------------------------------------


def test_the_result_is_immutable_and_never_empty(example_config):
    got = resolve("wiki", [], [], example_config)
    assert got.domains
    with pytest.raises(dataclasses.FrozenInstanceError):
        got.domains = ("consulting",)  # type: ignore[misc]


def test_inputs_are_not_changed(example_config):
    content, containers = ["kx/consulting"], [["kx/properties"]]
    resolve("drive", content, containers, example_config)
    assert content == ["kx/consulting"] and containers == [["kx/properties"]]
