"""Async httpx wrapper around the paperbox REST API.

The browser only ever talks to ``/api/ui/*`` on this service; every call below is
made server side with the bearer token, so the API key never leaves the backend
(SPEC section 0).
"""

from __future__ import annotations

from typing import Any

import httpx

from .config import Settings, get_settings


class PaperboxUnreachable(Exception):
    """The paperbox service could not be reached (transport level failure)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class PaperboxResponse:
    """Thin, framework agnostic view of a paperbox response."""

    __slots__ = ("status_code", "headers", "content")

    def __init__(self, status_code: int, headers: dict[str, str], content: bytes) -> None:
        self.status_code = status_code
        self.headers = headers
        self.content = content

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300

    @property
    def content_type(self) -> str:
        return self.headers.get("content-type", "application/json")

    @property
    def content_disposition(self) -> str | None:
        return self.headers.get("content-disposition")

    def json(self) -> Any:
        if not self.content:
            return None
        try:
            return __import__("json").loads(self.content.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return None


class PaperboxClient:
    """Small typed facade over the paperbox endpoints used by the WebUI."""

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self._base_url = self.settings.paperbox_api_base.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=self.settings.request_timeout,
            headers=self._default_headers(),
            transport=transport,
        )

    def _default_headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        key = self.settings.paperbox_api_key
        if key:
            headers["Authorization"] = f"Bearer {key}"
        return headers

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "PaperboxClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        data: Any = None,
        files: Any = None,
        timeout: float | None = None,
        stream: bool = False,
    ) -> PaperboxResponse:
        """Send one request, mapping transport failures to ``PaperboxUnreachable``.

        Non-2xx responses are returned untouched so the routers can pass the
        paperbox status code and ``{"detail": ...}`` body straight through.
        """
        clean_params = (
            {k: v for k, v in params.items() if v is not None} if params else None
        )
        request_timeout = self.settings.request_timeout if timeout is None else timeout
        headers = {"Accept": "*/*" if stream else "application/json"}
        try:
            response = await self._client.request(
                method,
                path,
                params=clean_params,
                json=json,
                data=data,
                files=files,
                timeout=request_timeout,
                headers=headers,
            )
        except httpx.HTTPError as exc:
            raise PaperboxUnreachable(f"{type(exc).__name__}: {exc}") from exc
        return PaperboxResponse(
            status_code=response.status_code,
            headers={k.lower(): v for k, v in response.headers.items()},
            content=response.content,
        )

    async def health(self) -> PaperboxResponse:
        return await self._request("GET", "/health")

    async def list_papers(
        self,
        limit: int | None = None,
        offset: int | None = None,
        status: str | None = None,
        q: str | None = None,
    ) -> PaperboxResponse:
        return await self._request(
            "GET",
            "/api/papers",
            params={"limit": limit, "offset": offset, "status": status, "q": q},
        )

    async def get_paper(self, paper_id: str) -> PaperboxResponse:
        return await self._request("GET", f"/api/papers/{paper_id}")

    async def get_paper_file(self, paper_id: str) -> PaperboxResponse:
        return await self._request(
            "GET", f"/api/papers/{paper_id}/file", stream=True
        )

    async def get_chunks(
        self, paper_id: str, limit: int | None = None, offset: int | None = None
    ) -> PaperboxResponse:
        return await self._request(
            "GET",
            f"/api/papers/{paper_id}/chunks",
            params={"limit": limit, "offset": offset},
        )

    async def list_jobs(
        self,
        limit: int | None = None,
        offset: int | None = None,
        stage: str | None = None,
        paper_id: str | None = None,
    ) -> PaperboxResponse:
        """``GET /api/jobs`` with the page window and the optional filters.

        paperbox echoes ``limit``/``offset``/``stage`` and the *filtered* ``total``
        back, so the job tab can page server-side (2026-09-23 contract).
        """
        return await self._request(
            "GET",
            "/api/jobs",
            params={
                "limit": limit,
                "offset": offset,
                "stage": stage,
                "paper_id": paper_id,
            },
        )

    async def get_job(self, job_id: str) -> PaperboxResponse:
        return await self._request("GET", f"/api/jobs/{job_id}")

    async def retry_job(self, job_id: str) -> PaperboxResponse:
        """Re-drive a FAILED job; paperbox answers 409 for anything else."""
        return await self._request("POST", f"/api/jobs/{job_id}/retry")

    async def job_queue(self) -> PaperboxResponse:
        """In-process ingestion queue depth (``GET /api/jobs/queue``)."""
        return await self._request("GET", "/api/jobs/queue")

    async def consistency(self, limit: int | None = None) -> PaperboxResponse:
        """Three-way drift report (``GET /api/consistency``, read-only)."""
        return await self._request("GET", "/api/consistency", params={"limit": limit})

    async def import_metadata(
        self,
        *,
        params: dict[str, Any] | None = None,
        file: tuple[str, Any, str] | None = None,
        payload: Any = None,
    ) -> PaperboxResponse:
        """``POST /api/metadata/import``: multipart file *or* JSON body.

        ``file`` is ``(filename, fileobj, content_type)`` and is handed to httpx
        untouched, so a big record set is streamed rather than buffered here.
        """
        if file is not None:
            return await self._request(
                "POST",
                "/api/metadata/import",
                params=params,
                files={"file": file},
                timeout=self.settings.ingest_timeout,
            )
        return await self._request(
            "POST",
            "/api/metadata/import",
            params=params,
            json={} if payload is None else payload,
            timeout=self.settings.ingest_timeout,
        )

    async def metadata_review(
        self, status: list[str] | None = None, limit: int | None = None
    ) -> PaperboxResponse:
        """``GET /api/metadata/review`` (records awaiting a human decision)."""
        return await self._request(
            "GET", "/api/metadata/review", params={"status": status, "limit": limit}
        )

    async def attach_source(self, source_id: str, paper_id: str) -> PaperboxResponse:
        """``POST /api/metadata/sources/{id}/attach`` -- the human answer."""
        return await self._request(
            "POST",
            f"/api/metadata/sources/{source_id}/attach",
            json={"paper_id": paper_id},
        )

    async def apply_metadata(self, payload: dict[str, Any]) -> PaperboxResponse:
        """``POST /api/metadata/apply`` -- replay a report's decisions."""
        return await self._request("POST", "/api/metadata/apply", json=payload)

    async def ingest_url(self, url: str) -> PaperboxResponse:
        return await self._request(
            "POST",
            "/api/papers/ingest",
            json={"source_type": "url", "source": url},
            timeout=self.settings.ingest_timeout,
        )

    async def ingest_file(
        self, filename: str, content: bytes, content_type: str | None = None
    ) -> PaperboxResponse:
        return await self._request(
            "POST",
            "/api/papers/ingest/file",
            files={"file": (filename, content, content_type or "application/pdf")},
            timeout=self.settings.ingest_timeout,
        )

    async def ingest_files(
        self, files: list[tuple[str, Any, str]]
    ) -> PaperboxResponse:
        """Upload one or more files in a single request (2026-09-19 contract).

        Each entry is ``(filename, fileobj, content_type)``. The file objects go
        to httpx untouched, so the multipart body is streamed in 64KB chunks --
        a caller passing ``UploadFile.file`` (a seekable ``SpooledTemporaryFile``)
        never buffers the whole PDF in this process.
        """
        return await self._request(
            "POST",
            "/api/papers/ingest/files",
            files=[("files", (name, handle, ctype)) for name, handle, ctype in files],
            timeout=self.settings.ingest_timeout,
        )

    async def search(self, payload: dict[str, Any]) -> PaperboxResponse:
        return await self._request("POST", "/api/search", json=payload)

    async def reindex(self, paper_id: str) -> PaperboxResponse:
        return await self._request(
            "POST",
            f"/api/papers/{paper_id}/reindex",
            timeout=self.settings.ingest_timeout,
        )

    async def delete_paper(self, paper_id: str) -> PaperboxResponse:
        return await self._request("DELETE", f"/api/papers/{paper_id}")
