"""Record a puller run in `workspace.events` (run.started / run.finished).

Kept out of runner.py so the runner's own logic stays untouched. A wiki
write-back warning counts as a FAILED run: before this, a run that ingested but
could not write its wiki page was recorded as a plain success, and a meeting
went missing from the wiki for a week without anyone being told.
"""

from __future__ import annotations

from typing import Callable, TypeVar

from obs import events

SERVICE = "kb-engine"
R = TypeVar("R")


def observe(name: str, run_source: Callable[[], R], *, dry_run: bool = False, sink=None) -> R:
    """Run `run_source()` inside a run.started/run.finished pair and return its receipt."""
    if dry_run:
        return run_source()

    with events.run(SERVICE, f"puller-{name}", sink=sink) as handle:
        receipt = run_source()
        handle.attrs = {
            "ingest": receipt.ingest,
            "distilled": receipt.distilled,
            "distil_failed": receipt.distil_failed,
            "review_queued": receipt.review_queued,
            "hook": receipt.hook,
            "skipped": receipt.skipped,
        }
        wiki_error = receipt.hook.get("wiki_error")
        if receipt.skipped:
            # A skip is by design (the run stays ok), but it must not be as
            # quiet as the wiki miss was: one warn event per run, same run_id.
            events.emit(SERVICE, f"puller-{name}", "payload.skipped", level="warn", sink=sink,
                        run_id=handle.run_id,
                        attrs={"count": len(receipt.skipped), "skipped": receipt.skipped})
        if receipt.error:
            handle.fail(receipt.error)
        elif wiki_error:
            handle.fail(f"wiki {wiki_error}")
        elif receipt.stood_down:
            handle.skip()
    return receipt
