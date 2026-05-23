"""SSOT 검증 — UI(`scenarioRegistry.ts`)와 runner(`send_scenario.py`)의 기본 메시지가 동일한지 확인.

UI/러너 기본 메시지가 어긋나면 시나리오 재현이 깨진다.
이 테스트는 정규식으로 .ts 파일을 파싱해 양쪽 상수를 직접 비교한다.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"
REGISTRY_TS = REPO_ROOT / "security-viz" / "src" / "scenarioRegistry.ts"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from runner.send_scenario import (  # noqa: E402
    S1_DEFAULT_MESSAGE,
    S2_DEFAULT_MESSAGE,
    S3_DEFAULT_MESSAGE,
    DEFAULT_MESSAGE_BY_SCENARIO,
)


def _read_registry() -> str:
    assert REGISTRY_TS.is_file(), f"missing {REGISTRY_TS}"
    return REGISTRY_TS.read_text(encoding="utf-8")


def _extract_const(text: str, name: str) -> str:
    """`export const NAME = "..."` 또는 `export const NAME = "..." + "...";` 추출.

    여러 줄에 걸친 문자열 concat 표현도 지원한다.
    """
    m = re.search(
        rf"export\s+const\s+{re.escape(name)}\s*=\s*([\s\S]*?);",
        text,
    )
    assert m, f"{name} not found in scenarioRegistry.ts"
    return _eval_ts_string_expr(m.group(1))


def _extract_entry_default_message(text: str, scenario_id: str) -> str:
    """SCENARIO_REGISTRY 배열에서 id가 scenario_id인 항목의 defaultMessage 값을 추출."""
    block = re.search(
        rf"id:\s*\"{re.escape(scenario_id)}\"[\s\S]*?defaultMessage:\s*([\s\S]*?),\s*(?:requiredTools|\}})",
        text,
    )
    assert block, f"defaultMessage for {scenario_id} not found"
    return _eval_ts_string_expr(block.group(1))


def _eval_ts_string_expr(expr: str) -> str:
    """간단한 TS 문자열 표현(상수 참조/리터럴/+concat)을 파이썬 문자열로 평가.

    지원: "..." | '...' | `...` | A + B | A_BAR_BAZ (식별자→registry로 재귀 조회)
    """
    text = _read_registry()  # 식별자 참조용
    pieces = _tokenize_concat(expr.strip())
    out: list[str] = []
    for p in pieces:
        p = p.strip()
        if not p:
            continue
        if (p.startswith('"') and p.endswith('"')) or (p.startswith("'") and p.endswith("'")) or (p.startswith("`") and p.endswith("`")):
            # 따옴표 안의 문자열 — 이스케이프는 단순 처리(데모 메시지에 \는 거의 없음)
            inner = p[1:-1]
            out.append(inner)
        elif re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", p):
            out.append(_extract_const(text, p))
        else:
            raise AssertionError(f"unsupported TS expression: {p!r}")
    return "".join(out)


def _tokenize_concat(expr: str) -> list[str]:
    """`"a" + "b" + IDENT` 형태를 quote-aware split."""
    parts: list[str] = []
    buf: list[str] = []
    i = 0
    while i < len(expr):
        ch = expr[i]
        if ch in ("\"", "'", "`"):
            j = i + 1
            while j < len(expr) and expr[j] != ch:
                if expr[j] == "\\":
                    j += 2
                    continue
                j += 1
            buf.append(expr[i : j + 1])
            i = j + 1
            continue
        if ch == "+":
            parts.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    parts.append("".join(buf))
    return parts


def test_s1_default_message_matches() -> None:
    ts = _extract_entry_default_message(_read_registry(), "S1")
    assert ts == S1_DEFAULT_MESSAGE


def test_s2_default_message_matches() -> None:
    ts = _extract_entry_default_message(_read_registry(), "S2")
    assert ts == S2_DEFAULT_MESSAGE


def test_s3_default_message_matches() -> None:
    ts = _extract_entry_default_message(_read_registry(), "S3")
    assert ts == S3_DEFAULT_MESSAGE


def test_default_message_by_scenario_covers_active() -> None:
    """runner의 DEFAULT_MESSAGE_BY_SCENARIO가 S1/S2/S3을 모두 포함하는지."""
    assert set(DEFAULT_MESSAGE_BY_SCENARIO.keys()) >= {"S1", "S2", "S3"}
