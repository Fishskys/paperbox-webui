"""Backend tests for the paperbox WebUI proxy layer (SPEC section 5).

Every test fakes paperbox with :class:`httpx.MockTransport`, so nothing here
needs a live service or network access.
"""

from __future__ import annotations

import json
from collections.abc import Callable

import httpx
import pytest
from fastapi.testclient import TestClient

from webui.client import PaperboxClient
from webui.config import Settings
from webui.main import create_app

Handler = Callable[[httpx.Request], httpx.Response]

HEALTH_BODY = {
    "status": "ok",
    "version": "0.1.0",
    "services": {
        "postgres": "ok",
        "opensearch": "ok",
        "minio": "ok",
        "embedding": "ok",
    },
}


def build_client(handler: Handler) -> PaperboxClient:
    settings = Settings(
        paperbox_api_base="http://paperbox.test",
        paperbox_api_key="test-key",
        request_timeout=5.0,
    )
    return PaperboxClient(settings, transport=httpx.MockTransport(handler))


def build_app(handler: Handler) -> tuple[TestClient, list[httpx.Request]]:
    """Return a TestClient with the mock client injected plus the seen requests."""
    seen: list[httpx.Request] = []

    def recording_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    app = create_app()
    app.state.paperbox = build_client(recording_handler)
    # No context manager: the lifespan must not run, we inject our own client.
    return TestClient(app), seen


def ok_json(payload: object) -> httpx.Response:
    return httpx.Response(200, json=payload)


# --------------------------------------------------------------------------- #
# /api/ui/health
# --------------------------------------------------------------------------- #


def test_health_aggregates_paperbox_state_and_counts() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return ok_json(HEALTH_BODY)
        if request.url.path == "/api/papers":
            return ok_json({"total": 4, "limit": 20, "offset": 0, "papers": []})
        if request.url.path == "/api/jobs":
            return ok_json({"total": 7, "jobs": []})
        return httpx.Response(404, json={"detail": "unexpected"})

    client, seen = build_app(handler)
    response = client.get("/api/ui/health")

    assert response.status_code == 200
    body = response.json()
    assert body["paperbox"] == HEALTH_BODY["services"]
    assert body["version"] == "0.1.0"
    assert body["papers"] == 4
    assert body["jobs"] == 7
    assert {request.url.path for request in seen} == {"/health", "/api/papers", "/api/jobs"}


def test_health_sends_bearer_token() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return ok_json(HEALTH_BODY)
        return ok_json({"total": 0})

    client, seen = build_app(handler)
    client.get("/api/ui/health")

    assert seen, "no request reached paperbox"
    assert seen[0].headers["authorization"] == "Bearer test-key"


def test_health_degrades_when_paperbox_is_unreachable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    client, _ = build_app(handler)
    response = client.get("/api/ui/health")

    assert response.status_code == 200
    body = response.json()
    assert "error" in body["paperbox"]
    assert body["papers"] is None
    assert body["jobs"] is None


def test_health_reports_paperbox_error_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(503, json={"detail": "starting"})
        return httpx.Response(500, json={"detail": "boom"})

    client, _ = build_app(handler)
    body = client.get("/api/ui/health").json()

    assert "returned 503" in body["paperbox"]["error"]
    assert body["papers"] is None
    assert body["jobs"] is None


# --------------------------------------------------------------------------- #
# /api/ui/papers
# --------------------------------------------------------------------------- #


def test_papers_list_forwards_pagination_and_filters() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json(
            {
                "total": 1,
                "limit": 5,
                "offset": 10,
                "papers": [{"paper_id": "p1", "title": "T"}],
            }
        )

    client, seen = build_app(handler)
    response = client.get(
        "/api/ui/papers",
        params={"limit": 5, "offset": 10, "status": "INDEXED", "q": "bert"},
    )

    assert response.status_code == 200
    assert response.json()["total"] == 1
    request = seen[0]
    assert request.url.path == "/api/papers"
    assert request.url.params["limit"] == "5"
    assert request.url.params["offset"] == "10"
    assert request.url.params["status"] == "INDEXED"
    assert request.url.params["q"] == "bert"


