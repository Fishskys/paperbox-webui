"""Metadata endpoints: import, review queue, human attach, batch apply.

The four routes below proxy paperbox's ``/api/metadata/*`` one-for-one; the
frontend's "元数据" tab drives them in that order:

1. ``POST /api/ui/metadata/import``  -- upload a record file (or paste JSON).
   **dry_run is the default on both sides**: nothing is written unless the caller
   asks for it, and re-importing the same record is a no-op either way.
2. ``GET  /api/ui/metadata/review``  -- the records waiting for a human decision,
   plus the conflicts two structured sources disagreed about.
3. ``POST /api/ui/metadata/sources/{id}/attach`` -- the human answer: "this
   record belongs to that paper".
4. ``POST /api/ui/metadata/apply``   -- replay a report's decisions in bulk.

Two rules this router keeps:

* the multipart part is relayed as a **file handle** (``upload.file``), not
  ``await upload.read()``, so a large record set is streamed through this process
  rather than buffered in it;
* no local whitelist of ``source_type`` values -- paperbox owns that list and its
  422 is passed through, so the two can never drift apart.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Query, Request
from fastapi.responses import JSONResponse

from ..client import PaperboxClient, PaperboxUnreachable
from .deps import forward_headers, get_client, passthrough, unreachable

router = APIRouter()

DEFAULT_REVIEW_LIMIT = 50
MISSING_FILE_PART = "multipart request must carry a 'file' part"
UNSUPPORTED_MEDIA = "send the records as multipart/form-data (file) or application/json"


@router.post("/metadata/import")
async def import_metadata(
    request: Request,
    dry_run: bool = Query(default=True, description="report only (the default)"),
    apply: bool | None = Query(
        default=None, description="write the changes (overrides dry_run)"
    ),
    limit: int | None = Query(default=None, ge=1),
    source_type: str | None = Query(
        default=None, description="label for the records; paperbox defaults to import_file"
    ),
    client: PaperboxClient = Depends(get_client),
) -> JSONResponse:
    """Forward a record set as multipart ``file`` or as a JSON body."""
    params = {
        "dry_run": dry_run,
        "apply": apply,
        "limit": limit,
        "source_type": source_type,
    }
    content_type = (request.headers.get("content-type") or "").lower()
    try:
        if "multipart/form-data" in content_type:
            form = await request.form()
            upload = form.get("file")
            if upload is None or not hasattr(upload, "read"):
                return JSONResponse(
                    status_code=422, content={"detail": MISSING_FILE_PART}
                )
            handle = getattr(upload, "file", None) or upload
            response = await client.import_metadata(
                params=params,
                file=(
                    getattr(upload, "filename", None) or "records.json",
                    handle,
                    getattr(upload, "content_type", None) or "application/json",
                ),
            )
        elif "application/json" in content_type:
            response = await client.import_metadata(
                params=params, payload=await request.json()
            )
        else:
            return JSONResponse(
                status_code=415, content={"detail": UNSUPPORTED_MEDIA}
            )
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    except ValueError as exc:  # malformed JSON body
        return JSONResponse(status_code=422, content={"detail": f"invalid JSON: {exc}"})
    return _json(response)


@router.get("/metadata/review")
async def metadata_review(
    status: list[str] | None = Query(default=None),
    limit: int = Query(DEFAULT_REVIEW_LIMIT, ge=1, le=200),
    client: PaperboxClient = Depends(get_client),
) -> JSONResponse:
    """Records awaiting a decision (``status`` may repeat) and known conflicts."""
    try:
        response = await client.metadata_review(status=status, limit=limit)
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


@router.post("/metadata/sources/{source_id}/attach")
async def attach_source(
    source_id: str,
    body: dict[str, Any] = Body(...),
    client: PaperboxClient = Depends(get_client),
) -> JSONResponse:
    """Attach one stored record to a paper; the body is relayed verbatim."""
    try:
        response = await client.attach_source(
            source_id, str(body.get("paper_id") or "")
        )
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    return _json(response)


@router.post("/metadata/apply")
async def apply_metadata(
    body: dict[str, Any] = Body(...),
    client: PaperboxClient = Depends(get_client),
) -> JSONResponse:
    """Apply a batch of decisions (``entries`` / ``mode`` / ``fields``)."""
    try:
        response = await client.apply_metadata(body)
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
