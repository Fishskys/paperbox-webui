"""Paper browsing endpoints: list, detail, chunks and the PDF stream."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse, StreamingResponse

from ..client import PaperboxClient, PaperboxUnreachable
from .deps import forward_headers, get_client, passthrough, unreachable

router = APIRouter()

DEFAULT_LIST_LIMIT = 20
DEFAULT_CHUNK_LIMIT = 50
PDF_CONTENT_TYPE = "application/pdf"


@router.get("/papers")
async def list_papers(
    limit: int = Query(DEFAULT_LIST_LIMIT, ge=1, le=200),
    offset: int = Query(0, ge=0),
    status: str | None = None,
    q: str | None = None,
    client: PaperboxClient = Depends(get_client),
) -> JSONResponse:
    """Proxy ``GET /api/papers`` with limit/offset/status/q passed straight through."""
    try:
        response = await client.list_papers(
            limit=limit, offset=offset, status=status, q=q
        )
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


@router.get("/papers/{paper_id}")
async def get_paper(
    paper_id: str, client: PaperboxClient = Depends(get_client)
) -> JSONResponse:
    try:
        response = await client.get_paper(paper_id)
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


@router.get("/papers/{paper_id}/chunks")
async def get_chunks(
    paper_id: str,
    limit: int = Query(DEFAULT_CHUNK_LIMIT, ge=1, le=500),
    offset: int = Query(0, ge=0),
    client: PaperboxClient = Depends(get_client),
) -> JSONResponse:
    try:
        response = await client.get_chunks(paper_id, limit=limit, offset=offset)
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


@router.get("/papers/{paper_id}/file", response_model=None)
async def get_paper_file(
    paper_id: str, client: PaperboxClient = Depends(get_client)
) -> StreamingResponse | JSONResponse:
    """Stream the stored PDF back to the browser, keeping the original headers."""
    try:
        response = await client.get_paper_file(paper_id)
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    if not response.ok:
        return passthrough(response)

    headers = {"Content-Type": response.content_type or PDF_CONTENT_TYPE}
    if response.content_disposition:
        headers["Content-Disposition"] = response.content_disposition
    return StreamingResponse(
        _body(response.content), media_type=headers["Content-Type"], headers=headers
    )


async def _body(content: bytes):
    yield content


def _json(response) -> JSONResponse:
    if response.ok:
        return JSONResponse(
            status_code=response.status_code,
            content=response.json(),
            headers=forward_headers(response),
        )
    return passthrough(response)
