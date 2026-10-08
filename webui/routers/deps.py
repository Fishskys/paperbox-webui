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


def forward_headers(response: PaperboxResponse) -> dict[str, str]:
    """Relay the paperbox response headers the browser actually needs.

    Only ``Retry-After`` today: paperbox answers a too-many-uploads request with
    ``429 + Retry-After: <seconds>``, and a proxy that drops the header turns
    "slow down" into a plain failure -- the upload queue then has nothing to back
    off on.
    """
    retry_after = response.headers.get("retry-after")
    if retry_after:
        return {"Retry-After": retry_after}
    return {}


#: Actionable follow-ups for the auth failures paperbox reports (0.4.0+).
#:
#: paperbox distinguishes three cases on purpose: 401 means no credential arrived at
#: all, 403 ``Invalid API key`` means the key was rejected (rotated, revoked, typo),
#: and 403 ``insufficient role`` means the key is fine but its tier is too low. The
#: status and ``detail`` are passed through verbatim; the hint is additive, so the
#: browser never has to infer the fix from a bare status code.
_AUTH_HINTS: dict[int, str] = {
    401: (
        "paperbox 没收到凭证：WebUI 的 key 在服务端，检查 .env 里的 PAPERBOX_API_KEY 是否为空"
    ),
    403: (
        "paperbox 拒绝了这把 key：可能已吊销或写错（在 paperbox 目录执行 "
        "scripts/manage_keys.py list 查），也可能档位不足"
    ),
}
_ROLE_HINT = (
    "这把 key 的档位不够：导入/重建索引/改元数据需 write，删除需 admin；"
    "用 scripts/manage_keys.py create --role admin 另发一把"
)


def auth_hint(status_code: int, payload: object) -> str | None:
    """Return the actionable hint for an auth failure, or ``None`` for anything else."""
    if status_code not in _AUTH_HINTS:
        return None
    if status_code == 403 and isinstance(payload, dict):
        if "insufficient role" in str(payload.get("detail", "")):
            return _ROLE_HINT
    return _AUTH_HINTS[status_code]


def passthrough(response: PaperboxResponse) -> JSONResponse:
    """Relay a paperbox error body and status code to the browser unchanged.

    Auth failures additionally carry a ``hint`` key: the BFF owns the key, so the
    person looking at the browser cannot see why paperbox refused it.
    """
    payload = response.json()
    if payload is None:
        payload = {"detail": response.content.decode("utf-8", "replace") or "paperbox error"}
    hint = auth_hint(response.status_code, payload)
    if hint is not None and isinstance(payload, dict):
        payload = {**payload, "hint": hint}
    return JSONResponse(
        status_code=response.status_code,
        content=payload,
        headers=forward_headers(response),
    )


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
