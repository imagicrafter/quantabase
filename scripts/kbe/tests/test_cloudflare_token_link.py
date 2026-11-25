"""The Cloudflare token link: the documented form, and the same as the page's."""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from kbe import cloudflare_token_link as token_link

ENGINE_SETUP = Path(__file__).resolve().parents[3] / "engine" / "src" / "setup"


def test_it_opens_the_documented_user_token_screen():
    parts = urlsplit(token_link.link())
    assert (parts.scheme, parts.netloc, parts.path) == (
        "https", "dash.cloudflare.com", "/profile/api-tokens")


def test_it_uses_only_the_four_documented_parameters():
    query = parse_qs(urlsplit(token_link.link()).query, strict_parsing=True)
    assert sorted(query) == ["accountId", "name", "permissionGroupKeys", "zoneId"]
    assert query["accountId"] == ["*"]
    assert query["zoneId"] == ["all"]
    assert query["name"] == [token_link.NAME]
    assert json.loads(query["permissionGroupKeys"][0]) == [
        {"key": "access", "type": "edit"},
        {"key": "access_acct", "type": "edit"},
        {"key": "dns", "type": "edit"},
        {"key": "zone", "type": "read"},
    ]


def test_it_is_encoded_like_the_documented_examples():
    link = token_link.link()
    assert "permissionGroupKeys=%5B%7B%22key%22%3A%22access%22%2C%22type%22%3A%22edit%22%7D" in link
    assert "&accountId=%2A&zoneId=all&name=KB%20Engine" in link
    assert not re.search(r"[\s\"<>]", link)


def test_the_page_builds_the_same_link():
    """engine/src/setup/token-link.ts must use the same keys, name and form."""
    source = (ENGINE_SETUP / "token-link.ts").read_text(encoding="utf-8")
    assert f'const BASE = "{token_link.BASE}";' in source
    assert f'TOKEN_LINK_NAME = "{token_link.NAME}"' in source
    assert '"accountId=%2A"' in source and '"zoneId=all"' in source
    keys = dict(re.findall(r"^\s+(apps|organization|dns|zone): \"([a-z_]+)\",$", source, re.MULTILINE))
    assert list(keys.values()) == [key for key, _scope, _name in token_link.PERMISSIONS]


def test_the_permission_names_are_the_page_s():
    source = (ENGINE_SETUP / "permissions.ts").read_text(encoding="utf-8")
    for _key, scope, name in token_link.PERMISSIONS:
        assert f'scope: "{scope}"' in source
        assert f'name: "{name}"' in source
    assert token_link.permission_lines()[0] == "Account - Access: Apps and Policies - Write"
    assert token_link.permission_lines()[-1] == "Zone - Zone - Read"


def test_what_the_link_cannot_set_is_listed_for_the_person():
    text = " ".join(token_link.BY_HAND)
    assert "Zone policy" in text and "Account policy" in text and "Expiration" in text
    assert "Specific zone" in text and "pencil" in text
