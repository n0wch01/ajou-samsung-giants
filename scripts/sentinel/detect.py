#!/usr/bin/env python3
"""
Sentinel Detect — trace.jsonl → findings JSON

배치 모드: trace.jsonl을 읽어 YAML 규칙으로 평가 → findings JSON 출력
실시간 모드: RealTimeRateDetector 클래스를 run_scenario.py에서 임포트하여 사용

S3(API Abuse) 지원 match_type:
  rate_limit        : 슬라이딩 윈도우 내 툴 호출 횟수 초과
  loop_detect       : 동일 인자 연속 호출 패턴 (무한 루프)
  event_sequence    : 순서 있는 이벤트 체인 탐지
  trace_line_regex  : trace 전체 텍스트 regex 검색
  tools_effective_diff : baseline 대비 신규 툴 등장

환경 변수:
  SENTINEL_TRACE_PATH          — 기본 <sentinel>/data/trace.jsonl
  SENTINEL_RULES_DIR           — 기본 <sentinel>/rules
  SENTINEL_BASELINE_TOOLS_PATH — (선택) baseline JSON
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


# ── 공통 헬퍼 ─────────────────────────────────────────────────────────────────

def _load_trace(path: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    except FileNotFoundError:
        pass
    return entries


def _load_yaml_rules(rules_dir: Path) -> list[dict[str, Any]]:
    rules: list[dict[str, Any]] = []
    if not rules_dir.exists():
        print(f"[detect] 규칙 디렉토리 없음: {rules_dir}", file=sys.stderr)
        return rules
    for f in sorted(rules_dir.glob("*.yaml")):
        raw = yaml.safe_load(f.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            continue
        # 파일 전체가 규칙 목록인 경우 (rules: [...])
        if "rules" in raw and isinstance(raw["rules"], list):
            for rule in raw["rules"]:
                if isinstance(rule, dict):
                    rule.setdefault("_source", f.name)
                    rules.append(rule)
        # 파일 자체가 단일 규칙인 경우 (rule_id: ...)
        elif "rule_id" in raw:
            raw.setdefault("_source", f.name)
            rules.append(raw)
    print(f"[detect] {len(rules)}개 규칙 로드", file=sys.stderr)
    return rules


def _load_baseline(path: Path | None) -> set[str]:
    if path is None or not path.exists():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return set()

    names: set[str] = set()

    def walk(x: Any) -> None:
        if isinstance(x, dict):
            for k in ("name", "tool", "toolName", "id", "fullName"):
                v = x.get(k)
                if isinstance(v, str) and v.strip():
                    names.add(v.strip())
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(data)
    return names


def _finding(
    *,
    rule_id: str,
    severity: str,
    title: str,
    message: str,
    recommended_action: str = "",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    f: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "ruleId": rule_id,
        "severity": severity,
        "title": title,
        "message": message,
        "detectedAt": datetime.now(timezone.utc).isoformat(),
    }
    if recommended_action:
        f["recommendedAction"] = recommended_action
    if extra:
        f.update(extra)
    return f


def _extract_tool_from_entry(entry: dict[str, Any]) -> str | None:
    """gateway_event trace 항목에서 툴 이름 추출."""
    norm = entry.get("normalized", {})
    if norm.get("kind") != "session.tool":
        return None
    return (
        norm.get("name")
        or norm.get("tool")
        or norm.get("toolName")
        or "unknown"
    )


# ── 배치 규칙 평가 ─────────────────────────────────────────────────────────────

def _eval_rule(
    rule: dict[str, Any],
    entries: list[dict[str, Any]],
    baseline: set[str],
) -> list[dict[str, Any]]:
    """규칙 하나를 trace entries에 대해 평가하고 findings 반환."""
    match_type = rule.get("match_type", "")
    rule_id = rule.get("rule_id", "unknown")
    severity = rule.get("severity", "medium")
    title = rule.get("name", rule_id)
    rec_action = rule.get("recommendedAction", rule.get("recommended_action", ""))
    findings: list[dict[str, Any]] = []

    # ── rate_limit ─────────────────────────────────────────────────────────
    if match_type == "rate_limit":
        cond = rule.get("conditions", {})
        window_sec = float(cond.get("window_seconds", 30))
        max_calls = int(cond.get("max_calls", 10))
        target_tools: list[str] | None = cond.get("tools")

        call_times: dict[str, list[float]] = defaultdict(list)
        for entry in entries:
            if entry.get("entry_type") != "gateway_event":
                continue
            tool = _extract_tool_from_entry(entry)
            if tool is None:
                continue
            if target_tools and tool not in target_tools:
                continue
            ts_ms = entry.get("ts_ms")
            if ts_ms:
                call_times[tool].append(ts_ms / 1000.0)

        for tool, times in call_times.items():
            times_sorted = sorted(times)
            max_in_window = 0
            for i, t in enumerate(times_sorted):
                count = sum(1 for t2 in times_sorted if t <= t2 <= t + window_sec)
                if count > max_in_window:
                    max_in_window = count

            if max_in_window >= max_calls:
                msg_tpl = rule.get("message", "API Abuse 탐지: {tool}이 {window:.0f}초 내 {count}회 호출됨 (임계값: {max})")
                findings.append(_finding(
                    rule_id=rule_id,
                    severity=severity,
                    title=title,
                    message=msg_tpl.format(tool=tool, window=window_sec, count=max_in_window, max=max_calls),
                    recommended_action=rec_action,
                    extra={"tool": tool, "callCount": max_in_window, "windowSeconds": window_sec},
                ))

    # ── loop_detect ────────────────────────────────────────────────────────
    elif match_type == "loop_detect":
        cond = rule.get("conditions", {})
        max_consecutive = int(cond.get("max_identical_consecutive", 5))
        target_tools: list[str] | None = cond.get("tools")

        tool_calls: list[tuple[str, str]] = []
        for entry in entries:
            if entry.get("entry_type") != "gateway_event":
                continue
            tool = _extract_tool_from_entry(entry)
            if tool is None:
                continue
            if target_tools and tool not in target_tools:
                continue
            raw_payload = entry.get("raw_frame", {}).get("payload", {})
            args = json.dumps(
                raw_payload.get("input", raw_payload.get("args", {})),
                sort_keys=True,
            )
            tool_calls.append((tool, args))

        seen_loops: set[tuple[str, str]] = set()
        for i in range(len(tool_calls)):
            key = tool_calls[i]
            if key in seen_loops:
                continue
            count = 0
            j = i
            while j < len(tool_calls) and tool_calls[j] == key:
                count += 1
                j += 1
            if count >= max_consecutive:
                seen_loops.add(key)
                tool, _ = key
                findings.append(_finding(
                    rule_id=rule_id,
                    severity=severity,
                    title=title,
                    message=f"루프 탐지: {tool}이 동일 인자로 {count}회 연속 호출됨",
                    recommended_action=rec_action,
                    extra={"tool": tool, "consecutiveCount": count},
                ))

    # ── event_sequence ─────────────────────────────────────────────────────
    elif match_type == "event_sequence":
        seq = rule.get("sequence", [])
        if not seq:
            return findings
        events_only = [e for e in entries if e.get("entry_type") == "gateway_event"]
        step = 0
        first_ts: float | None = None
        last_ts: float | None = None
        for entry in events_only:
            if step >= len(seq):
                break
            pattern = seq[step].get("event_regex") or seq[step].get("event", "")
            event_name = entry.get("event_name", "")
            if pattern and re.search(pattern, event_name or ""):
                if step == 0:
                    first_ts = entry.get("ts_ms")
                last_ts = entry.get("ts_ms")
                step += 1
        if step >= len(seq):
            elapsed_ms = (last_ts - first_ts) if (first_ts and last_ts) else None
            max_window = rule.get("conditions", {}).get("max_window_seconds")
            if max_window and elapsed_ms and elapsed_ms / 1000 > max_window:
                return findings
            findings.append(_finding(
                rule_id=rule_id,
                severity=severity,
                title=title,
                message=rule.get("message", f"이벤트 시퀀스 탐지: {[s.get('event') for s in seq]}"),
                recommended_action=rec_action,
                extra={"elapsed_ms": elapsed_ms},
            ))

    # ── trace_line_regex ───────────────────────────────────────────────────
    elif match_type == "trace_line_regex":
        pattern = rule.get("pattern", "")
        if not pattern:
            return findings
        flags = re.IGNORECASE if rule.get("ignore_case", True) else 0
        compiled = re.compile(pattern, flags)
        matches: list[str] = []
        for entry in entries:
            line = json.dumps(entry, ensure_ascii=False)
            if compiled.search(line):
                matches.append(entry.get("event_name", entry.get("entry_type", "?")))
        if matches:
            findings.append(_finding(
                rule_id=rule_id,
                severity=severity,
                title=title,
                message=rule.get("message", f"패턴 탐지: {pattern!r} — {len(matches)}개 항목 매칭"),
                recommended_action=rec_action,
                extra={"matchCount": len(matches)},
            ))

    # ── tools_effective_diff ───────────────────────────────────────────────
    elif match_type == "tools_effective_diff":
        current_tools: set[str] = set()
        for entry in entries:
            if entry.get("entry_type") == "tools_snapshot":
                names = entry.get("payload_summary", {}).get("tool_names", [])
                current_tools.update(names)
        new_tools = current_tools - baseline
        if new_tools and baseline:
            findings.append(_finding(
                rule_id=rule_id,
                severity=severity,
                title=title,
                message=f"기준 대비 신규 툴 감지: {sorted(new_tools)}",
                recommended_action=rec_action,
                extra={"newTools": sorted(new_tools)},
            ))

    return findings


def run_detect(
    trace_path: Path,
    rules_dir: Path,
    baseline_path: Path | None = None,
) -> dict[str, Any]:
    """배치 모드: trace.jsonl → findings JSON dict."""
    entries = _load_trace(trace_path)
    rules = _load_yaml_rules(rules_dir)
    baseline = _load_baseline(baseline_path)

    all_findings: list[dict[str, Any]] = []
    for rule in rules:
        found = _eval_rule(rule, entries, baseline)
        all_findings.extend(found)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "findings": all_findings,
        "meta": {
            "trace_path": str(trace_path),
            "rules_dir": str(rules_dir),
            "baseline_path": str(baseline_path) if baseline_path else None,
            "rules_loaded": len(rules),
            "trace_rows": len(entries),
        },
    }


# ── 실시간 탐지기 (run_scenario.py에서 임포트) ────────────────────────────────

class RealTimeRateDetector:
    """
    슬라이딩 윈도우 + 루프 탐지 실시간 탐지기.
    ingest.on_event() 콜백에서 호출되어 즉각 abort 여부를 반환한다.
    """

    def __init__(self, rules: list[dict[str, Any]]):
        self._rules = [r for r in rules if r.get("match_type") in ("rate_limit", "loop_detect")]
        # tool별 호출 타임스탬프 (슬라이딩 윈도우)
        self._call_times: dict[str, list[float]] = defaultdict(list)
        # tool별 (args) 연속 호출 추적
        self._consecutive: dict[str, list[str]] = defaultdict(list)

    def process(self, normalized: dict[str, Any]) -> list[dict[str, Any]]:
        """
        정규화된 이벤트를 받아 탐지된 findings 목록을 반환.
        반환값이 비어있으면 정상, 있으면 abort 대상.
        """
        if normalized.get("kind") != "session.tool":
            return []

        tool = (
            normalized.get("name")
            or normalized.get("tool")
            or normalized.get("toolName")
            or "unknown"
        )
        import time as _time
        now = _time.time()
        findings: list[dict[str, Any]] = []

        for rule in self._rules:
            cond = rule.get("conditions", {})
            rule_id = rule.get("rule_id", "unknown")
            severity = rule.get("severity", "high")
            title = rule.get("name", rule_id)
            rec = rule.get("recommendedAction", rule.get("recommended_action", ""))
            target_tools: list[str] | None = cond.get("tools")

            if target_tools and tool not in target_tools:
                continue

            if rule.get("match_type") == "rate_limit":
                window_sec = float(cond.get("window_seconds", 30))
                max_calls = int(cond.get("max_calls", 10))
                warning_threshold = rule.get("actions", {}).get("on_warning", {}).get("threshold", max_calls - 3)

                calls = self._call_times[tool]
                calls.append(now)
                # 윈도우 밖 제거
                cutoff = now - window_sec
                while calls and calls[0] < cutoff:
                    calls.pop(0)

                count = len(calls)
                if count >= warning_threshold and count < max_calls:
                    print(f"[detect] WARNING: {tool} {window_sec:.0f}초 내 {count}회 호출", file=sys.stderr)
                if count >= max_calls:
                    msg_tpl = rule.get("message", "API Abuse 탐지: {tool}이 {window:.0f}초 내 {count}회 호출됨 (임계값: {max})")
                    findings.append(_finding(
                        rule_id=rule_id,
                        severity=severity,
                        title=title,
                        message=msg_tpl.format(tool=tool, window=window_sec, count=count, max=max_calls),
                        recommended_action=rec,
                        extra={"tool": tool, "callCount": count, "windowSeconds": window_sec},
                    ))

            elif rule.get("match_type") == "loop_detect":
                max_consecutive = int(cond.get("max_identical_consecutive", 5))
                args_key = normalized.get("text_preview", "")

                seq = self._consecutive[tool]
                if seq and seq[-1] == args_key:
                    seq.append(args_key)
                else:
                    self._consecutive[tool] = [args_key]
                    seq = self._consecutive[tool]

                if len(seq) >= max_consecutive:
                    findings.append(_finding(
                        rule_id=rule_id + "-realtime",
                        severity=severity,
                        title=title,
                        message=f"루프 탐지: {tool}이 동일 컨텍스트로 {len(seq)}회 연속 호출됨",
                        recommended_action=rec,
                        extra={"tool": tool, "consecutiveCount": len(seq)},
                    ))

        return findings

    def reset(self) -> None:
        self._call_times.clear()
        self._consecutive.clear()


# ── 독립 실행 모드 ────────────────────────────────────────────────────────────

def _default_trace_path() -> Path:
    return Path(__file__).resolve().parent / "data" / "trace.jsonl"


def _default_rules_dir() -> Path:
    return Path(__file__).resolve().parent / "rules"


def main() -> None:
    p = argparse.ArgumentParser(description="Sentinel detect: trace.jsonl → findings JSON")
    p.add_argument("--trace", default=None, help="trace.jsonl 경로")
    p.add_argument("--rules", default=None, help="규칙 디렉토리 경로")
    p.add_argument("--baseline", default=None, help="baseline tools JSON 경로")
    p.add_argument("--out", default=None, help="findings JSON 저장 경로")
    args = p.parse_args()

    trace_path = Path(
        args.trace
        or os.environ.get("SENTINEL_TRACE_PATH")
        or str(_default_trace_path())
    )
    rules_dir = Path(
        args.rules
        or os.environ.get("SENTINEL_RULES_DIR")
        or str(_default_rules_dir())
    )
    baseline_env = os.environ.get("SENTINEL_BASELINE_TOOLS_PATH", "")
    baseline_path = Path(args.baseline) if args.baseline else (Path(baseline_env) if baseline_env else None)

    result = run_detect(trace_path, rules_dir, baseline_path)
    output = json.dumps(result, ensure_ascii=False, indent=2)
    print(output)

    if args.out:
        Path(args.out).write_text(output, encoding="utf-8")
        print(f"[detect] findings → {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
