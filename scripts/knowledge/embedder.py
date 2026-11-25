"""Backend-agnostic embedding.

Two backends produce the same 384-dim gte-small vectors:

  local   -- the sentence-transformers package, loaded here on first use. A
             developer machine only; the package is not in the job requirements.
  remote  -- the `embed` edge function (supabase/functions/embed/index.ts),
             authenticated with a bearer token resolved against
             workspace.principals.

Callers should not care which is in use: they import from here, so the same
code runs on a developer machine and on a deployed job.

The two backends must agree. `verify_embedding_alignment.py` is the gate that
proves it; nothing should route production writes through `remote` until it has
passed. If the backends silently diverge, every cross-backend cosine is wrong and
retrieval degrades in a way no error surfaces.

Credentials are read from the local settings file with `dotenv_values`;
nothing is taken from the process environment.
"""

from __future__ import annotations

import json
import math
import urllib.error
import urllib.request
from pathlib import Path
from typing import Literal

from knowledge.env_file import read as read_env_file

from .config import EMBEDDING_DIM

Backend = Literal["local", "remote"]

# The same gte-small weights the `embed` edge function runs.
LOCAL_MODEL_ID = "Supabase/gte-small"

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent.parent
ENV_PATH = WORKSPACE_ROOT / ".env"

# Must not exceed MAX_TEXTS in supabase/functions/embed/index.ts (12, measured).
# Set below it because the edge runtime's ceiling is a function of total work, not
# text count: a batch of long documents exhausts the CPU budget at a count short
# texts survive. `_post_adaptive` halves on 546 to cover the rest.
REMOTE_MAX_BATCH = 8
REMOTE_TIMEOUT_SECONDS = 120

# Supabase edge runtime resource ceiling. Not our bug and not retryable as-is --
# the batch must get smaller.
HTTP_RESOURCE_LIMIT = 546

# Both backends must return unit vectors. Generous enough for float32 rounding,
# tight enough to catch a backend that stopped normalising (the observed local
# norm was ~9.1, not 1.0001).
UNIT_NORM_TOLERANCE = 1e-3


class EmbeddingError(RuntimeError):
    """Embedding could not be produced. Never returns a partial batch."""


class _ResourceLimit(Exception):
    """Internal: the edge runtime refused the batch as too much work.

    Not part of the public API. Callers see either vectors or EmbeddingError.
    """


def _env() -> dict[str, str | None]:
    if not ENV_PATH.exists():
        raise EmbeddingError(
            f"No .env at {ENV_PATH}. The remote embedding backend needs "
            "KNOWLEDGE_EMBED_URL and KNOWLEDGE_EMBED_TOKEN."
        )
    return read_env_file(ENV_PATH)


def get_backend() -> Backend:
    """Resolve the configured backend, defaulting to local.

    Set KNOWLEDGE_EMBED_BACKEND=remote wherever sentence-transformers is
    not installed (every deployed job).
    """
    if not ENV_PATH.exists():
        return "local"

    value = (read_env_file(ENV_PATH).get("KNOWLEDGE_EMBED_BACKEND") or "local").strip().lower()
    if value not in ("local", "remote"):
        raise EmbeddingError(
            f"KNOWLEDGE_EMBED_BACKEND must be 'local' or 'remote', got {value!r}."
        )
    return value  # type: ignore[return-value]


def _validate(vectors: list[list[float]], expected: int) -> list[list[float]]:
    """Assert shape before anything is written or compared.

    A wrong dimension reaches the database as a pgvector insert error far from
    here; a short batch silently misaligns texts with vectors, which is worse
    because it never errors at all.
    """
    if len(vectors) != expected:
        raise EmbeddingError(
            f"Backend returned {len(vectors)} vectors for {expected} texts. "
            "Refusing a misaligned batch."
        )
    for index, vector in enumerate(vectors):
        if len(vector) != EMBEDDING_DIM:
            raise EmbeddingError(
                f"Vector {index} has {len(vector)} dimensions, expected {EMBEDDING_DIM}."
            )
        # Both backends must emit unit vectors -- see _normalize. Cosine ranking
        # hides a magnitude mismatch, so it is asserted here rather than left to
        # be discovered by a future switch to inner-product ranking.
        magnitude = math.sqrt(sum(x * x for x in vector))
        if abs(magnitude - 1.0) > UNIT_NORM_TOLERANCE:
            raise EmbeddingError(
                f"Vector {index} has norm {magnitude:.6f}, expected 1.0. "
                "The backends have diverged on normalisation."
            )
    return vectors


# --- local -------------------------------------------------------------------


def _normalize(vector: list[float]) -> list[float]:
    """Scale to unit length.

    MEASURED 2026-08-13: the local sentence-transformers path returns vectors with
    a norm around 9.1, while the edge runtime normalises to 1.0. Direction agrees
    to a cosine of 0.999999 -- the two backends genuinely concur -- but magnitude
    does not.

    That is harmless *today*: `documents_search` ranks with `<=>` and the HNSW
    index is `vector_cosine_ops` (0001_documents_table.sql:93), both scale-
    invariant. It is a trap tomorrow, because a switch to inner product (`<#>`) --
    the usual optimisation once vectors are known to be unit-length -- would
    silently rank a mixed-magnitude column wrong, with no error anywhere.

    So this module normalises here rather than relying on the operator
    staying cosine forever. Rows written before this was added remain
    cosine-equivalent and need no backfill.
    """
    magnitude = math.sqrt(sum(x * x for x in vector))
    if magnitude == 0.0:
        raise EmbeddingError("Local backend returned a zero vector; cannot normalise.")
    return [x / magnitude for x in vector]


