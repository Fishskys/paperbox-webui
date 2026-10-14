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


def _dependencies(payload: dict) -> dict:
    """Per-dependency detail (``status`` / ``latency_ms`` / ``checked_at`` / ``reason``).

    paperbox reports it since 2026-10-14; the status bar shows the failure reason
    from here and nothing else needs it, so an older paperbox simply yields ``{}``.
    """
    entries = payload.get("dependencies")
    return entries if isinstance(entries, dict) else {}


@router.get("/health")
async def health(client: PaperboxClient = Depends(get_client)) -> dict:
    """Aggregate paperbox health; a failing sub-call must not fail the endpoint.

    The BFF does not interpret the verdicts: ``services`` / ``degraded`` /
    ``dependencies`` are passed through exactly as paperbox reported them, and the
    frontend decides how to paint them (``webui/static/health-logic.js``).
    """
    try:
        health_response = await client.health()
    except PaperboxUnreachable as exc:
        return {
            "paperbox": {"error": f"unreachable: {exc.message}"},
            "degraded": None,
            "dependencies": {},
            "version": UNKNOWN_VERSION,
            "papers": None,
            "jobs": None,
        }

    paperbox_health = health_response.json() or {}
    if health_response.ok:
        services = paperbox_health.get("services")
        services = services if isinstance(services, dict) else {}
        reported = paperbox_health.get("degraded")
        degraded = reported if isinstance(reported, bool) else None
        dependencies = _dependencies(paperbox_health)
    else:
        services = {"error": f"paperbox /health returned {health_response.status_code}"}
        degraded = None
        dependencies = {}

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
        "degraded": degraded,
        "dependencies": dependencies,
        "version": version,
        "papers": papers,
        "jobs": jobs,
    }
