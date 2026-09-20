"""``POST /api/ui/search`` - body forwarded to paperbox verbatim."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse

from ..client import PaperboxClient, PaperboxUnreachable
from .deps import forward_headers, get_client, passthrough, unreachable

router = APIRouter()


@router.post("/search")
async def search(
    payload: dict[str, Any] = Body(...),
    client: PaperboxClient = Depends(get_client),
) -> JSONResponse:
    try:
        response = await client.search(payload)
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    if response.ok:
        return JSONResponse(
            status_code=response.status_code,
            content=response.json(),
            headers=forward_headers(response),
        )
    return passthrough(response)
