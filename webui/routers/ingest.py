"""Ingestion endpoints: URL submit (JSON) and PDF upload (multipart)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

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


@router.post("/ingest/files", status_code=202)
async def ingest_files(
    files: list[UploadFile] = File(...),
    client: PaperboxClient = Depends(get_client),
) -> JSONResponse:
    """Queue one or more uploaded PDFs via ``POST /api/papers/ingest/files``.

    The browser sends one file per request (parallelism comes from concurrent
    requests, and a single-file request is interactive priority on the paperbox
    side); the list keeps the endpoint honest for batch callers. The parts are
    relayed as spooled temp files -- ``await file.read()`` here would put
    concurrency x 100MB into this process at once.
    """
    try:
        response = await client.ingest_files(_upload_parts(files))
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


class IngestDirRequest(BaseModel):
    """``POST /api/ui/ingest/dir`` 的入参，镜像 paperbox 的 ``IngestDirRequest``。

    ``root`` 是 **paperbox 所在机器上的绝对路径**（PDF 必须与 paperbox 同机或同挂载卷），
    不是浏览器上传的目录 —— 这也是它默认不常开的原因：端点只在 ``INGEST_LOCAL_ROOTS``
    非空时存在，root 必须落在白名单内。

    默认值与 paperbox 一致：``glob="**/*.pdf"``、``recursive=True``、``limit=2000``、
    ``dry_run=False``（界面上的"试运行"要让用户自己勾，不替他们改默认）。
    """

    model_config = ConfigDict(extra="forbid")

    root: str = Field(description="paperbox 机器上的绝对目录")
    glob: str = Field(default="**/*.pdf")
    recursive: bool = True
    limit: int = Field(default=2000, ge=1, le=2000)
    dry_run: bool = False


@router.post("/ingest/dir", status_code=202)
async def ingest_dir(
    payload: IngestDirRequest, client: PaperboxClient = Depends(get_client)
) -> JSONResponse:
    """让 paperbox 自己扫目录（零传输）。端点关闭/越界时 paperbox 会给 404/403，原样透传。"""
    if not payload.root.strip():
        return JSONResponse(status_code=422, content={"detail": "root is required"})
    try:
        response = await client.ingest_dir(payload.model_dump())
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


@router.post("/ingest/compressed", status_code=202)
async def ingest_compressed(
    file: UploadFile = File(...), client: PaperboxClient = Depends(get_client)
) -> JSONResponse:
    """上传一个 zip，paperbox 逐个解包入库（只认 zip：其余格式返回 415）。"""
    handle = file.file
    handle.seek(0)
    try:
        response = await client.ingest_compressed(
            file.filename or "archive.zip", handle, file.content_type
        )
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


def _upload_parts(files: list[UploadFile]) -> list[tuple[str, Any, str]]:
    """``(filename, handle, content_type)`` triples httpx can stream from."""
    parts: list[tuple[str, Any, str]] = []
    for upload in files:
        handle = upload.file
        handle.seek(0)
        parts.append(
            (
                upload.filename or "upload.pdf",
                handle,
                upload.content_type or "application/pdf",
            )
        )
    return parts


def _json(response) -> JSONResponse:
    if response.ok:
        return JSONResponse(
            status_code=response.status_code,
            content=response.json(),
            headers=forward_headers(response),
        )
    return passthrough(response)
