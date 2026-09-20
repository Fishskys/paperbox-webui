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
    paper_id: str | None = None,
    client: PaperboxClient = Depends(get_client),
) -> JSONResponse:
    try:
        response = await client.list_jobs(limit=limit, paper_id=paper_id)
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


def _json(response) -> JSONResponse:
    if response.ok:
        return JSONResponse(
            status_code=response.status_code,
            content=response.json(),
            headers=forward_headers(response),
        )
    return passthrough(response)
