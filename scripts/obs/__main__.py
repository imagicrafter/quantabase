"""CLI for shell callers (scheduled jobs):

    python -m obs emit --service agents --component kb-health --event health.fixed \\
        --status ok --attr rule=meeting-links --attr fixed=2
"""

from __future__ import annotations

import argparse
import sys

from obs import events


def _attrs(pairs: list[str]) -> dict:
    out: dict = {}
    for pair in pairs:
        key, sep, value = pair.partition("=")
        if not sep or not key:
            raise events.EventError(f"--attr {pair!r} must be key=value")
        out = {**out, key: value}
    return out


def main(argv: list[str] | None = None, *, sink=None) -> int:
    parser = argparse.ArgumentParser(prog="obs")
    sub = parser.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("emit")
    e.add_argument("--service", required=True)
    e.add_argument("--component", required=True)
    e.add_argument("--event", required=True)
    e.add_argument("--level", default="info")
    e.add_argument("--status")
    e.add_argument("--run-id")
    e.add_argument("--duration-ms", type=int)
    e.add_argument("--attr", action="append", default=[])
    args = parser.parse_args(argv)

    try:
        attrs = _attrs(args.attr)
    except events.EventError as error:
        print(f"obs: {error}", file=sys.stderr)
        return 2
    events.emit(
        args.service, args.component, args.event,
        level=args.level, status=args.status, run_id=args.run_id,
        duration_ms=args.duration_ms, commit=events.current_commit(),
        attrs=attrs, sink=sink,
    )
    return 0  # logging never fails the calling script


if __name__ == "__main__":
    sys.exit(main())
