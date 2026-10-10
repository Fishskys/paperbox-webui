"""Backend tests for the paperbox WebUI proxy layer (SPEC section 5).

Every test fakes paperbox with :class:`httpx.MockTransport`, so nothing here
needs a live service or network access.
"""

from __future__ import annotations

import asyncio
import io
import json
import re
import shutil
import subprocess
from collections.abc import Callable

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.datastructures import Headers, UploadFile

from webui.client import PaperboxClient
from webui.config import REPO_ROOT, Settings, get_settings
from webui.main import create_app
from webui.routers import ingest as ingest_routes
from webui.routers import metadata as metadata_routes

Handler = Callable[[httpx.Request], httpx.Response]
JS_TEST_DIR = REPO_ROOT / "tests" / "js"


class _RecordingStream(io.BytesIO):
    """Stand-in for ``UploadFile.file`` that notices a whole-file ``read()``."""

    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.whole_reads = 0
        self.chunk_reads = 0

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            self.whole_reads += 1
        else:
            self.chunk_reads += 1
        return super().read(size)

HEALTH_BODY = {
    "status": "ok",
    "version": "0.1.0",
    "services": {
        "postgres": "ok",
        "opensearch": "ok",
        "minio": "ok",
        "embedding": "ok",
        # 解析后端：paperbox 配了 DOCLING_URL 就探，没配报 disabled（不是 error）
        "docling": "ok",
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
# /api/ui/ingest/files (multi-file proxy)
# --------------------------------------------------------------------------- #


def test_ingest_files_proxies_every_part() -> None:
    """Two files in, one multipart request out, per-file results straight back."""
    results = {
        "request_id": "req-1",
        "accepted": 2,
        "duplicate": 0,
        "rejected": 0,
        "results": [
            {"filename": "a.pdf", "status": "accepted", "job_id": "job-a", "paper_id": None},
            {"filename": "b.pdf", "status": "accepted", "job_id": "job-b", "paper_id": None},
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, json=results)

    client, seen = build_app(handler)
    response = client.post(
        "/api/ui/ingest/files",
        files=[
            ("files", ("a.pdf", b"%PDF-1.5 aaa", "application/pdf")),
            ("files", ("b.pdf", b"%PDF-1.5 bbb", "application/pdf")),
        ],
    )

    assert response.status_code == 202
    assert response.json() == results
    request = seen[0]
    assert request.url.path == "/api/papers/ingest/files"
    assert request.headers["content-type"].startswith("multipart/form-data")
    body = request.content
    assert body.count(b'name="files"') == 2
    for name, payload in ((b"a.pdf", b"%PDF-1.5 aaa"), (b"b.pdf", b"%PDF-1.5 bbb")):
        assert name in body
        assert payload in body


def test_ingest_files_passes_the_busy_signal_through() -> None:
    """429 + Retry-After is the contract the upload queue backs off on."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            json={"detail": "server busy: uploads in flight; retry after 2s"},
            headers={"Retry-After": "2"},
        )

    client, seen = build_app(handler)
    response = client.post(
        "/api/ui/ingest/files",
        files=[("files", ("a.pdf", b"%PDF-1.5 aaa", "application/pdf"))],
    )

    assert seen[0].url.path == "/api/papers/ingest/files"
    assert response.status_code == 429
    assert response.headers["retry-after"] == "2"


def test_ingest_files_unreachable_is_502() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    client, _ = build_app(handler)
    response = client.post(
        "/api/ui/ingest/files",
        files=[("files", ("a.pdf", b"%PDF-1.5 aaa", "application/pdf"))],
    )

    assert response.status_code == 502
    assert response.json()["detail"].startswith("paperbox unreachable")


def test_ingest_files_streams_the_handles_instead_of_slurping() -> None:
    """K concurrent uploads must not be read into the BFF's memory in one go."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, json={"request_id": "req-2", "accepted": 1, "results": []})

    stream = _RecordingStream(b"%PDF-1.5" + b"x" * 4096)
    upload = UploadFile(
        file=stream,
        size=4103,
        filename="big.pdf",
        headers=Headers({"content-type": "application/pdf"}),
    )

    response = asyncio.run(
        ingest_routes.ingest_files(files=[upload], client=build_client(handler))
    )

    assert response.status_code == 202
    assert stream.whole_reads == 0, "the upload was read into memory in one call"
    assert stream.chunk_reads > 0


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


def test_jobs_queue_is_not_swallowed_by_the_job_id_route() -> None:
    """``/jobs/queue`` must be declared before ``/jobs/{job_id}``."""

    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json(
            {
                "started": True,
                "concurrency": 1,
                "running": 1,
                "queued": 3,
                "queued_high": 2,
                "queued_low": 1,
                "running_job_ids": ["j1"],
                "queued_job_ids": ["j2", "j3", "j4"],
            }
        )

    client, seen = build_app(handler)
    response = client.get("/api/ui/jobs/queue")

    assert response.status_code == 200
    assert response.json()["queued"] == 3
    assert seen[0].url.path == "/api/jobs/queue", "the {job_id} route ate the queue path"


# --------------------------------------------------------------------------- #
# /api/ui/config
# --------------------------------------------------------------------------- #


def test_ui_config_exposes_the_upload_tuning() -> None:
    """The frontend must not hardcode concurrency, retries or the file cap."""

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("config is served locally")

    client, seen = build_app(handler)
    response = client.get("/api/ui/config")

    assert response.status_code == 200
    assert response.json() == {
        "upload_concurrency": 2,
        "upload_max_attempts": 6,
        "retry_base_ms": 2000,
        "retry_cap_ms": 60000,
        "file_max_mb": 100,
        "batch_hint_threshold": 20,
    }
    assert seen == [], "config must not hit paperbox"


def test_ui_config_follows_settings() -> None:
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("config is served locally")

    client, _ = build_app(handler)
    client.app.dependency_overrides[get_settings] = lambda: Settings(
        webui_upload_concurrency=4,
        webui_upload_max_attempts=9,
        webui_retry_base_ms=500,
        webui_retry_cap_ms=1000,
        webui_file_max_mb=7,
        webui_batch_hint_threshold=3,
    )

    assert client.get("/api/ui/config").json() == {
        "upload_concurrency": 4,
        "upload_max_attempts": 9,
        "retry_base_ms": 500,
        "retry_cap_ms": 1000,
        "file_max_mb": 7,
        "batch_hint_threshold": 3,
    }


# --------------------------------------------------------------------------- #
# Retry-After passthrough (the upload queue can only back off if it arrives)
# --------------------------------------------------------------------------- #


def test_retry_after_is_forwarded_with_the_429() -> None:
    """A 429 from paperbox must keep its Retry-After header through the proxy."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            json={"detail": "server busy: uploads in flight; retry after 2s"},
            headers={"Retry-After": "2"},
        )

    client, seen = build_app(handler)
    response = client.post(
        "/api/ui/ingest/file",
        files={"file": ("a.pdf", b"%PDF-1.5 a", "application/pdf")},
    )

    assert seen[0].url.path == "/api/papers/ingest/file"
    assert response.status_code == 429
    assert response.headers["retry-after"] == "2"
    assert "server busy" in response.json()["detail"]


def test_retry_after_is_forwarded_by_the_json_routers() -> None:
    """jobs / papers / search share the same relay helper as ingest."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"detail": "busy"}, headers={"Retry-After": "7"})

    client, _ = build_app(handler)
    responses = [
        client.get("/api/ui/jobs/j1"),
        client.get("/api/ui/papers"),
        client.post("/api/ui/search", json={"query": "attention"}),
    ]
    for response in responses:
        assert response.status_code == 429
        assert response.headers["retry-after"] == "7"


def test_no_retry_after_header_without_one_upstream() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"detail": "boom"})

    client, _ = build_app(handler)
    response = client.post(
        "/api/ui/ingest/file",
        files={"file": ("a.pdf", b"%PDF-1.5 a", "application/pdf")},
    )

    assert response.status_code == 500
    assert "retry-after" not in response.headers


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


def test_index_shell_exposes_the_multi_select_upload_queue() -> None:
    """The ingest tab must offer a multi-select input plus the queue controls."""

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        return httpx.Response(500)

    client, _ = build_app(handler)
    html = client.get("/").text

    assert 'id="queue-file-input"' in html
    assert "multiple" in html.split('id="queue-file-input"')[1].split(">")[0]
    for marker in ("queue-list", "queue-summary", "btn-queue-start", "btn-queue-stop",
                   "btn-queue-clear", "queue-autostart", "queue-dropzone"):
        assert f'id="{marker}"' in html, marker
    # 单文件表单已被队列取代
    assert 'id="ingest-file-form"' not in html
    assert 'id="ingest-file"' not in html


def test_app_js_is_served_and_implements_the_queue() -> None:
    """Guard the static asset: queue helpers must survive future refactors."""

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        return httpx.Response(500)

    client, _ = build_app(handler)
    response = client.get("/static/app.js")

    assert response.status_code == 200
    body = response.text
    for symbol in ("queueAddFiles", "queueStart", "queueStop", "processQueueItem",
                   "uploadFileWithProgress", "collectDroppedFiles", "pollQueueItem"):
        assert symbol in body, symbol
    # 上传进度依赖 XHR（fetch 拿不到 upload 进度）
    assert "xhr.upload.onprogress" in body


def test_app_js_uses_the_concurrent_queue() -> None:
    """Guard the queue rewrite: pool, backoff and the new endpoints must stay."""

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        return httpx.Response(500)

    client, _ = build_app(handler)
    body = client.get("/static/app.js").text

    for symbol in ("uploadSlots", "retryDelayMs", "state.queue.inflight", "queueBackOff",
                   "Retry-After", "/api/ui/ingest/files", "/api/ui/config"):
        assert symbol in body, symbol
    assert 'form.append("files"' in body, "one file per request, field name files"
    assert "/api/ui/ingest/file\"" not in body, "the legacy single-file endpoint is no longer used"


def test_app_js_reports_two_phase_progress_and_queued() -> None:
    """The queue summary is now `上传 x/y · 处理 a/b`, and QUEUED has a label."""

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        return httpx.Response(500)

    client, _ = build_app(handler)
    html = client.get("/").text
    body = client.get("/static/app.js").text

    assert 'id="queue-hint"' in html
    for symbol in ("QUEUED", "排队中", "summarizeProgress", "queueSyncHint",
                   "queueSyncBacklog", "/api/ui/jobs/queue", "服务端排队", "排队退避"):
        assert symbol in body, symbol


def test_index_loads_the_queue_logic_before_app_js() -> None:
    """``app.js`` reads ``window.PaperboxQueue`` at call time, but keep the order."""

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        return httpx.Response(500)

    client, _ = build_app(handler)
    html = client.get("/").text

    assert 'src="/static/queue-logic.js"' in html
    assert html.index("queue-logic.js") < html.index("app.js")


def test_queue_logic_is_served_and_exports_the_helpers() -> None:
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        return httpx.Response(500)

    client, _ = build_app(handler)
    response = client.get("/static/queue-logic.js")

    assert response.status_code == 200
    body = response.text
    for symbol in ("parseRetryAfter", "retryDelayMs", "summarizeProgress",
                   "uploadSlots", "shouldSuggestServerSide"):
        assert symbol in body, symbol
    assert "module.exports" in body, "the file must stay loadable by node:test"


def test_queue_logic_passes_the_node_tests() -> None:
    """The pure logic is really executed: ``node --test tests/js/*.test.mjs``."""

    node = shutil.which("node")
    if node is None:  # pragma: no cover - the local box has node v24
        pytest.skip("node is not installed; the string guards above still apply")

    suites = sorted(JS_TEST_DIR.glob("*.test.mjs"))
    assert suites, "no JS test files found"
    result = subprocess.run(
        [node, "--test", *[str(path) for path in suites]],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "fail 0" in result.stdout, result.stdout


# --------------------------------------------------------------------------- #
# /api/ui/jobs paging + retry (2026-09-23)
# --------------------------------------------------------------------------- #


def test_jobs_list_forwards_the_page_window_and_stage() -> None:
    """The job tab pages server-side, so offset/stage must reach paperbox."""

    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json(
            {"total": 137, "limit": 10, "offset": 20, "stage": "FAILED", "jobs": []}
        )

    client, seen = build_app(handler)
    response = client.get(
        "/api/ui/jobs",
        params={"limit": 10, "offset": 20, "stage": "FAILED", "paper_id": "p1"},
    )

    assert response.status_code == 200
    assert response.json()["total"] == 137
    request = seen[0]
    assert request.url.path == "/api/jobs"
    assert request.url.params["limit"] == "10"
    assert request.url.params["offset"] == "20"
    assert request.url.params["stage"] == "FAILED"
    assert request.url.params["paper_id"] == "p1"


def test_jobs_list_omits_an_absent_stage() -> None:
    """No filter means no filter: paperbox must not receive ``stage=""``."""

    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json({"total": 0, "jobs": []})

    client, seen = build_app(handler)
    client.get("/api/ui/jobs")

    assert "stage" not in seen[0].url.params
    assert "paper_id" not in seen[0].url.params
    assert seen[0].url.params["offset"] == "0"


def test_jobs_list_rejects_a_negative_offset() -> None:
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        return httpx.Response(500)

    client, seen = build_app(handler)

    assert client.get("/api/ui/jobs", params={"offset": -1}).status_code == 422
    assert seen == [], "the BFF must not forward an impossible window"


def test_job_retry_is_proxied_as_a_post() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, json={"job_id": "j1", "stage": "QUEUED"})

    client, seen = build_app(handler)
    response = client.post("/api/ui/jobs/j1/retry")

    assert response.status_code == 202
    assert response.json()["stage"] == "QUEUED"
    assert (seen[0].method, seen[0].url.path) == ("POST", "/api/jobs/j1/retry")


def test_job_retry_passes_the_409_through() -> None:
    """Retrying a job that is not FAILED is paperbox's decision, not ours."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"detail": "only FAILED jobs can be retried"})

    client, _ = build_app(handler)
    response = client.post("/api/ui/jobs/j1/retry")

    assert response.status_code == 409
    assert response.json()["detail"] == "only FAILED jobs can be retried"


# --------------------------------------------------------------------------- #
# /api/ui/consistency
# --------------------------------------------------------------------------- #


def test_consistency_proxies_the_limit() -> None:
    report = {
        "checked_at": "2026-09-23T10:00:00Z",
        "consistent": True,
        "index": "paper_chunks_v2",
        "index_exists": True,
        "totals": {"papers_live": 68, "documents_os": 2883, "problems": 0},
        "problems": [],
        "orphan_objects": [],
        "orphan_documents": [],
        "errors": [],
        "truncated": False,
        "took_ms": 812.5,
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json(report)

    client, seen = build_app(handler)
    response = client.get("/api/ui/consistency", params={"limit": 5})

    assert response.status_code == 200
    assert response.json() == report
    assert (seen[0].method, seen[0].url.path) == ("GET", "/api/consistency")
    assert seen[0].url.params["limit"] == "5"


def test_consistency_keeps_a_partial_report_at_200() -> None:
    """One dead store is a report *with errors*, never a 5xx: the others answered."""

    report = {
        "checked_at": "2026-09-23T10:00:00Z",
        "consistent": True,
        "index": "paper_chunks_current",
        "index_exists": False,
        "totals": {"papers_live": 68, "problems": 0},
        "problems": [],
        "errors": ["opensearch: connection refused"],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json(report)

    client, _ = build_app(handler)
    response = client.get("/api/ui/consistency")

    assert response.status_code == 200
    assert response.json()["errors"] == ["opensearch: connection refused"]


def test_consistency_unreachable_is_502() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    client, _ = build_app(handler)
    response = client.get("/api/ui/consistency")

    assert response.status_code == 502
    assert response.json()["detail"].startswith("paperbox unreachable")


# --------------------------------------------------------------------------- #
# /api/ui/metadata/*
# --------------------------------------------------------------------------- #


class _FormRequest:
    """Minimal stand-in for a Starlette ``Request`` carrying one multipart part.

    Lets a test call the router function directly (no TestClient), which is how
    the streaming assertions below observe the file handle.
    """

    def __init__(self, upload: UploadFile) -> None:
        self.headers = {"content-type": "multipart/form-data; boundary=x"}
        self._upload = upload

    async def form(self) -> dict[str, UploadFile]:
        return {"file": self._upload}

    async def json(self):  # pragma: no cover - only the multipart branch is used
        raise ValueError("not a json body")


def test_metadata_import_forwards_a_multipart_file_and_the_query() -> None:
    report = {"total": 2, "matched": 1, "ambiguous": 1, "dry_run": True, "format": "csl"}

    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json(report)

    client, seen = build_app(handler)
    response = client.post(
        "/api/ui/metadata/import",
        params={"source_type": "ieee_api", "limit": 5},
        files={"file": ("records.json", b'[{"title": "x"}]', "application/json")},
    )

    assert response.status_code == 200
    assert response.json() == report
    request = seen[0]
    assert request.url.path == "/api/metadata/import"
    assert request.headers["content-type"].startswith("multipart/form-data")
    # dry_run is the documented default and is always stated explicitly
    assert request.url.params["dry_run"] == "true"
    assert request.url.params["source_type"] == "ieee_api"
    assert request.url.params["limit"] == "5"
    assert "apply" not in request.url.params
    body = request.content
    assert b'name="file"' in body
    assert b'[{"title": "x"}]' in body


def test_metadata_import_streams_the_file_handle() -> None:
    """A big record set must not be read into this process in one call."""

    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json({"total": 1, "dry_run": True})

    stream = _RecordingStream(b"[" + b'{"title":"x"},' * 512 + b'{"title":"y"}]')
    upload = UploadFile(
        file=stream,
        size=0,
        filename="records.json",
        headers=Headers({"content-type": "application/json"}),
    )

    response = asyncio.run(
        metadata_routes.import_metadata(
            request=_FormRequest(upload),
            dry_run=True,
            apply=None,
            limit=None,
            source_type="import_file",
            client=build_client(handler),
        )
    )

    assert response.status_code == 200
    assert stream.whole_reads == 0, "the upload was read into memory in one call"
    assert stream.chunk_reads > 0


def test_metadata_import_forwards_a_json_body() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json({"total": 1, "dry_run": False})

    client, seen = build_app(handler)
    payload = [{"title": "x", "doi": "10.1/x"}]
    response = client.post("/api/ui/metadata/import", params={"apply": "true"}, json=payload)

    assert response.status_code == 200
    request = seen[0]
    assert request.url.path == "/api/metadata/import"
    assert request.headers["content-type"].startswith("application/json")
    assert json.loads(request.content) == payload
    assert request.url.params["apply"] == "true"


def test_metadata_import_rejects_an_unsupported_content_type() -> None:
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        return httpx.Response(500)

    client, seen = build_app(handler)
    response = client.post(
        "/api/ui/metadata/import",
        content=b"title=x",
        headers={"Content-Type": "text/plain"},
    )

    assert response.status_code == 415
    assert seen == [], "nothing to forward, so nothing was forwarded"


def test_metadata_import_needs_a_file_part() -> None:
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        return httpx.Response(500)

    client, seen = build_app(handler)
    # ``data=`` would send urlencoded; a text part keeps this a multipart request
    response = client.post("/api/ui/metadata/import", files={"other": (None, "x")})

    assert response.status_code == 422
    assert "file" in response.json()["detail"]
    assert seen == []


def test_metadata_import_unreachable_is_502() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    client, _ = build_app(handler)
    response = client.post(
        "/api/ui/metadata/import",
        files={"file": ("records.json", b"[]", "application/json")},
    )

    assert response.status_code == 502


def test_metadata_review_forwards_repeated_status() -> None:
    review = {
        "total": 1,
        "items": [{"source_id": "s1", "match_status": "ambiguous"}],
        "conflicts": [],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json(review)

    client, seen = build_app(handler)
    response = client.get(
        "/api/ui/metadata/review",
        params=[("status", "ambiguous"), ("status", "pending"), ("limit", 10)],
    )

    assert response.status_code == 200
    assert response.json() == review
    assert seen[0].url.path == "/api/metadata/review"
    assert seen[0].url.params.get_list("status") == ["ambiguous", "pending"]
    assert seen[0].url.params["limit"] == "10"


def test_metadata_attach_forwards_the_body_verbatim() -> None:
    attached = {
        "source_id": "s1",
        "paper_id": "p1",
        "source_type": "ieee_api",
        "match_status": "attached",
        "merged_fields": ["title", "year"],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json(attached)

    client, seen = build_app(handler)
    response = client.post("/api/ui/metadata/sources/s1/attach", json={"paper_id": "p1"})

    assert response.status_code == 200
    assert response.json()["merged_fields"] == ["title", "year"]
    request = seen[0]
    assert (request.method, request.url.path) == ("POST", "/api/metadata/sources/s1/attach")
    assert json.loads(request.content) == {"paper_id": "p1"}


def test_metadata_apply_forwards_the_body_verbatim() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return ok_json({"applied": 1, "skipped": 0, "errors": []})

    client, seen = build_app(handler)
    body = {"entries": [{"source_ref": "r1", "paper_id": "p1"}], "mode": "fill"}
    response = client.post("/api/ui/metadata/apply", json=body)

    assert response.status_code == 200
    assert response.json()["applied"] == 1
    assert (seen[0].method, seen[0].url.path) == ("POST", "/api/metadata/apply")
    assert json.loads(seen[0].content) == body


def test_metadata_apply_passes_a_422_through() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"detail": "unknown source_type: nope"})

    client, _ = build_app(handler)
    response = client.post("/api/ui/metadata/apply", json={"entries": []})

    assert response.status_code == 422
    assert response.json()["detail"] == "unknown source_type: nope"


# --------------------------------------------------------------------------- #
# Tab 1: the metadata-snapshot filters (2026-09-23)
# --------------------------------------------------------------------------- #


def _static_handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
    return httpx.Response(500)


def test_index_shell_exposes_the_metadata_filters() -> None:
    """Tab 1 must offer what paperbox's ``SearchFilters`` grew on 2026-09-22."""

    client, _ = build_app(_static_handler)
    html = client.get("/").text

    for marker in (
        "filter-venue-year",
        "filter-identifier",
        "filter-paper-type",
        "filter-ieee-terms",
        "filter-author-terms",
        "filter-dynamic-index-terms",
        "filter-source-tags",
    ):
        assert f'id="{marker}"' in html, marker
    for paper_type in ("journal", "conference", "preprint", "early_access", "standard"):
        assert f'value="{paper_type}"' in html, paper_type
    # 快照过滤必须提醒"改了元数据要刷新索引"，否则会被误当成 bug
    assert "refresh_index_metadata.py" in html


def test_index_loads_the_search_logic_before_app_js() -> None:
    client, _ = build_app(_static_handler)
    html = client.get("/").text

    assert 'src="/static/search-logic.js"' in html
    assert html.index("search-logic.js") < html.index("app.js")


def test_search_logic_is_served_and_exports_the_helpers() -> None:
    client, _ = build_app(_static_handler)
    response = client.get("/static/search-logic.js")

    assert response.status_code == 200
    body = response.text
    for symbol in (
        "SCHEMES",
        "PAPER_TYPES",
        "buildFilters",
        "parseIdentifiers",
        "parseYear",
        "countFilters",
        "metadataLine",
    ):
        assert symbol in body, symbol
    assert "module.exports" in body, "the file must stay loadable by node:test"


def test_app_js_delegates_filter_building_to_the_shared_logic() -> None:
    """``filters`` is assembled in search-logic.js now, not inline in app.js."""

    client, _ = build_app(_static_handler)
    body = client.get("/static/app.js").text

    for symbol in ("PaperboxSearch", "buildFilters", "metadataLine", "countFilters"):
        assert symbol in body, symbol
    assert "year_from:" not in body, "the filter keys moved into search-logic.js"
    assert 'name="paper-type"' in body, "the paper_type checkboxes are read by app.js"


def test_search_logic_passes_the_node_tests() -> None:
    """The pure filter logic really runs: ``node --test tests/js/*.test.mjs``."""

    node = shutil.which("node")
    if node is None:  # pragma: no cover - the local box has node v24
        pytest.skip("node is not installed; the string guards above still apply")

    suites = sorted(JS_TEST_DIR.glob("*.test.mjs"))
    result = subprocess.run(
        [node, "--test", *[str(path) for path in suites]],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "fail 0" in result.stdout, result.stdout


# --------------------------------------------------------------------------- #
# Tab 5: 一致性 / Tab 6: 元数据 (2026-09-23)
# --------------------------------------------------------------------------- #


def test_index_shell_exposes_the_consistency_tab() -> None:
    client, _ = build_app(_static_handler)
    html = client.get("/").text

    assert 'data-tab="consistency"' in html
    for marker in (
        "panel-consistency",
        "consistency-limit",
        "consistency-totals",
        "consistency-errors",
        "consistency-body",
        "consistency-empty",
        "consistency-orphans-card",
        "consistency-orphans",
        "btn-consistency-run",
        "consistency-auto",
    ):
        assert f'id="{marker}"' in html, marker
    # totals 精确、条目可截断这两件事必须写在界面上，否则会被读成 bug
    assert "不受「问题条目上限」影响" in html


def test_index_shell_exposes_the_metadata_tab() -> None:
    client, _ = build_app(_static_handler)
    html = client.get("/").text

    assert 'data-tab="metadata"' in html
    for marker in (
        "panel-metadata",
        "metadata-source-type",
        "metadata-limit",
        "metadata-file",
        "metadata-json",
        "btn-metadata-dry-run",
        "btn-metadata-apply",
        "metadata-report-totals",
        "metadata-report-summary",
        "metadata-sources-body",
        "metadata-conflicts-body",
        "metadata-review-body",
        "metadata-review-only-ambiguous",
        "btn-metadata-review",
        "metadata-apply-mode",
        "metadata-apply-entries",
        "btn-metadata-prefill",
        "btn-metadata-apply-run",
    ):
        assert f'id="{marker}"' in html, marker
    # 默认 dry_run 是契约的一部分，界面必须写清
    assert "试运行是默认" in html


def test_app_js_implements_the_consistency_tab() -> None:
    client, _ = build_app(_static_handler)
    body = client.get("/static/app.js").text
    html = client.get("/").text

    for symbol in (
        "loadConsistency",
        "toggleConsistencyAuto",
        "renderConsistencyRow",
        "renderCensus",
        "renderOrphans",
        "paintTotals",
        "CL.censusRows",
        "CL.issueLabel",
        "/api/ui/consistency",
    ):
        assert symbol in body, symbol

    # 问题码映射与普查规则在 consistency-logic.js（app.js 只做 DOM），九个码都要有中文标签，
    # 否则表格里会出现英文码；0.4.1 的两个新码同样在列。
    logic = client.get("/static/consistency-logic.js").text
    assert "ISSUE_LABELS" in logic
    for code in (
        "missing_object",
        "orphan_object",
        "missing_chunks",
        "missing_index",
        "orphan_index",
        "chunk_count_mismatch",
        "deleted_paper_residue",
        "parser_stamp_mismatch",
        "embedding_model_mismatch",
    ):
        assert code in logic, code
    # 普查要落在界面上：容器 + 表格 + 两个 scope
    for marker in ("consistency-census-wrap", "consistency-census", "consistency-census-note"):
        assert f'id="{marker}"' in html, marker


def test_app_js_implements_the_metadata_tab() -> None:
    client, _ = build_app(_static_handler)
    body = client.get("/static/app.js").text

    for symbol in (
        "runMetadataImport",
        "renderMetadataReport",
        "loadMetadataReview",
        "attachMetadataSource",
        "prefillApplyEntries",
        "runMetadataApply",
        "/api/ui/metadata/import",
        "/api/ui/metadata/review",
        "/api/ui/metadata/apply",
        "/metadata/sources/",
        "dry_run",
    ):
        assert symbol in body, symbol
    # multipart 字段名必须是 file（paperbox 的契约），且不手写 Content-Type
    assert 'form.append("file"' in body
    assert "new FormData()" in body
    # 两个写操作都要二次确认
    assert "window.confirm" in body


# --------------------------------------------------------------------------- #
# Tab 4: 任务列表的分页、详情与重试 (2026-09-23)
# --------------------------------------------------------------------------- #


def test_index_shell_exposes_the_jobs_filters_and_pager() -> None:
    client, _ = build_app(_static_handler)
    html = client.get("/").text

    for marker in ("jobs-stage", "jobs-paper", "jobs-limit", "jobs-prev", "jobs-next",
                   "jobs-page-info", "jobs-total-info", "jobs-table"):
        assert f'id="{marker}"' in html, marker
    # 阶段下拉必须覆盖 paperbox 校验的十个阶段（写错是 422，不是空列表）
    for stage in ("RECEIVED", "QUEUED", "DOWNLOADING", "STORED", "PARSING", "CHUNKING",
                  "EMBEDDING", "INDEXING", "COMPLETED", "FAILED"):
        assert f'value="{stage}"' in html, stage
    # 每页条数不能再是自由输入：后端上限 200
    assert 'id="jobs-limit" value=' not in html


def test_index_shell_shows_the_richer_job_columns() -> None:
    client, _ = build_app(_static_handler)
    html = client.get("/").text
    table = html.split('id="jobs-table"')[1].split("</table>")[0]

    for header in ("job_id", "阶段", "进度", "重复", "错误", "论文", "创建", "更新", "完成", "耗时", "操作"):
        assert f"<th>{header}</th>" in table, header


def test_app_js_pages_the_job_list_server_side() -> None:
    client, _ = build_app(_static_handler)
    body = client.get("/static/app.js").text

    for symbol in ("state.jobs.offset", "offset=", "jobs-stage", "jobs-paper", "paintJobsPager",
                   "PaperboxJobs", "pagerState", "nextOffset"):
        assert symbol in body, symbol
    assert "&stage=" in body and "&paper_id=" in body


def test_app_js_retries_failed_jobs() -> None:
    client, _ = build_app(_static_handler)
    body = client.get("/static/app.js").text

    for symbol in ("retryJob", "/retry", 'stage === "FAILED"', "window.confirm"):
        assert symbol in body, symbol


def test_jobs_logic_is_served_and_exports_the_helpers() -> None:
    client, _ = build_app(_static_handler)
    response = client.get("/static/jobs-logic.js")

    assert response.status_code == 200
    body = response.text
    for symbol in ("durationText", "pagerState", "nextOffset", "RUNNING"):
        assert symbol in body, symbol
    assert "module.exports" in body, "the file must stay loadable by node:test"


def test_index_loads_every_logic_module_before_app_js() -> None:
    client, _ = build_app(_static_handler)
    html = client.get("/").text

    for module in ("search-logic.js", "jobs-logic.js", "queue-logic.js", "consistency-logic.js"):
        assert f'src="/static/{module}"' in html, module
        assert html.index(module) < html.index("app.js"), module


# --------------------------------------------------------------------------- #
# 鉴权失败的三态（paperbox 0.4.0+：401 缺凭证 / 403 不匹配 / 403 档位不足）
# --------------------------------------------------------------------------- #


def test_a_401_is_labelled_as_a_missing_key() -> None:
    """401 means no credential reached paperbox at all.

    The BFF's key lives server side, so the cause is our own ``.env``; pass the
    status and detail through untouched and add a hint naming the variable.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"detail": "Missing API key"})

    client, _ = build_app(handler)
    response = client.get("/api/ui/papers")

    assert response.status_code == 401
    assert response.json()["detail"] == "Missing API key"
    assert "PAPERBOX_API_KEY" in response.json()["hint"]


def test_a_403_on_an_unmatched_key_points_at_rotation() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"detail": "Invalid API key"})

    client, _ = build_app(handler)
    response = client.get("/api/ui/papers")

    assert response.status_code == 403
    assert response.json()["detail"] == "Invalid API key"
    hint = response.json()["hint"]
    assert "manage_keys.py" in hint, "the hint must name the tool that rotates keys"


def test_a_403_on_a_low_tier_points_at_the_role() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403,
            json={
                "detail": "insufficient role: this key is 'read', this endpoint "
                "needs 'admin' or higher"
            },
        )

    client, _ = build_app(handler)
    response = client.delete("/api/ui/papers/11111111-1111-1111-1111-111111111111")

    assert response.status_code == 403
    hint = response.json()["hint"]
    assert "write" in hint and "admin" in hint, hint


def test_other_error_statuses_gain_no_hint() -> None:
    """Only the auth statuses carry a hint -- a 404 stays exactly as paperbox sent it."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"detail": "paper not found"})

    client, _ = build_app(handler)
    response = client.get("/api/ui/papers/11111111-1111-1111-1111-111111111111")

    assert response.status_code == 404
    assert response.json() == {"detail": "paper not found"}


# --------------------------------------------------------------------------- #
# 0.4.x 的失败模式：状态码必须原样透传，并附一条能照着做的中文说明
# --------------------------------------------------------------------------- #


def _failing_backend(status: int, detail: str, headers: dict[str, str] | None = None) -> Handler:
    """A paperbox that answers every request with one error."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"detail": detail}, headers=headers or {})

    return handler


def test_a_413_explains_which_limit_was_hit() -> None:
    """两处 413 口径不同：单请求总字节（200 MB）与 JSON 体（8 MB）。"""
    client, _ = build_app(
        _failing_backend(
            413,
            "request too large: 314572800 bytes exceeds INGEST_MAX_REQUEST_MB=200",
        )
    )
    response = client.post(
        "/api/ui/ingest/files", files={"files": ("a.pdf", io.BytesIO(b"%PDF-1.4"), "application/pdf")}
    )
    assert response.status_code == 413
    hint = response.json()["hint"]
    assert "INGEST_MAX_REQUEST_MB" in hint or "200" in hint
    assert "拆" in hint or "分批" in hint

    body_client, _ = build_app(_failing_backend(413, "request body too large"))
    body = body_client.post(
        "/api/ui/ingest/files", files={"files": ("a.pdf", io.BytesIO(b"%PDF-1.4"), "application/pdf")}
    )
    assert body.status_code == 413
    assert "8" in body.json()["hint"]


def test_a_415_says_only_zip_is_accepted() -> None:
    client, _ = build_app(
        _failing_backend(
            415,
            "only zip archives are supported; 7z/rar/tar are not (repack the folder as a .zip)",
        )
    )
    response = client.post(
        "/api/ui/ingest/compressed",
        files={"file": ("a.7z", io.BytesIO(b"7z\xbc\xaf\x27\x1c"), "application/x-7z-compressed")},
    )
    assert response.status_code == 415
    assert ".zip" in response.json()["hint"]


def test_a_root_outside_the_whitelist_is_not_confused_with_a_role_problem() -> None:
    client, _ = build_app(
        _failing_backend(403, "root is outside the whitelist (INGEST_LOCAL_ROOTS): /etc")
    )
    response = client.post("/api/ui/ingest/dir", json={"root": "/etc"})
    assert response.status_code == 403
    hint = response.json()["hint"]
    assert "INGEST_LOCAL_ROOTS" in hint
    assert "档位" not in hint, "这是目录授权问题，不是 key 档位问题"


def test_a_disabled_scan_endpoint_reads_as_not_enabled() -> None:
    client, _ = build_app(
        _failing_backend(404, "directory import is disabled: INGEST_LOCAL_ROOTS is empty")
    )
    response = client.post("/api/ui/ingest/dir", json={"root": "/tmp"})
    assert response.status_code == 404
    assert "INGEST_LOCAL_ROOTS" in response.json()["hint"]


def test_a_missing_root_is_not_reported_as_a_disabled_endpoint() -> None:
    client, _ = build_app(_failing_backend(404, "root is not a directory: /nope"))
    response = client.post("/api/ui/ingest/dir", json={"root": "/nope"})
    assert response.status_code == 404
    hint = response.json()["hint"]
    assert "not a directory" in response.json()["detail"], "原文照透传"
    assert "不存在" in hint or "不是目录" in hint
    assert "没开" not in hint, "端点没开是另一条文案（详情在 detail 里）"


def test_a_429_quotes_the_retry_after_header() -> None:
    client, _ = build_app(
        _failing_backend(
            429,
            "server busy: ingestion backlog; retry after 30s",
            headers={"Retry-After": "30"},
        )
    )
    response = client.post(
        "/api/ui/ingest/files", files={"files": ("a.pdf", io.BytesIO(b"%PDF-1.4"), "application/pdf")}
    )
    assert response.status_code == 429
    assert response.headers.get("retry-after") == "30", "Retry-After 要透传"
    hint = response.json()["hint"]
    assert "30" in hint
    assert "重试" in hint or "等" in hint


def test_a_422_on_a_bad_archive_keeps_the_reason() -> None:
    client, _ = build_app(
        _failing_backend(422, "could not unpack the archive: BadZipFile('file is not a zip file')")
    )
    response = client.post(
        "/api/ui/ingest/compressed",
        files={"file": ("broken.zip", io.BytesIO(b"PK\x03\x04truncated"), "application/zip")},
    )
    assert response.status_code == 422
    assert "BadZipFile" in json.dumps(response.json())
    assert "zip" in response.json()["hint"]


def test_a_dead_paperbox_reads_as_unreachable_not_as_a_mystery_502() -> None:
    """paperbox 连不上时 webui 只能看到 502；4.1 的维度对账会让它起不来。"""

    def refuses(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    client, _ = build_app(refuses)
    response = client.get("/api/ui/papers")
    assert response.status_code == 502
    assert "unreachable" in response.json()["detail"]
    hint = response.json()["hint"]
    assert "paperbox" in hint
    assert "04-embedding" in hint or "维度" in hint


def test_an_untouched_status_gets_no_invented_hint() -> None:
    """没见过的状态不要硬编文案：原样透传比编一句错的好。"""
    client, _ = build_app(_failing_backend(418, "i am a teapot"))
    response = client.get("/api/ui/papers")
    assert response.status_code == 418
    assert "hint" not in response.json()
    assert response.json()["detail"] == "i am a teapot"


# --------------------------------------------------------------------------- #
# 目录导入与 zip 批量导入：paperbox 有入口，webui 也必须暴露（否则 415/403-root
# /404-scan 这些文案根本没有出现的地方）
# --------------------------------------------------------------------------- #


def test_the_dir_endpoint_relays_paperbox_and_keeps_defaults_honest() -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(
            202,
            json={
                "root": "/data/papers",
                "glob": "**/*.pdf",
                "recursive": True,
                "dry_run": True,
                "matched": 3,
                "accepted": 0,
                "duplicate": 0,
                "rejected": 0,
                "skipped": 0,
                "jobs": [{"filename": "a.pdf", "relative": "a.pdf", "status": "dry_run"}],
            },
        )

    client, forwarded = build_app(handler)
    response = client.post("/api/ui/ingest/dir", json={"root": "/data/papers", "dry_run": True})
    assert response.status_code == 202
    assert forwarded[0].url.path == "/api/papers/ingest/dir"
    # 默认值必须与 paperbox 的契约一致（dry_run 只有用户勾了才为真）
    assert seen[0] == {
        "root": "/data/papers",
        "glob": "**/*.pdf",
        "recursive": True,
        "limit": 2000,
        "dry_run": True,
    }
    assert response.json()["matched"] == 3


def test_the_dir_endpoint_requires_a_root() -> None:
    client, forwarded = build_app(_failing_backend(500, "should not be called"))
    response = client.post("/api/ui/ingest/dir", json={"root": "   "})
    assert response.status_code == 422
    assert not forwarded, "空 root 不该打给 paperbox"


def test_the_compressed_endpoint_streams_to_paperbox() -> None:
    client, forwarded = build_app(
        lambda request: httpx.Response(
            202,
            json={
                "request_id": "abc",
                "entries_total": 2,
                "entries_ignored": 0,
                "entries_rejected": 0,
                "accepted": 1,
                "duplicate": 1,
                "rejected": 0,
                "results": [],
            },
        )
    )
    response = client.post(
        "/api/ui/ingest/compressed",
        files={"file": ("papers.zip", io.BytesIO(b"PK\x03\x04fake"), "application/zip")},
    )
    assert response.status_code == 202
    assert forwarded[0].url.path == "/api/papers/ingest/compressed"
    assert b"papers.zip" in forwarded[0].content
    assert response.json()["accepted"] == 1


def test_the_ingest_tab_offers_both_new_entry_points() -> None:
    client, _ = build_app(_static_handler)
    html = client.get("/").text
    body = client.get("/static/app.js").text
    for marker in ("dir-root", "dir-glob", "dir-limit", "dir-recursive", "dir-dry-run",
                   "btn-dir-run", "dir-report", "zip-file-input", "btn-zip-run", "zip-report"):
        assert f'id="{marker}"' in html, marker
    for symbol in ("runDirIngest", "runZipIngest", "renderReport",
                   "/api/ui/ingest/dir", "/api/ui/ingest/compressed"):
        assert symbol in body, symbol
    # 界面要说清不是浏览器上传（否则用户会以为选了本地文件夹就传上去了）
    assert "同挂载卷" in html or "服务端路径" in html


def test_the_status_bar_carries_a_docling_chip() -> None:
    """状态条要有一格 docling，且 paperbox 报 disabled 时不能涂成红色。"""
    client, _ = build_app(_static_handler)
    html = client.get("/").text
    body = client.get("/static/app.js").text

    assert 'data-service="docling"' in html, "状态条缺 docling 那一格"
    # 顺序与 paperbox 的 services 一致：postgres/opensearch/minio/embedding/docling
    assert html.index('data-service="embedding"') < html.index('data-service="docling"')
    for symbol in ("applyServiceChip", 'value === "disabled"', "chip-pending"):
        assert symbol in body, symbol
    # 明确区分三态：ok → 绿、disabled → 中性、其余 → 红
    assert 'chip.className = "chip " + (ok ? "chip-ok" : "chip-error")' in body


def test_a_disabled_dependency_is_passed_through_untouched() -> None:
    """BFF 不做解释：paperbox 说 disabled 就原样透传，由界面决定怎么显示。"""
    payload = {
        "status": "ok",
        "version": "0.4.1",
        "services": {"postgres": "ok", "opensearch": "ok", "minio": "ok",
                     "embedding": "ok", "docling": "disabled"},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return ok_json(payload)
        if request.url.path == "/api/papers":
            return ok_json({"total": 0, "limit": 20, "offset": 0, "papers": []})
        if request.url.path == "/api/jobs":
            return ok_json({"total": 0, "jobs": []})
        return httpx.Response(404, json={"detail": "unexpected"})

    client, _ = build_app(handler)
    body = client.get("/api/ui/health").json()
    assert body["paperbox"]["docling"] == "disabled"
    assert body["paperbox"] == payload["services"]


def test_the_metadata_report_can_be_collapsed_and_cleared() -> None:
    """导入报告以前是一张铺到底的裸卡片：不能折、不能清，把下面两个卡片顶出屏幕。"""
    client, _ = build_app(_static_handler)
    html = client.get("/").text
    body = client.get("/static/app.js").text

    assert 'id="metadata-report-card"' in html
    # 折叠靠原生 <details>，别再手写一套显隐状态机
    assert re.search(r'<details[^>]*id="metadata-report-card"', html)
    assert 'id="btn-metadata-report-clear"' in html
    assert "clearMetadataReport" in body
    # 清空要连 state 一起清，否则"从报告预填"会拿到已清空的旧数据
    assert "state.metadata.report = null;" in body
    # 表体限高，长报告不再把后面的卡片推下去
    assert "table-scroll" in html
    assert ".table-scroll" in client.get("/static/style.css").text


def test_the_report_tables_only_show_columns_that_carry_values() -> None:
    """「来源类型」曾经永远为空：paperbox 的导入响应里没有 source_type 字段。

    它现在只出现在摘要行（来自表单），表格里不再留那一列。
    """
    client, _ = build_app(_static_handler)
    html = client.get("/").text

    sources_table = html.split('id="metadata-sources-table"')[1].split("</table>")[0]
    assert "source_ref" in sources_table
    assert "匹配状态" in sources_table and "匹配方式" in sources_table and "论文" in sources_table
    assert "来源类型" not in sources_table, "这一列是空的，不该留在表格里"
    assert "来源类型（source_type）" in html, "表单里那项仍在"


def test_each_card_owns_its_own_conflict_table() -> None:
    """曾经 report 卡和 review 卡写同一张表，于是"库内冲突"出现在「导入报告」下面。"""
    client, _ = build_app(_static_handler)
    html = client.get("/").text
    body = client.get("/static/app.js").text

    assert 'id="metadata-conflicts-body"' in html
    assert 'id="metadata-review-conflicts-body"' in html
    # 导入报告的渲染只碰自己那张表
    report_fn = body.split("function renderMetadataReport")[1].split("function paintMoreNote")[0]
    assert 'metadata-conflicts-body' in report_fn
    assert "metadata-review-conflicts-body" not in report_fn
    # 复核清单的 loader 只碰自己那张表（切到下一个顶层函数为止，
    # 注意别切在里面的匿名 function 上）
    review_fn = body.split("function loadMetadataReview")[1].split("\n  function ")[0]
    assert "metadata-review-conflicts-body" in review_fn
    assert "metadata-conflicts-body" not in review_fn
