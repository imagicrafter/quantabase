"""suggest-rules: count mail headers into per-address and per-domain totals, locally.

    python3 mail_contacts.py aggregate --in HEADERS.jsonl --account ADDRESS [--me ADDRESS ...] [--days N]
    python3 mail_contacts.py choose --report REPORT.json [--pick DOMAIN_OR_ADDRESS ...]

HEADERS.jsonl holds one message per line, header metadata only:
{"thread_id", "from", "to", "cc", "date", "label_ids"}. Anything else on a
line (a subject, a snippet, a message id) is ignored and never printed.

The output is exactly what the Engine's `report_mail_contacts` tool takes:
the account, the window in days, how many messages were read, and counts per
address and per domain (sent_to, received_from, threads, replied,
last_seen). No names, no subjects, no ids. Bulk senders, Gmail's bulk
categories and the owner's own addresses are dropped; free-mail domains
(gmail.com and the like) are kept as people only, never as a domain.
`choose` adds the person's answers: every domain and address they picked
gets `"chosen": true`, every other one `"chosen": false`. The Engine's rule
screen then starts with exactly those boxes ticked. Stdlib only, no network.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Iterable, Optional

ADDRESS = re.compile(r"[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+")
ACCOUNT = re.compile(r"^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$")

BULK_LOCAL = re.compile(
    r"^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer[-_.]?daemon|postmaster|"
    r"newsletters?|alerts?|digest|bounces?|automated|auto[-_.]?confirm)(?:[-_.+].*)?$"
    r"|^bounce[-_.+]|^.*[-_.+]no[-_.]?reply$"
)
BULK_CATEGORIES = frozenset({"CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"})
SKIP_LABELS = frozenset({"SPAM", "TRASH", "DRAFT"})

FREE_MAIL = frozenset({
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com",
    "yahoo.com", "yahoo.co.uk", "ymail.com", "aol.com", "icloud.com", "me.com", "mac.com",
    "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "web.de", "mail.com",
    "zoho.com", "yandex.com", "yandex.ru", "fastmail.com", "hey.com", "tutanota.com", "qq.com", "163.com",
    "comcast.net", "att.net", "verizon.net", "sbcglobal.net",
})

MAX_ADDRESSES = 300
MAX_DOMAINS = 150


def addresses(value) -> list:
    """Every email address in a header value (a string or a list), lower case, in order, no names."""
    parts = value if isinstance(value, list) else [value]
    found: list = []
    for part in parts:
        if not isinstance(part, str):
            continue
        for hit in ADDRESS.findall(part.lower()):
            if hit not in found:
                found.append(hit)
    return found


def is_bulk(address: str) -> bool:
    return BULK_LOCAL.match(address.split("@", 1)[0]) is not None


def domain_of(address: str) -> str:
    return address.split("@", 1)[1]


def _iso(value) -> Optional[str]:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        when = datetime.fromisoformat(text)
    except ValueError:
        try:
            when = parsedate_to_datetime(value.strip())
        except (TypeError, ValueError, IndexError):
            return None
        if when is None:
            return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _later(a: Optional[str], b: Optional[str]) -> Optional[str]:
    return max(x for x in (a, b) if x) if (a or b) else None


def _blank() -> dict:
    return {"sent_to": 0, "received_from": 0, "threads": set(), "sent_threads": set(), "received_threads": set(), "last_seen": None}


def _note(table: dict, key: str, field: Optional[str], thread: str, date: Optional[str]) -> None:
    row = table.setdefault(key, _blank())
    if field:
        row[field] += 1
    row["threads"].add(thread)
    row["sent_threads" if field == "sent_to" else "received_threads"].add(thread)
    row["last_seen"] = _later(row["last_seen"], date)


def _counts(row: dict) -> dict:
    return {
        "sent_to": row["sent_to"],
        "received_from": row["received_from"],
        "threads": len(row["threads"]),
        "replied": len(row["received_threads"] & row["sent_threads"]),
        "last_seen": row["last_seen"],
    }


def _score(r: dict) -> tuple:
    return (r["sent_to"] * 3 + r["replied"] * 2 + r["received_from"], r["last_seen"] or "")


def _one(message: dict, mine: frozenset, people: dict, dropped: dict, index: int) -> None:
    labels = {str(x).upper() for x in (message.get("label_ids") or []) if isinstance(x, str)}
    if labels & SKIP_LABELS:
        dropped["skipped"] += 1
        return
    sender = addresses(message.get("from"))
    is_sent = "SENT" in labels or bool(sender and sender[0] in mine)
    if not is_sent and labels & BULK_CATEGORIES:
        dropped["category"] += 1
        return
    thread = str(message.get("thread_id") or f"message-{index}")
    date = _iso(message.get("date"))
    if is_sent:
        for addr in addresses(message.get("to")) + addresses(message.get("cc")):
            if addr not in mine and not is_bulk(addr):
                _note(people, addr, "sent_to", thread, date)
        return
    if not sender or sender[0] in mine:
        return
    if is_bulk(sender[0]):
        dropped["bulk"] += 1
        return
    _note(people, sender[0], "received_from", thread, date)


def _domains(people: dict) -> list:
    grouped: dict = {}
    for addr, row in people.items():
        dom = domain_of(addr)
        if dom in FREE_MAIL:
            continue
        g = grouped.setdefault(dom, {**_blank(), "people": 0})
        g["sent_to"] += row["sent_to"]
        g["received_from"] += row["received_from"]
        g["threads"] |= row["threads"]
        g["sent_threads"] |= row["sent_threads"]
        g["received_threads"] |= row["received_threads"]
        g["last_seen"] = _later(g["last_seen"], row["last_seen"])
        g["people"] += 1
    return [{"domain": d, **_counts(g), "people": g["people"]} for d, g in grouped.items()]


def aggregate(messages: Iterable[dict], account: str, me: Iterable[str] = (), days: int = 90,
              max_addresses: int = MAX_ADDRESSES, max_domains: int = MAX_DOMAINS, unreadable: int = 0) -> dict:
    """The report for `report_mail_contacts`: counts only, strongest first."""
    mine = frozenset([account.lower()] + [a for m in me for a in addresses(m)])
    people: dict = {}
    dropped = {"bulk": 0, "category": 0, "skipped": 0, "unreadable": unreadable}
    read = 0
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            dropped["unreadable"] += 1
            continue
        read += 1
        _one(message, mine, people, dropped, index)
    rows = [{"address": a, **_counts(r), "free_mail": domain_of(a) in FREE_MAIL} for a, r in people.items()]
    rows.sort(key=_score, reverse=True)
    doms = sorted(_domains(people), key=_score, reverse=True)
    return {
        "account": account.lower(),
        "days": days,
        "messages_read": read,
        "addresses": rows[:max_addresses],
        "domains": doms[:max_domains],
        "dropped": dropped,
    }


def _pick_key(value: str) -> str:
    return value.strip().lower().lstrip("@")


def choose(report: dict, picks: Iterable[str]) -> dict:
    """A copy of the report with `chosen` set on every row: true for the picks, false for the rest.

    A pick is a domain ("acme.example" or "@acme.example") or an address, any case.
    Raises ValueError naming any pick that is not in the report."""
    wanted = {_pick_key(p) for p in picks if isinstance(p, str) and p.strip()}
    known = {r["domain"] for r in report.get("domains", [])} | {r["address"] for r in report.get("addresses", [])}
    unknown = sorted(wanted - known)
    if unknown:
        raise ValueError(f"not in the report: {', '.join(unknown)}")
    return {
        **report,
        "addresses": [{**r, "chosen": r["address"] in wanted} for r in report.get("addresses", [])],
        "domains": [{**r, "chosen": r["domain"] in wanted} for r in report.get("domains", [])],
    }


def read_jsonl(path: str) -> tuple:
    messages, bad = [], 0
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                messages.append(json.loads(line))
            except json.JSONDecodeError:
                bad += 1
    return messages, bad


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mail_contacts.py", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    agg = sub.add_parser("aggregate", help="count a headers file into the report (printed as JSON)")
    agg.add_argument("--in", dest="path", required=True, help="the headers file, one JSON message per line")
    agg.add_argument("--account", required=True, help="the Gmail account address the headers came from")
    agg.add_argument("--me", action="append", default=[], help="another address of the owner's (repeatable)")
    agg.add_argument("--days", type=int, default=90, help="the window the headers cover (default 90)")
    cho = sub.add_parser("choose", help="mark the person's picks as chosen in a report (printed as JSON)")
    cho.add_argument("--report", required=True, help="the report `aggregate` printed, saved as a file")
    cho.add_argument("--pick", action="append", default=[], help="a domain or address the person wants (repeatable)")
    return parser


def _run_choose(args) -> int:
    try:
        with open(args.report, encoding="utf-8") as handle:
            report = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        print(f"suggest-rules: could not read the report ({type(error).__name__})", file=sys.stderr)
        return 1
    try:
        print(json.dumps(choose(report, args.pick), indent=1))
    except ValueError as error:
        print(f"suggest-rules: {error}", file=sys.stderr)
        return 2
    return 0


def main(argv: Optional[list] = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as stop:
        return int(stop.code or 0)
    if args.command == "choose":
        return _run_choose(args)
    account = args.account.strip().lower()
    if not ACCOUNT.match(account) or not 1 <= args.days <= 365:
        print("suggest-rules: --account must be an email address and --days 1 to 365", file=sys.stderr)
        return 2
    try:
        messages, bad = read_jsonl(args.path)
    except OSError as error:
        print(f"suggest-rules: could not read the headers file ({type(error).__name__})", file=sys.stderr)
        return 1
    report = aggregate(messages, account=account, me=args.me, days=args.days, unreadable=bad)
    print(json.dumps(report, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