def test_paper_detail_404_is_passed_through() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"detail": "paper not found"})

    client, _ = build_app(handler)
    response = client.get("/api/ui/papers/does-not-exist")

    assert response.status_code == 404
    assert response.json() == {"detail": "paper not found"}


def test_unreachable_paperbox_becomes_502() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    client, _ = build_app(handler)
    response = client.get("/api/ui/papers")

    assert response.status_code == 502
    assert response.json()["detail"].startswith("paperbox unreachable")


def test_chunks_pagination_is_forwarded() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json({"paper_id": "p1", "total": 42, "chunks": []})

    client, seen = build_app(handler)
    response = client.get("/api/ui/papers/p1/chunks", params={"limit": 20, "offset": 40})

    assert response.status_code == 200
    assert response.json()["total"] == 42
    assert seen[0].url.path == "/api/papers/p1/chunks"
    assert seen[0].url.params["limit"] == "20"
    assert seen[0].url.params["offset"] == "40"


def test_paper_file_is_streamed_with_headers() -> None:
    pdf_bytes = b"%PDF-1.5 fake pdf content"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=pdf_bytes,
            headers={
                "content-type": "application/pdf",
                "content-disposition": 'attachment; filename="paper.pdf"',
            },
        )

    client, seen = build_app(handler)
    response = client.get("/api/ui/papers/p1/file")

    assert response.status_code == 200
    assert response.content == pdf_bytes
    assert response.headers["content-type"] == "application/pdf"
    assert "paper.pdf" in response.headers["content-disposition"]
    assert seen[0].url.path == "/api/papers/p1/file"


def test_paper_file_error_is_passed_through() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"detail": "paper file not found"})

    client, _ = build_app(handler)
    response = client.get("/api/ui/papers/p1/file")

    assert response.status_code == 404
    assert response.json() == {"detail": "paper file not found"}


# --------------------------------------------------------------------------- #
# /api/ui/search
# --------------------------------------------------------------------------- #


def test_search_body_is_forwarded_verbatim() -> None:
    payload = {
        "query": "low power SRAM",
        "mode": "hybrid",
        "top_k": 5,
        "filters": {"year_from": 2015, "year_to": 2026, "authors": ["A. Author"]},
    }
    paperbox_result = {
        "query": payload["query"],
        "mode": "hybrid",
        "total": 1,
        "took_ms": 12.5,
        "results": [{"paper_id": "p1", "title": "T", "score": 1.0, "relevance": "high"}],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json(paperbox_result)

    client, seen = build_app(handler)
    response = client.post("/api/ui/search", json=payload)

    assert response.status_code == 200
    assert response.json() == paperbox_result
    assert seen[0].url.path == "/api/search"
    assert json.loads(seen[0].content) == payload


def test_search_error_is_passed_through() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"detail": [{"loc": ["body", "query"], "msg": "required"}]})

    client, _ = build_app(handler)
    response = client.post("/api/ui/search", json={"mode": "hybrid"})

    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == "required"


# --------------------------------------------------------------------------- #
# /api/ui/ingest
# --------------------------------------------------------------------------- #


def test_ingest_url_accepts_paperbox_payload_and_translates_it() -> None:
    """The browser sends {source_type, source}; the backend must accept it."""
    accepted = {
        "job_id": "job-1",
        "paper_id": None,
        "status": "RECEIVED",
        "stage": "RECEIVED",
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, json=accepted)

    client, seen = build_app(handler)
    response = client.post(
        "/api/ui/ingest",
        json={"source_type": "url", "source": "https://arxiv.org/pdf/1706.03762"},
    )

    assert response.status_code == 202
    assert response.json()["job_id"] == "job-1"
    assert seen[0].url.path == "/api/papers/ingest"
    assert json.loads(seen[0].content) == {
        "source_type": "url",
        "source": "https://arxiv.org/pdf/1706.03762",
    }


