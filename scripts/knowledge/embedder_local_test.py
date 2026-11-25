"""The local embedding backend lives in this repository."""

from __future__ import annotations

import sys
import types

import pytest

from knowledge import embedder, search
from knowledge.config import EMBEDDING_DIM


class _Model:
    def __init__(self, name):
        self.name = name

    def encode(self, texts, show_progress_bar=False):
        return [[3.0] + [0.0] * (EMBEDDING_DIM - 1) for _ in texts]


@pytest.fixture
def fake_package(monkeypatch):
    module = types.ModuleType("sentence_transformers")
    module.SentenceTransformer = _Model
    monkeypatch.setitem(sys.modules, "sentence_transformers", module)
    monkeypatch.setattr(embedder, "_local_model", None)


def test_local_backend_loads_the_model_itself_and_normalises(fake_package) -> None:
    vectors = embedder.embed_texts(["a", "b"], backend="local")
    assert len(vectors) == 2 and len(vectors[0]) == EMBEDDING_DIM
    assert vectors[0][0] == pytest.approx(1.0)
    assert embedder._local_model.name == embedder.LOCAL_MODEL_ID


def test_a_missing_package_is_a_clear_error(monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "sentence_transformers", None)
    monkeypatch.setattr(embedder, "_local_model", None)
    with pytest.raises(embedder.EmbeddingError, match="KNOWLEDGE_EMBED_BACKEND=remote"):
        embedder.embed_texts(["a"], backend="local")


def test_search_embeds_through_the_configured_backend(monkeypatch) -> None:
    monkeypatch.setattr(embedder, "embed_texts", lambda texts, backend=None: [[0.5]])
    assert search._embed_query("hello") == [0.5]

    def refuse(texts, backend=None):
        raise embedder.EmbeddingError("no backend")

    monkeypatch.setattr(embedder, "embed_texts", refuse)
    with pytest.raises(search.SearchError, match="no backend"):
        search._embed_query("hello")


def test_a_missing_model_package_is_a_configuration_error(monkeypatch) -> None:
    from knowledge import model_backends

    monkeypatch.setitem(sys.modules, "anthropic", None)
    with pytest.raises(model_backends.BackendError, match="anthropic package"):
        model_backends.call_model("p", backend="anthropic", model="m")


def test_the_job_requirements_list_what_a_deployed_backend_imports() -> None:
    from pathlib import Path

    listed = Path(__file__).resolve().parents[2].joinpath("pullers", "requirements.txt").read_text()
    names = {line.split(">=")[0].strip().lower() for line in listed.splitlines()
             if line.strip() and not line.startswith("#")}
    assert {"anthropic", "requests", "pyyaml", "pyjwt", "supabase", "python-dotenv",
            "google-api-python-client", "google-auth-oauthlib"} <= names
    assert "sentence-transformers" not in names, "too large for a job container"
