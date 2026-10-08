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

#: 0.4.x 的其它失败模式。每条 = (状态码, detail 里必须出现的片段, 说明)；
#: 片段为空 = 该状态码下都要说这句。按顺序取第一条命中的，所以更具体的规则排在前面。
#: 这里是**唯一**一处写这些文案的地方：文案零散在 JS 里时，改一处忘一处就不会被发现。
_HINTS: tuple[tuple[int, str, str], ...] = (
    (403, "insufficient role", _ROLE_HINT),
    (401, "", _AUTH_HINTS[401]),
    # 目录导入：root 越界是 paperbox 侧的目录授权，与 key 档位无关，不能与上一条混说
    (
        403,
        "whitelist",
        "目录导入只收 INGEST_LOCAL_ROOTS 白名单内的路径（.. 逃逸与软链目录同样被拒）："
        "把 root 换成白名单里的目录，或让 paperbox 的 .env 加上这个目录再重启",
    ),
    (403, "", _AUTH_HINTS[403]),
    (
        404,
        "disabled",
        "该端点没开：paperbox 的 INGEST_LOCAL_ROOTS 为空时不提供目录导入，"
        "在 paperbox 的 .env 里填上允许的目录再重启",
    ),
    (
        404,
        "not a directory",
        "root 不存在或不是目录：路径是 **paperbox 所在机器**上的绝对路径（不是浏览器里的目录），"
        "且必须是目录而非文件",
    ),
    (
        413,
        "bytes exceeds",
        "总字节超 paperbox 的 INGEST_MAX_REQUEST_MB（默认 200 MB）：拆成几批再传。"
        "注意 WebUI 侧只预筛单文件（WEBUI_FILE_MAX_MB，默认 100 MB），管不了整批总量",
    ),
    (
        413,
        "",
        "请求体超 paperbox 的 8 MB JSON 上限：这是单次请求的参数体过大，不是文件太大",
    ),
    (
        415,
        "",
        "只认 zip：7z / rar / tar 都不收（paperbox 先看魔数）。把文件夹重新压成 .zip 再传；"
        "单篇论文直接用普通上传，不必打包",
    ),
    (
        422,
        "unpack",
        "压缩包解不开：确认是完整下载的 zip（截断或加密的包都会在这里被拒）",
    ),
    (
        429,
        "",
        "paperbox 在途上传或队列水位到顶：按 Retry-After 等一会儿再传，别立刻重试",
    ),
    (
        502,
        "",
        "paperbox 本身没起来或崩了（WebUI 连不上后端）：看 paperbox 日志与 /health；"
        "0.4.1 起向量维度对账不过会拒绝启动，见 paperbox docs/architecture/04-embedding.md §5b/§9",
    ),
)


def error_hint(
    status_code: int, payload: object, retry_after: str | None = None
) -> str | None:
    """Return the actionable hint for a failure, or ``None`` when we have nothing to add.

    ``payload`` is only used for its ``detail``; an unrecognised status returns ``None``
    on purpose -- passing paperbox's own message through beats inventing a wrong one.
    """
    detail = ""
    if isinstance(payload, dict):
        detail = str(payload.get("detail", ""))
    for status, fragment, hint in _HINTS:
        if status != status_code:
            continue
        if fragment and fragment not in detail:
            continue
        if status_code == 429 and retry_after:
            return f"{hint}（Retry-After: {retry_after} s）"
        return hint
    return None


#: 兼容旧名：鉴权失败的那条曾单独实现过。
auth_hint = error_hint


def passthrough(response: PaperboxResponse) -> JSONResponse:
    """Relay a paperbox error body and status code to the browser unchanged.

    Auth failures additionally carry a ``hint`` key: the BFF owns the key, so the
    person looking at the browser cannot see why paperbox refused it.
    """
    payload = response.json()
    if payload is None:
        payload = {"detail": response.content.decode("utf-8", "replace") or "paperbox error"}
    hint = error_hint(
        response.status_code, payload, response.headers.get("retry-after")
    )
    if hint is not None and isinstance(payload, dict):
        payload = {**payload, "hint": hint}
    return JSONResponse(
        status_code=response.status_code,
        content=payload,
        headers=forward_headers(response),
    )


def unreachable(exc: PaperboxUnreachable) -> JSONResponse:
    """paperbox is down (connection refused, timeout, DNS failure) -> HTTP 502."""
    payload: dict[str, object] = {"detail": f"paperbox unreachable: {exc.message}"}
    hint = error_hint(502, payload)
    if hint:
        payload["hint"] = hint
    return JSONResponse(status_code=502, content=payload)


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
