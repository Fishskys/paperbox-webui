"""``GET /api/ui/config`` - the upload tuning the frontend must not hardcode.

The queue reads its concurrency, retry budget and file cap from here at boot
(SPEC section 4). Failing to fetch it is not fatal: the browser keeps built-in
defaults and still uploads.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..config import Settings, get_settings

router = APIRouter()


@router.get("/config")
async def config(settings: Settings = Depends(get_settings)) -> dict[str, int]:
    """Return the queue tuning; ``file_max_mb`` mirrors paperbox's own cap."""
    return {
        "upload_concurrency": settings.webui_upload_concurrency,
        "upload_max_attempts": settings.webui_upload_max_attempts,
        "retry_base_ms": settings.webui_retry_base_ms,
        "retry_cap_ms": settings.webui_retry_cap_ms,
        "file_max_mb": settings.webui_file_max_mb,
        "batch_hint_threshold": settings.webui_batch_hint_threshold,
    }
