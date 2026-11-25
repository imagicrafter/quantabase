"""Replace secret-looking strings with [redacted] (send-session).

Deterministic and stdlib only: the same text always gives the same result, so
a part that was already sent hashes the same next time. It errs on the side of
cutting: a false hit costs a word, a miss could send a key.
"""

from __future__ import annotations

import re

REDACTED = "[redacted]"

# Whole tokens with a known shape. Order matters: the longer prefixes first.
_TOKENS = [
    r"-----BEGIN ([A-Z0-9 ]{1,40})-----[\s\S]*?-----END \1-----",
    r"sk-ant-[A-Za-z0-9_-]{16,}",
    r"sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}",
    r"dop_v1_[A-Fa-f0-9]{20,}",
    r"sb_secret_[A-Za-z0-9_-]{10,}",
    r"AIza[0-9A-Za-z_-]{30,}",
    r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
    r"gh[pousr]_[A-Za-z0-9]{30,}",
    r"github_pat_[A-Za-z0-9_]{20,}",
    r"xox[abprs]-[A-Za-z0-9-]{10,}",
    r"AKIA[0-9A-Z]{16}",
    r"[sr]k_(?:live|test)_[A-Za-z0-9]{16,}",
    r"sbp_[A-Za-z0-9]{20,}",
    r"xapp-[A-Za-z0-9-]{10,}",
    r"whsec_[A-Za-z0-9+/=]{16,}",
]
# A token never starts in the middle of a word ("task-..." is not "sk-...").
_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9_-])(?:" + "|".join(f"(?:{p})" for p in _TOKENS) + ")")

# A name holding one of these words. Both sides are bounded so a long run of
# letters never makes the match backtrack for long.
_NAME = (
    r"[A-Za-z0-9_]{0,40}(?:password|passwd|pwd|secret|token|key|credentials?|cookie)[A-Za-z0-9_]{0,40}"
)
# name = value: any value of 4+ characters.
_ASSIGN_EQ = re.compile(rf"(?i)\b({_NAME})(\s*=\s*)([\"']?)(?!\[redacted\])([^\s\"'`,;]{{4,}})")
# name: value (also JSON "name": "value"): only a value that looks like a key
# (letters and digits mixed, 8+ characters), so prose like "password: open
# settings" is left alone.
_ASSIGN_COLON = re.compile(
    rf"(?i)\b({_NAME})([\"']?\s*:\s*)([\"']?)(?!\[redacted\])(?=[^\s\"'`,;]*\d)(?=[^\s\"'`,;]*[A-Za-z])([^\s\"'`,;]{{8,}})"
)
# user:password@host, up to the LAST @ before the host (a password may hold @ and /).
_URL_PASSWORD = re.compile(r"(://[^\s:/@]{1,100}:)(?!\[redacted\])(\S{1,200})(@[^\s@/:]+)")
_BEARER = re.compile(r"(?i)\b(bearer\s+)(?!\[redacted\])([A-Za-z0-9._~+/-]{20,}=*)")
_BASIC = re.compile(r"(?i)\b(authorization\s*:\s*basic\s+)(?!\[redacted\])([A-Za-z0-9+/]{8,}=*)")


def scrub(text: str) -> tuple[str, int]:
    """The text with every secret-looking string replaced, and how many were."""
    count = 0

    def whole(_m: re.Match[str]) -> str:
        nonlocal count
        count += 1
        return REDACTED

    def keep_name(m: re.Match[str]) -> str:
        nonlocal count
        count += 1
        return f"{m.group(1)}{m.group(2)}{m.group(3)}{REDACTED}"

    def keep_ends(m: re.Match[str]) -> str:
        nonlocal count
        count += 1
        return f"{m.group(1)}{REDACTED}{m.group(3)}"

    def keep_prefix(m: re.Match[str]) -> str:
        nonlocal count
        count += 1
        return f"{m.group(1)}{REDACTED}"

    out = _TOKEN_RE.sub(whole, text)
    out = _ASSIGN_EQ.sub(keep_name, out)
    out = _ASSIGN_COLON.sub(keep_name, out)
    out = _URL_PASSWORD.sub(keep_ends, out)
    out = _BEARER.sub(keep_prefix, out)
    out = _BASIC.sub(keep_prefix, out)
    return out, count