_local_model = None


def _load_local_model():
    """The local model, loaded once. Needs `sentence-transformers`.

    That package is deliberately not in `pullers/requirements.txt` (it does
    not fit a small job container); install it yourself to use the local
    backend, or set KNOWLEDGE_EMBED_BACKEND=remote.
    """
    global _local_model
    if _local_model is None:
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as error:
            raise EmbeddingError(
                "The local backend needs the sentence-transformers package, "
                "which is not installed. Install it, or set "
                "KNOWLEDGE_EMBED_BACKEND=remote."
            ) from error
        _local_model = SentenceTransformer(LOCAL_MODEL_ID)
    return _local_model


def _embed_local(texts: list[str]) -> list[list[float]]:
    try:
        encoded = _load_local_model().encode(texts, show_progress_bar=False)
        return [_normalize([float(x) for x in vector]) for vector in encoded]
    except EmbeddingError:
        raise
    except Exception as error:
        raise EmbeddingError(f"Local embedding failed: {type(error).__name__}") from error


# --- remote ------------------------------------------------------------------


def _remote_config() -> tuple[str, str]:
    values = _env()
    url = (values.get("KNOWLEDGE_EMBED_URL") or "").strip()
    token = (values.get("KNOWLEDGE_EMBED_TOKEN") or "").strip()

    missing = [
        name
        for name, value in (
            ("KNOWLEDGE_EMBED_URL", url),
            ("KNOWLEDGE_EMBED_TOKEN", token),
        )
        if not value
    ]
    if missing:
        raise EmbeddingError(
            f"Missing {', '.join(missing)} in {ENV_PATH}. Mint a token with "
            "scripts/knowledge/mint_token.py and store its plaintext here; the "
            "database holds only the SHA-256 hash."
        )
    return url, token


def _post(url: str, token: str, texts: list[str]) -> list[list[float]]:
    payload = json.dumps({"texts": texts}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=REMOTE_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            detail = json.loads(error.read().decode("utf-8")).get("detail", "")
        except Exception:
            pass
        if error.code == HTTP_RESOURCE_LIMIT:
            # Signalled, not raised: _post_adaptive splits the batch and retries.
            raise _ResourceLimit() from error
        if error.code == 401:
            raise EmbeddingError(
                f"Embedding endpoint rejected the token (401). {detail} "
                "Check KNOWLEDGE_EMBED_TOKEN is the plaintext whose hash is an "
                "ACTIVE row in the principals table."
            ) from error
        raise EmbeddingError(
            f"Embedding endpoint returned HTTP {error.code}. {detail}"
        ) from error
    except urllib.error.URLError as error:
        raise EmbeddingError(f"Could not reach the embedding endpoint: {error.reason}") from error

    embeddings = body.get("embeddings")
    if not isinstance(embeddings, list):
        raise EmbeddingError("Embedding endpoint returned no `embeddings` array.")
    return embeddings


def _post_adaptive(url: str, token: str, texts: list[str]) -> list[list[float]]:
    """POST a batch, halving it on 546 until it fits or a single text fails.

    The edge runtime's ceiling is total work, not text count -- a batch of long
    documents exhausts it at a size short ones survive. Splitting is the only
    correct response: a plain retry sends the same too-large batch again.

    A single text that still 546s cannot be split further and is a real error.
    """
    try:
        return _validate(_post(url, token, texts), len(texts))
    except _ResourceLimit:
        if len(texts) == 1:
            preview = texts[0][:120].replace("\n", " ")
            raise EmbeddingError(
                "The embedding endpoint hit its resource ceiling on a SINGLE text "
                f"({len(texts[0])} chars), so the batch cannot be split further. "
                f"Text begins: {preview!r}"
            ) from None

        middle = len(texts) // 2
        left = _post_adaptive(url, token, texts[:middle])
        right = _post_adaptive(url, token, texts[middle:])
        return left + right


def _embed_remote(texts: list[str]) -> list[list[float]]:
    url, token = _remote_config()

    vectors: list[list[float]] = []
    for start in range(0, len(texts), REMOTE_MAX_BATCH):
        chunk = texts[start : start + REMOTE_MAX_BATCH]
        vectors.extend(_post_adaptive(url, token, chunk))
    return vectors


# --- public API --------------------------------------------------------------


def embed_texts(texts: list[str], backend: Backend | None = None) -> list[list[float]]:
    """Embed a batch. Returns one 384-dim vector per input, in order."""
    if not texts:
        return []

    resolved = backend or get_backend()
    if resolved == "remote":
        return _embed_remote(texts)
    return _validate(_embed_local(texts), len(texts))


def embed_query(text: str, backend: Backend | None = None) -> list[float]:
    """Embed a single query string. Returns a 384-dim vector."""
    if not text or not text.strip():
        raise EmbeddingError("Cannot embed an empty query.")
    return embed_texts([text], backend=backend)[0]
