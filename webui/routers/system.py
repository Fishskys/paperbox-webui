"""``GET /api/ui/health`` - liveness plus paper/job counters."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..client import PaperboxClient, PaperboxUnreachable
from .deps import get_client

router = APIRouter()

UNKNOWN_VERSION = "unknown"


def _total(payload: object) -> int | None:
    if isinstance(payload, dict) and isinstance(payload.get("total"), int):
        return payload["total"]
    return None


@router.get("/health")
async def health(client: PaperboxClient = Depends(get_client)) -> dict:
    """Aggregate paperbox health; a failing sub-call must not fail the endpoint."""
    try:
        health_response = await client.health()
    except PaperboxUnreachable as exc:
        return {
            "paperbox": {"error": f"unreachable: {exc.message}"},
            "version": UNKNOWN_VERSION,
            "papers": None,
            "jobs": None,
        }

    paperbox_health = health_response.json() or {}
    services = paperbox_health.get("services")
    if not health_response.ok:
        services = {"error": f"paperbox /health returned {health_response.status_code}"}
    elif not isinstance(services, dict):
        services = {}

    version = paperbox_health.get("version") or UNKNOWN_VERSION

    papers = None
    jobs = None
    try:
        papers = _total((await client.list_papers()).json())
    except PaperboxUnreachable:
        papers = None
    try:
        jobs = _total((await client.list_jobs()).json())
    except PaperboxUnreachable:
        jobs = None

    return {
        "paperbox": services,
        "version": version,
        "papers": papers,
        "jobs": jobs,
    }
