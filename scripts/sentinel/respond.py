"""
Sentinel 대응 단계: 탐지(findings) 이후 알림·로그·(선택) 게이트웨이 연산자 RPC.

구현 시 `docs/sentinel.md`의 정책(기본 알림만, sessions.abort는 명시 옵션)을 따른다.
"""

from __future__ import annotations


def main() -> None:
    raise SystemExit(
        "respond: 스텁입니다. ingest/detect와 연결하고 알림·선택 RPC를 구현하세요."
    )


if __name__ == "__main__":
    main()
