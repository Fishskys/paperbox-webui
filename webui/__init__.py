"""paperbox WebUI: a thin FastAPI BFF in front of the paperbox REST API.

``__version__`` is the single Python source of the version this app reports
(``FastAPI(version=...)``, visible in ``/docs`` and ``/openapi.json``) -- the same
shape paperbox uses with ``app/__init__.py``. When bumping, change it together with
``pyproject.toml`` and the regenerated ``uv.lock`` (AGENTS.md §4.1): a lockfile left
behind is silently rewritten by the next ``uv`` command, which shows up as a stray
diff rather than an error.
"""

__version__ = "0.7.0"
