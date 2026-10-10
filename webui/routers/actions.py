"""Mutating paper endpoints: reindex and delete."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse

from ..client import PaperboxClient, PaperboxUnreachable
from .deps import forward_headers, get_client, passthrough, unreachable

router = APIRouter()


@router.post("/papers/reindex")
async def reindex_library(
    body: dict[str, Any] = Body(default={}),
    client: PaperboxClient = Depends(get_client),
) -> JSONResponse:
    """整库重建索引：把 body 原样转给 paperbox 的 ``POST /api/papers/reindex``。

    paperbox 侧默认 ``dry_run=true``，所以前端走「先预览、再确认」两步；这里不替它做决定，
    也不加自己的默认值 —— body 是什么就转发什么。
    """
    try:
        response = await client.reindex_library(body or {})
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


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
            return JSONResponse(
                status_code=response.status_code,
                content={"ok": True},
                headers=forward_headers(response),
            )
        return JSONResponse(
            status_code=response.status_code,
            content=content,
            headers=forward_headers(response),
        )
    return passthrough(response)
