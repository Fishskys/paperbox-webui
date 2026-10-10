"""WebUI 侧的时区口径（与 paperbox 同口径，2026-10-10）。"""

from __future__ import annotations

import os
from datetime import datetime, timedelta
from pathlib import Path

import webui.config  # noqa: F401  -- 导入期设定进程时区

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_the_process_timezone_defaults_to_shanghai() -> None:
    assert os.environ.get("TZ") == "Asia/Shanghai"


def test_local_time_is_utc_plus_eight() -> None:
    assert datetime.now().astimezone().utcoffset() == timedelta(hours=8)


def test_env_examples_document_it() -> None:
    """样例文件里要写出来，否则下一个人部署时不会知道自己该不该设。"""
    example = (REPO_ROOT / ".env.example").read_text(encoding="utf-8")
    assert "TZ=Asia/Shanghai" in example
