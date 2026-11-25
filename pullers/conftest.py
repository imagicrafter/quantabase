"""Puller tests never touch a real knowledge checkout.

`fireflies.fetch` reads meeting pages to find their tags. In tests that lookup
is switched off unless a test points it at a temporary folder.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _no_wiki_checkout(monkeypatch):
    from pullers import fireflies

    monkeypatch.setattr(fireflies, "_page_root", lambda: None)
    monkeypatch.setattr(fireflies, "_channels_field_ok", True)
