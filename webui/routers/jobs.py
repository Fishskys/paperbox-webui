"""Ingestion job progress endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from ..client import PaperboxClient, PaperboxUnreachable
from .deps import forward_headers, get_client, passthrough, unreachable

router = APIRouter()

DEFAULT_JOB_LIMIT = 20


@router.get("/jobs")
async def list_jobs(
    limit: int = Query(DEFAULT_JOB_LIMIT, ge=1, le=200),
    offset: int = Query(0, ge=0),
    stage: str | None = None,
    paper_id: str | None = None,
    client: PaperboxClient = Depends(get_client),
) -> JSONResponse:
    """Page through the job history (``offset``/``stage`` forwarded verbatim).

    paperbox validates ``stage`` (a typo is a 422 there, not an empty page), so
    this router deliberately does not keep its own copy of the stage list.
    """
    try:
        response = await client.list_jobs(
            limit=limit, offset=offset, stage=stage, paper_id=paper_id
        )
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


@router.get("/jobs/queue")
async def job_queue(client: PaperboxClient = Depends(get_client)) -> JSONResponse:
    """Server-side backlog depth.

    Declared *before* ``/jobs/{job_id}``: otherwise the path parameter swallows
    ``queue`` (paperbox itself hit the same trap).
    """
    try:
        response = await client.job_queue()
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, client: PaperboxClient = Depends(get_client)) -> JSONResponse:
    try:
        response = await client.get_job(job_id)
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


@router.post("/jobs/{job_id}/retry")
async def retry_job(
    job_id: str, client: PaperboxClient = Depends(get_client)
) -> JSONResponse:
    """Re-drive a FAILED job (202 + the reset job; 409 when it is not FAILED)."""
    try:
        response = await client.retry_job(job_id)
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
