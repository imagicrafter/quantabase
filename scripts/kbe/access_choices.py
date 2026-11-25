"""What `kbe access setup` sends to the app as the person's choices. No I/O.

Nothing is retyped. Each choice is taken from the first place that has it:

    hostname   --host, the applied config's connector address, the local state
    owner      the applied config (the app uses its own copy and ignores ours)
    level      --level, the local state, else `owner` (the narrowest)
    people     --emails, else the local state (only for the `people` level)
    domains    --domains, else the local state (only for the `domain` level)

The level and its lists are not part of the Engine config. They are kept in
the local state file once given, so a second run needs no flags. None of
these is a secret. The app validates all of it again; the checks here only
catch a mistake before a deployment is spent on it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlsplit

from .errors import KbeError, UsageError

LEVELS = ("owner", "people", "domain")
MAX_EMAILS, MAX_DOMAINS = 50, 10
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_HOSTNAME = re.compile(rf"(?:{_LABEL}\.)+[a-z]{{2,63}}")
_EMAIL = re.compile(rf"[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*@(?:{_LABEL}\.)+[a-z]{{2,63}}")
_LEVEL_WORDS = {
    "owner": "owner only",
    "people": "the owner and the people listed",
    "domain": "the owner and anyone at the domains listed",
}
STATE_KEYS = ("engine_host", "access_level", "access_emails", "access_domains")


@dataclass(frozen=True)
class Choices:
    host: str
    host_from: str
    owner: str
    level: str
    emails: tuple[str, ...] = ()
    domains: tuple[str, ...] = ()
    replace: bool = False

    def form(self) -> dict[str, str]:
        """The fields the app's setup form takes. No secret among them."""
        return {
            "host": self.host, "level": self.level, "owner_email": self.owner,
            "emails": "\n".join(self.emails), "domains": "\n".join(self.domains),
            "replace": "yes" if self.replace else "",
        }

    def answers(self) -> dict[str, Any]:
        """What the local state file remembers for the next run."""
        return {
            "engine_host": self.host, "access_level": self.level,
            "access_emails": list(self.emails), "access_domains": list(self.domains),
        }

    def lines(self) -> list[str]:
        found = [
            f"  Hostname:        {self.host}  ({self.host_from})",
            f"  Owner:           {self.owner}  (the applied config)",
            f"  Who may sign in: {_LEVEL_WORDS[self.level]}  (level `{self.level}`)",
        ]
        if self.emails:
            found.append(f"  People:          {', '.join(self.emails)}")
        if self.domains:
            found.append(f"  Domains:         {', '.join(self.domains)}")
        if self.replace:
            found.append("  Replace what is already there: yes (a DNS record or application "
                         "for this hostname that setup did not make is taken over)")
        return found


def _items(value: Any) -> tuple[str, ...]:
    """A typed or stored list as lower-case items, sorted, without repeats."""
    if isinstance(value, str):
        parts = re.split(r"[\s,;]+", value)
    elif isinstance(value, (list, tuple)):
        parts = [str(item) for item in value]
    else:
        parts = []
    return tuple(sorted({part.strip().lower() for part in parts if part.strip()}))


def _config_host(config: Mapping[str, Any] | None) -> str:
    """The hostname in the config's connector address, or ""."""
    for section in ("dashboard", "engine"):
        holder = (config or {}).get(section)
        connect = holder.get("connect") if isinstance(holder, Mapping) else None
        url = connect.get("connector_url") if isinstance(connect, Mapping) else None
        if isinstance(url, str) and url:
            return (urlsplit(url).hostname or "").lower()
    return ""


def _owner(config: Mapping[str, Any] | None) -> str:
    engine = (config or {}).get("engine")
    owner = engine.get("owner") if isinstance(engine, Mapping) else None
    email = owner.get("email") if isinstance(owner, Mapping) else owner
    return email.strip().lower() if isinstance(email, str) else ""


def _host(flag: str | None, config: Mapping[str, Any] | None,
          answers: Mapping[str, Any]) -> tuple[str, str]:
    if flag:
        return flag.strip().lower(), "--host"
    named = _config_host(config)
    if named:
        return named, "the applied config"
    stored = answers.get("engine_host")
    if isinstance(stored, str) and stored:
        return stored.strip().lower(), "the local state"
    raise UsageError(
        "No hostname is known for the Engine. Pass --host engine.example.com, or set "
        "dashboard.connect.connector_url in the Engine config and apply it."
    )


def _problems(choices: Choices) -> list[str]:
    bad_emails = [e for e in choices.emails if not _EMAIL.fullmatch(e)]
    bad_domains = [d for d in choices.domains if not _HOSTNAME.fullmatch(d)]
    checks = (
        (not _HOSTNAME.fullmatch(choices.host) or len(choices.host) > 253,
         "The hostname is not valid. Write it like engine.example.com."),
        (bool(bad_emails), f"{len(bad_emails)} of the email addresses are not valid."),
        (bool(bad_domains),
         f"{len(bad_domains)} of the domains are not valid. Write them like example.com."),
        (len(choices.emails) > MAX_EMAILS, f"List at most {MAX_EMAILS} people."),
        (len(choices.domains) > MAX_DOMAINS, f"List at most {MAX_DOMAINS} domains."),
        (choices.level == "people" and not choices.emails,
         "The `people` level needs at least one other person: pass --emails."),
        (choices.level != "people" and bool(choices.emails),
         "--emails is only used with --level people."),
        (choices.level == "domain" and not choices.domains,
         "The `domain` level needs at least one email domain: pass --domains."),
        (choices.level != "domain" and bool(choices.domains),
         "--domains is only used with --level domain."),
    )
    return [text for failed, text in checks if failed]


def resolve(
    args: Any, config: Mapping[str, Any] | None, answers: Mapping[str, Any],
) -> Choices:
    """The choices for this run, checked. Raises with every problem at once."""
    owner = _owner(config)
    if not owner:
        raise KbeError(
            "No Engine config has been applied, so the owner is not known. "
            "Run `python -m kbe config apply <your engine.yaml>` first."
        )
    host, host_from = _host(args.host, config, answers)
    level = args.level or answers.get("access_level") or "owner"
    if level not in LEVELS:
        raise UsageError(f"The level must be one of: {', '.join(LEVELS)}.")
    stored = {
        "people": _items(answers.get("access_emails")) if args.emails is None else (),
        "domain": _items(answers.get("access_domains")) if args.domains is None else (),
    }
    emails = _items(args.emails) if args.emails is not None else (
        stored["people"] if level == "people" else ())
    domains = _items(args.domains) if args.domains is not None else (
        stored["domain"] if level == "domain" else ())
    choices = Choices(
        host=host, host_from=host_from, owner=owner, level=level,
        emails=tuple(e for e in emails if e != owner), domains=domains,
        replace=bool(args.replace),
    )
    problems = _problems(choices)
    if problems:
        raise UsageError(" ".join(problems))
    return choices