def test_ingest_url_accepts_url_shorthand() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, json={"job_id": "job-9", "status": "RECEIVED"})

    client, seen = build_app(handler)
    response = client.post("/api/ui/ingest", json={"url": "https://example.org/paper.pdf"})

    assert response.status_code == 202
    assert json.loads(seen[0].content)["source"] == "https://example.org/paper.pdf"
    assert json.loads(seen[0].content)["source_type"] == "url"


def test_ingest_url_rejects_missing_source() -> None:
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        return httpx.Response(500)

    client, seen = build_app(handler)
    response = client.post("/api/ui/ingest", json={"source_type": "url"})

    assert response.status_code == 422
    assert "required" in response.json()["detail"]
    assert seen == [], "nothing should be sent to paperbox"


def test_ingest_url_rejects_unsupported_source_type() -> None:
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        return httpx.Response(500)

    client, seen = build_app(handler)
    response = client.post("/api/ui/ingest", json={"source_type": "doi", "source": "10.1/x"})

    assert response.status_code == 422
    assert "source_type" in response.json()["detail"]
    assert seen == []


def test_ingest_file_uploads_multipart() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, json={"job_id": "job-2", "status": "RECEIVED"})

    client, seen = build_app(handler)
    response = client.post(
        "/api/ui/ingest/file",
        files={"file": ("local-paper.pdf", b"%PDF-1.5 local bytes", "application/pdf")},
    )

    assert response.status_code == 202
    assert response.json()["job_id"] == "job-2"
    request = seen[0]
    assert request.url.path == "/api/papers/ingest/file"
    assert request.headers["content-type"].startswith("multipart/form-data")
    assert b"local-paper.pdf" in request.content
    assert b"%PDF-1.5 local bytes" in request.content


# --------------------------------------------------------------------------- #
# /api/ui/jobs and actions
# --------------------------------------------------------------------------- #


def test_jobs_list_forwards_limit_and_paper_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json({"total": 2, "jobs": [{"job_id": "j1", "stage": "COMPLETED"}]})

    client, seen = build_app(handler)
    response = client.get("/api/ui/jobs", params={"limit": 2, "paper_id": "p1"})

    assert response.status_code == 200
    assert response.json()["total"] == 2
    assert seen[0].url.path == "/api/jobs"
    assert seen[0].url.params["limit"] == "2"
    assert seen[0].url.params["paper_id"] == "p1"


def test_job_detail_is_proxied() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json({"job_id": "j1", "stage": "EMBEDDING", "progress": 80.0})

    client, seen = build_app(handler)
    body = client.get("/api/ui/jobs/j1").json()

    assert body["stage"] == "EMBEDDING"
    assert seen[0].url.path == "/api/jobs/j1"


def test_reindex_action_returns_job_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, json={"job_id": "job-3", "paper_id": "p1"})

    client, seen = build_app(handler)
    response = client.post("/api/ui/papers/p1/reindex")

    assert response.status_code == 202
    assert response.json()["job_id"] == "job-3"
    assert seen[0].method == "POST"
    assert seen[0].url.path == "/api/papers/p1/reindex"


def test_delete_action_reports_success_without_body() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(204)

    client, seen = build_app(handler)
    response = client.delete("/api/ui/papers/p1")

    assert response.status_code in (200, 204)
    if response.status_code != 204 and response.content:
        assert response.json().get("ok") is True
    assert seen[0].method == "DELETE"
    assert seen[0].url.path == "/api/papers/p1"


# --------------------------------------------------------------------------- #
# index shell
# --------------------------------------------------------------------------- #


def test_index_serves_html_shell() -> None:
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        return httpx.Response(500)

    client, _ = build_app(handler)
    response = client.get("/")

    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
