"""Mutating paper endpoints: reindex and delete."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from ..client import PaperboxClient, PaperboxUnreachable
from .deps import get_client, passthrough, unreachable

router = APIRouter()


@router.post("/papers/{paper_id}/reindex")
async def reindex(
    paper_id: str, client: PaperboxClient = Depends(get_client)
) -> JSONResponse:
    try:
        response = await client.reindex(paper_id)
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


@router.delete("/papers/{paper_id}")
async def delete_paper(
    paper_id: str, client: PaperboxClient = Depends(get_client)
) -> JSONResponse:
    try:
        response = await client.delete_paper(paper_id)
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


def _json(response) -> JSONResponse:
    if response.ok:
        content = response.json()
        if content is None:
            return JSONResponse(status_code=response.status_code, content={"ok": True})
        return JSONResponse(status_code=response.status_code, content=content)
    return passthrough(response)
