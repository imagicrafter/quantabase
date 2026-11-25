"""Prove the local and remote embedding backends occupy the same vector space.

Run this ONCE, before routing any production write through the remote backend,
and again after any change to either backend.

    cd <workspace>/scripts
    ../.venv/bin/python -m knowledge.verify_embedding_alignment

Why it matters
--------------
`workspace.documents.embedding` holds vectors produced on a developer machine by torch
sentence-transformers. If the agent host writes vectors from the Deno
`Supabase.ai.Session("gte-small")` runtime and the two spaces differ even
slightly, every cosine between a locally written row and a remotely written row is
wrong. Nothing errors. Retrieval just quietly gets worse, and the cause is
invisible at the call site.

The threshold
-------------
0.99, not the 0.999 the plan originally specified. These are two independent
implementations of one model -- different tokenizer builds, different pooling
and normalisation code paths, float32 vs whatever the runtime uses internally.
Published comparisons of that class of reimplementation typically land in
0.995-0.999, so 0.999 is inside the noise band and would fail for reasons that
say nothing about correctness.

What a near miss means, decided in advance so it is not decided under pressure:

  >= 0.99   backends agree. Remote is safe for production writes.
  < 0.99    do NOT loosen this number. The two spaces are genuinely different.
            The fix is to make ONE space authoritative: re-embed all 857 rows
            through the remote backend and use remote everywhere, including on
            the developer machine. A mixed corpus is the outcome to avoid, not a middle ground.

Sample
------
Real `documents.distillation` values, not lorem ipsum. Distillations are what
actually gets embedded (see contract.py), so they are the distribution that
matters. Falls back to a fixed literal sample if the database is unreachable, so
the gate still runs offline -- the fallback is clearly less meaningful and says
so in the output.
"""

from __future__ import annotations

import math
import sys

from .embedder import EmbeddingError, embed_texts
from .kb_schema import db

SAMPLE_SIZE = 20
THRESHOLD = 0.99

# Used only when the database cannot be reached. Shaped like real distillations
# -- a WHAT sentence and a WHY sentence -- but no substitute for the real thing.
FALLBACK_SAMPLE = [
    "Imports run from the in-app import page. "
    "The browser extension path was retired because it skipped validation.",
    "The delivery schedule is one customer's view of the shared product plan. "
    "Naming matters because the customer and the partner use different names.",
    "Jobs must be started one at a time. Parallel runs corrupt "
    "the runner's shared database, which is a single file.",
    "Budget decisions go through the decision tool, never a hand edit. "
    "Hand-editing the decision log desynchronises the totals and open actions.",
    "The read-only role does not pass row level security. A grant without a "
    "matching policy returns zero rows, which reads as no data rather than no access.",
    "The database project is shared with another application. Every statement must "
    "name its schema or it risks touching the other application's tables.",
    "Meeting transcripts are stored separately from meeting summaries. Summaries "
    "are curated wiki pages; transcripts are raw speaker-attributed text.",
    "Mail is indexed by label. Adding a label to a thread is the whole "
    "configuration; no code change is needed.",
    "A deployed job cannot run the local model. The package is installed only on a "
    "developer machine, which is why the jobs call an embedding endpoint.",
    "The wiki checkout is a clone, not a link. A job that writes pages must "
    "push them or the next run starts without them.",
    "Distillation is WHAT, WHY and TERMS. Every term must appear verbatim in the "
    "source, because fabricated terms poison keyword retrieval.",
    "Drive Sheets and Slides expose no extractable body text. Their distillation "
    "is the only searchable text they have.",
    "Provenance is four separate columns, never one score. Only human-verified is "
    "a different question from only recent.",
    "Raw capture covers fetched sources only. Git is already the wiki's immutable raw "
    "layer, so duplicating it would be storage for nothing.",
    "A model may propose a topic label but the tags decide. Topics gate readership, "
    "so a model widening one is an access control failure.",
    "Rejections are keyed to content hash with three verbs. Without the hash key a "
    "rejected row is re-proposed on every run forever.",
    "A tag is a prefix plus a topic id. A tag that names no topic leaves the "
    "document visible to its owner only.",
    "The setup code is shown once and stored only as a hash. A lost code is "
    "replaced by making a new one.",
    "A full sync reads everything each run. A document missing from the run is "
    "treated as removed at the source.",
    "The status page shows each source's last run. A source that has not run "
    "within a day is marked late.",
]


def cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity. Both backends normalise, but do not assume it."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0.0 or norm_b == 0.0:
        raise ValueError("Zero-magnitude vector; cannot compute cosine.")
    return dot / (norm_a * norm_b)


def load_sample() -> tuple[list[str], bool]:
    """Return (texts, from_database). Falls back to literals if unreachable."""
    try:
        from .supabase_client import get_supabase

        supabase = get_supabase()
        response = (
            db(supabase)
            .table("documents")
            .select("distillation")
            .not_.is_("distillation", "null")
            .limit(SAMPLE_SIZE)
            .execute()
        )
        texts = [
            row["distillation"]
            for row in (response.data or [])
            if isinstance(row.get("distillation"), str) and row["distillation"].strip()
        ]
        if len(texts) >= 5:
            return texts[:SAMPLE_SIZE], True
        print(
            f"[align] Only {len(texts)} usable distillations in the database "
            "-- falling back to the literal sample.",
            file=sys.stderr,
        )
    except Exception as error:
        print(f"[align] Could not read distillations ({error}).", file=sys.stderr)

    return FALLBACK_SAMPLE[:SAMPLE_SIZE], False


def main() -> int:
    texts, from_database = load_sample()

    source = "documents.distillation" if from_database else "FALLBACK literals"
    print(f"[align] Sample: {len(texts)} texts from {source}")
    if not from_database:
        print(
            "[align] WARNING: the fallback sample is not the real distribution. "
            "A pass here is weaker evidence than a pass on real distillations."
        )

    try:
        print("[align] Embedding via local backend...")
        local = embed_texts(texts, backend="local")
        print("[align] Embedding via remote backend...")
        remote = embed_texts(texts, backend="remote")
    except EmbeddingError as error:
        print(f"[align] FAILED: {error}", file=sys.stderr)
        return 2

    # Magnitude first. Cosine is scale-invariant, so it CANNOT see a backend that
    # stopped normalising -- on 2026-08-13 the local path returned norm ~9.1 while
    # remote returned 1.0, and the cosine check passed at 0.999999 regardless.
    # Harmless under `<=>` ranking, silently wrong the day anything uses `<#>`.
    norm_failures = []
    for label, vectors in (("local", local), ("remote", remote)):
        for index, vector in enumerate(vectors):
            magnitude = math.sqrt(sum(x * x for x in vector))
            if abs(magnitude - 1.0) > 1e-3:
                norm_failures.append((label, index, magnitude))

    if norm_failures:
        print()
        print(f"[align] FAILED -- {len(norm_failures)} non-unit vectors:")
        for label, index, magnitude in norm_failures[:10]:
            print(f"  {label}[{index}] norm = {magnitude:.6f}")
        print(
            "\n[align] The backends disagree on normalisation. Cosine ranking hides\n"
            "        this; inner-product ranking would not. Fix the backend, not\n"
            "        this check."
        )
        return 1

    similarities = [cosine(a, b) for a, b in zip(local, remote)]
    worst = min(similarities)
    mean = sum(similarities) / len(similarities)

    print()
    print("[align] unit norm    OK (both backends)")
    print(f"[align] mean cosine  {mean:.6f}")
    print(f"[align] worst cosine {worst:.6f}")
    print(f"[align] threshold    {THRESHOLD}")
    print()

    failures = [
        (index, score) for index, score in enumerate(similarities) if score < THRESHOLD
    ]

    if failures:
        print(f"[align] FAILED -- {len(failures)} of {len(texts)} below threshold:")
        for index, score in failures:
            preview = texts[index][:80].replace("\n", " ")
            print(f"  [{index:2d}] {score:.6f}  {preview}...")
        print()
        print(
            "[align] Do NOT lower the threshold. The two backends occupy different\n"
            "        vector spaces. Make one authoritative instead: re-embed every\n"
            "        row through the remote backend and use remote everywhere,\n"
            "        including on a developer machine. A mixed corpus is the outcome to avoid."
        )
        return 1

    print("[align] PASSED -- the backends agree. Remote is safe for production writes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
