"""Configuration for the paperbox WebUI backend (pydantic-settings, reads .env)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = Path(__file__).resolve().parent / "static"


class Settings(BaseSettings):
    """Runtime settings; values come from the environment or the repository .env."""

    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    paperbox_api_base: str = "http://127.0.0.1:8077"
    paperbox_api_key: str = ""
    webui_host: str = "0.0.0.0"
    webui_port: int = 8088
    request_timeout: float = 30.0

    @property
    def ingest_timeout(self) -> float:
        """Ingestion is slower than the regular calls (SPEC 3: 60s)."""
        return max(self.request_timeout, 60.0)


@lru_cache
def get_settings() -> Settings:
    return Settings()
