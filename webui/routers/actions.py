"""Mutating paper endpoints: reindex and delete."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Query
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


@router.delete("/papers/{paper_id}/metadata")
async def clear_metadata(
    paper_id: str,
    dry_run: bool = Query(False, description="report only; default false (paperbox default)"),
    client: PaperboxClient = Depends(get_client),
) -> JSONResponse:
    """清空一篇论文的题录元数据（保留论文本体、正文与原始 PDF）。

    透传 paperbox 的 ``DELETE /api/papers/{id}/metadata``；``dry_run=true`` 只预览将删除什么。
    写档由 paperbox 把关（``require_write``），这里不重复判权限。
    """
    try:
        response = await client.clear_metadata(paper_id, dry_run=dry_run)
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


@router.post("/papers/{paper_id}/metadata/reextract")
async def reextract_metadata(
    paper_id: str,
    body: dict[str, Any] = Body(default={}),
    client: PaperboxClient = Depends(get_client),
) -> JSONResponse:
    """从已存 PDF 重新提取一篇论文的元数据并补空缺（不覆盖已有/人工值）。

    体里的 ``dry_run``（默认 true）与 ``refresh_index`` 原样转给 paperbox 的
    ``POST /api/papers/{id}/metadata/reextract``；不替它改默认值。
    """
    payload = {
        "dry_run": bool(body.get("dry_run", True)),
        "refresh_index": bool(body.get("refresh_index", True)),
    }
    try:
        response = await client.reextract_paper_metadata(
            paper_id,
            dry_run=payload["dry_run"],
            refresh_index=payload["refresh_index"],
        )
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
