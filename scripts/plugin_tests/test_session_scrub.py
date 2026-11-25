"""send-session: secret-looking strings become [redacted] before anything is sent."""

from __future__ import annotations

import pytest

from plugin_tests.helpers import fake, load

scrub = load("session_scrub").scrub

A40 = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"

SECRETS = [
    fake("sk-" + "ant-", "api03-" + A40),
    fake("sk-" + "proj-", A40),
    fake("sk-", A40),
    fake("dop_" + "v1_", "0123456789abcdef0123456789abcdef"),
    fake("sb_" + "secret_", A40),
    fake("AI" + "za", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"),
    fake("ey" + "J", "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU"),
    fake("gh" + "p_", A40),
    fake("github_" + "pat_", "11ABCDEFG0" + A40),
    fake("xo" + "xb-", "123456789012-abcdefABCDEF"),
    fake("AK" + "IA", "ABCDEFGHIJKLMNOP"),
    fake("sk" + "_live_", A40),
    fake("rk" + "_live_", A40),
    fake("sb" + "p_", "0123456789abcdef0123456789abcdef01234567"),
    fake("xa" + "pp-", "1-A0123456789-0123456789-abcdef"),
    fake("wh" + "sec_", A40),
]


@pytest.mark.parametrize("secret", SECRETS)
def test_each_token_shape_is_redacted(secret):
    out, n = scrub(f"here it is: {secret} ok")
    assert secret not in out
    assert "[redacted]" in out
    assert n == 1
    assert out.endswith(" ok")


@pytest.mark.parametrize("line", [
    "password=hunter22", "PASSWORD = 's3cr3tvalue'", "api_key=abcd1234efgh", "apiKey: \"Zx9y8w7v6u5t4s3r\"",  # gitleaks:allow (made-up test values)
    "token=deadbeef1234", "client_secret=abcdefgh123", "export SECRET_TOKEN=abc123def456",  # gitleaks:allow (made-up test values)
    "SERVICE_ROLE_KEY=abcd1234efgh", "STRIPE_KEY=zzzz9999yyyy", "db_credentials=abc123xyz",  # gitleaks:allow (made-up test values)
    "session_cookie=abcd1234efgh",
])
def test_generic_assignments_keep_the_name_and_drop_the_value(line):
    out, n = scrub(line)
    assert n == 1
    assert "[redacted]" in out
    name = line.split("=")[0].split(":")[0].strip()
    assert out.startswith(name)


def test_prose_with_the_word_password_is_left_alone():
    text = "Reset the password: open settings and pick a new one. The token: see the docs."
    assert scrub(text) == (text, 0)


def test_pem_blocks_are_redacted_whole():
    pem = "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END " + "RSA PRIVATE KEY-----"
    out, n = scrub(f"key:\n{pem}\nafter")
    assert "MIIEow" not in out and "BEGIN" not in out
    assert out == "key:\n[redacted]\nafter" and n == 1


def test_url_passwords_and_bearer_tokens():
    url = "postgresql://user:" + "Pa55word9@db.example.com:5432/x"
    out, n = scrub(f"conn {url}")
    assert "Pa55word9" not in out and "user:[redacted]@db.example.com" in out
    bearer = "Authorization: Bearer " + "abcDEF1234567890abcDEF1234"
    out2, _ = scrub(bearer)
    assert "abcDEF1234567890" not in out2


def test_same_input_gives_same_output_and_unicode_survives():
    text = "Café — naïve 日本語 🙂 " + SECRETS[0]
    assert scrub(text) == scrub(text)
    out, _ = scrub(text)
    assert out.startswith("Café — naïve 日本語 🙂 ")


def test_already_redacted_text_is_not_counted_again():
    out, n = scrub("token=[redacted]")
    assert (out, n) == ("token=[redacted]", 0)


def test_a_token_prefix_inside_a_word_is_not_a_token():
    text = "see task-management-dashboard-version-two and mask-the-long-identifier-here"
    assert scrub(text) == (text, 0)


def test_basic_auth_and_passwords_holding_at_signs():
    basic = "Authorization: Basic " + "dXNlcjpwYXNzd29yZA=="
    out, n = scrub(basic)
    assert "dXNlcjpwYXNzd29yZA" not in out and n == 1
    assert scrub("a basic understanding of things") == ("a basic understanding of things", 0)
    url = "postgres://u:" + "p@ss/w@db.example.com/x"
    out, _ = scrub(url)
    assert "ss/w" not in out and out.endswith("@db.example.com/x")


def test_long_unbroken_words_scrub_fast():
    import time
    start = time.monotonic()
    for text in ("token" * 40_000, "x" * 200_000, "key_" * 50_000, "a=" * 100_000):
        scrub(text)
    assert time.monotonic() - start < 2.0
