"""FastAPI entry point: static assets plus the ``/api/ui`` proxy routers."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from .client import PaperboxClient
from .config import STATIC_DIR, get_settings
from .routers import actions, ingest, jobs, papers, search, system
from .routers import config as config_router

INDEX_FILE = STATIC_DIR / "index.html"

PLACEHOLDER_HTML = """<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>paperbox WebUI</title>
  </head>
  <body>
    <h1>paperbox WebUI</h1>
    <p>前端页面将在下一步实现，当前仅提供后端 API：</p>
    <ul>
      <li><code>GET /api/ui/health</code></li>
      <li><code>GET /api/ui/papers</code></li>
      <li><code>POST /api/ui/search</code></li>
    </ul>
  </body>
</html>
"""

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Create one shared paperbox client and close it on shutdown."""
    app.state.paperbox = PaperboxClient(get_settings())
    try:
        yield
    finally:
        await app.state.paperbox.aclose()


def create_app() -> FastAPI:
    app = FastAPI(title="paperbox WebUI", version="0.1.0", lifespan=lifespan)

    for module in (system, config_router, papers, jobs, ingest, search, actions):
        app.include_router(module.router, prefix="/api/ui", tags=[module.__name__.rsplit(".", 1)[-1]])

    @app.get("/", response_class=HTMLResponse)
    async def index() -> HTMLResponse:
        """Serve the SPA shell; fall back to a placeholder until the frontend lands."""
        if INDEX_FILE.is_file():
            return HTMLResponse(INDEX_FILE.read_text(encoding="utf-8"))
        return HTMLResponse(PLACEHOLDER_HTML)

    if STATIC_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    return app


app = create_app()
