"""Ingestion endpoints: URL submit (JSON) and PDF upload (multipart)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..client import PaperboxClient, PaperboxUnreachable
from .deps import forward_headers, get_client, passthrough, unreachable

router = APIRouter()


class IngestUrlRequest(BaseModel):
    """Body of ``POST /api/ui/ingest``.

    Mirrors the paperbox contract (``{"source_type": "url", "source": "..."}``)
    and also accepts the shorthand ``{"url": "..."}``.
    """

    source_type: str = Field(default="url")
    source: str | None = Field(default=None, description="HTTP(S) URL of the PDF")
    url: str | None = Field(default=None, description="shorthand for source")

    @property
    def resolved_source(self) -> str:
        return (self.source or self.url or "").strip()


@router.post("/ingest", status_code=202)
async def ingest_url(
    payload: IngestUrlRequest, client: PaperboxClient = Depends(get_client)
) -> JSONResponse:
    """Queue one URL for ingestion (only ``source_type=url`` is supported)."""
    source = payload.resolved_source
    if not source:
        return JSONResponse(
            status_code=422,
            content={"detail": "either 'source' or 'url' is required"},
        )
    if payload.source_type and payload.source_type != "url":
        return JSONResponse(
            status_code=422,
            content={"detail": f"unsupported source_type: {payload.source_type}"},
        )
    try:
        response = await client.ingest_url(source)
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


@router.post("/ingest/file", status_code=202)
async def ingest_file(
    file: UploadFile = File(...), client: PaperboxClient = Depends(get_client)
) -> JSONResponse:
    content = await file.read()
    try:
        response = await client.ingest_file(
            file.filename or "upload.pdf", content, file.content_type
        )
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


def _json(response) -> JSONResponse:
    if response.ok:
        return JSONResponse(
            status_code=response.status_code,
            content=response.json(),
            headers=forward_headers(response),
        )
    return passthrough(response)
