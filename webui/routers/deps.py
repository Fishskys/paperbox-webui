"""Shared dependencies: one paperbox client per request, plus error passthrough."""

from __future__ import annotations

from typing import NoReturn

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from ..client import PaperboxClient, PaperboxResponse, PaperboxUnreachable


def get_client(request: Request) -> PaperboxClient:
    """Return the process wide client stored on ``app.state``."""
    client = getattr(request.app.state, "paperbox", None)
    if client is None:  # pragma: no cover - defensive, main() always sets it
        raise HTTPException(status_code=503, detail="paperbox client not configured")
    return client


def passthrough(response: PaperboxResponse) -> JSONResponse:
    """Relay a paperbox error body and status code to the browser unchanged."""
    payload = response.json()
    if payload is None:
        payload = {"detail": response.content.decode("utf-8", "replace") or "paperbox error"}
    return JSONResponse(status_code=response.status_code, content=payload)


def unreachable(exc: PaperboxUnreachable) -> JSONResponse:
    """paperbox is down (connection refused, timeout, DNS failure) -> HTTP 502."""
    return JSONResponse(
        status_code=502,
        content={"detail": f"paperbox unreachable: {exc.message}"},
    )


def raise_for_error(response: PaperboxResponse) -> None:
    """Raise an :class:`HTTPException` that mirrors the paperbox error verbatim."""
    payload = response.json()
    raise HTTPException(status_code=response.status_code, detail=_detail_of(payload))


def _detail_of(payload: object) -> object:
    if isinstance(payload, dict) and "detail" in payload:
        return payload["detail"]
    if payload is None:
        return "paperbox error"
    return payload
