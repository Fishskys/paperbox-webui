"""``GET /api/ui/consistency`` - the three-way drift report, proxied.

paperbox's ``GET /api/consistency`` is read-only and **never raises**: when a
store is unreachable it still answers 200 and names the store in ``errors[]``
(``app/services/consistency_service.py``). This router must preserve that -- a
report with errors is still a report, and turning it into a 5xx would hide the
two stores that did answer.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from ..client import PaperboxClient, PaperboxUnreachable
from .deps import forward_headers, get_client, passthrough, unreachable

router = APIRouter()

#: How many problem papers to list; totals are exact regardless of this.
DEFAULT_PROBLEM_LIMIT = 200


@router.get("/consistency")
async def consistency(
    limit: int = Query(DEFAULT_PROBLEM_LIMIT, ge=1, le=1000),
    client: PaperboxClient = Depends(get_client),
) -> JSONResponse:
    """Relay the drift report (PostgreSQL vs MinIO vs OpenSearch)."""
    try:
        response = await client.consistency(limit=limit)
    except PaperboxUnreachable as exc:
        return unreachable(exc)
    if response.ok:
        return JSONResponse(
            status_code=response.status_code,
            content=response.json(),
            headers=forward_headers(response),
        )
    return passthrough(response)
