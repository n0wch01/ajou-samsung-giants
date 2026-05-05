#!/usr/bin/env python3
"""
trace.jsonl + 선언적 rules/*.yaml + tools.effective 베이스라인 diff → findings JSON.

환경 변수:
  SENTINEL_TRACE_PATH
  SENTINEL_RULES_DIR      — 기본 scripts/sentinel/rules
  SENTINEL_BASELINE_TOOLS_PATH — tools.effective 이름 베이스라인 JSON
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

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
SENTINEL_DIR = Path(__file__).resolve().parent


def _default_rules_dir() -> Path:
    return SENTINEL_DIR / "rules"


def _default_trace_path() -> Path:
    return SENTINEL_DIR / "data" / "trace.jsonl"


def _default_baseline_path() -> Path:
    return SENTINEL_DIR / "data" / "baseline-tools-effective.example.json"


def _load_trace(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    out: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def _load_yaml_rules(rules_dir: Path) -> list[dict[str, Any]]:
    rules: list[dict[str, Any]] = []
    if not rules_dir.is_dir():
        return rules
    for p in sorted(rules_dir.glob("*.yaml")):
        raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        for i, r in enumerate(raw.get("rules") or []):
            if isinstance(r, dict):
                r = dict(r)
                r["_source"] = f"{p.name}#{i}"
                rules.append(r)
    return rules


def _load_baseline(path: Path | None) -> set[str]:
    if path is None or not path.is_file():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    names = data.get("tool_names")
    if isinstance(names, list):
        return {str(x) for x in names if isinstance(x, str)}
    te = data.get("tools_effective")
    return set(_extract_tool_names(te))


def _extract_tool_names(obj: Any) -> list[str]:
    out: list[str] = []

    def walk(x: Any) -> None:
        if isinstance(x, dict):
            for k in ("name", "tool", "toolName", "id", "fullName"):
                v = x.get(k)
                if isinstance(v, str) and v.strip():
                    out.append(v.strip())
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(obj)
    seen: set[str] = set()
    uniq: list[str] = []
    for n in out:
        if n not in seen:
            seen.add(n)
            uniq.append(n)
    return uniq


def _last_tools_effective_names(trace: list[dict[str, Any]]) -> list[str]:
    last: list[str] = []
    for row in trace:
        if row.get("entry_type") != "tools_snapshot":
            continue
        if row.get("rpc_method") != "tools.effective":
            continue
        ps = row.get("payload_summary")
        if isinstance(ps, dict):
            tn = ps.get("tool_names")
            if isinstance(tn, list):
                last = [str(x) for x in tn if isinstance(x, str)]
    return last


def _finding(
    *,
    rule_id: str,
    severity: str,
    title: str,
    message: str,
    recommended_action: str,
) -> dict[str, Any]:
    return {
        "id": f"{rule_id}-{uuid.uuid4()}",
        "ruleId": rule_id,
        "severity": severity,
        "title": title,
        "message": message,
        "recommendedAction": recommended_action,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _tool_name_from_normalized(norm: dict[str, Any]) -> str:
    for k in ("name", "tool", "toolName"):
        v = norm.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return "unknown"


def _args_key_from_event(row: dict[str, Any], norm: dict[str, Any]) -> str:
    """raw_frame.payload(input/args) 우선, 없으면 normalized.text_preview 폴백."""
    raw = row.get("raw_frame")
    if isinstance(raw, dict):
        payload = raw.get("payload")
        if isinstance(payload, dict):
            inner = payload.get("input")
            if not isinstance(inner, (dict, list)):
                inner = payload.get("args")
            if not isinstance(inner, (dict, list)):
                inner = payload
            try:
                return json.dumps(inner, sort_keys=True, ensure_ascii=False)
            except (TypeError, ValueError):
                pass
    preview = norm.get("text_preview")
    return str(preview) if isinstance(preview, str) else ""


def _eval_rule(
    rule: dict[str, Any],
    *,
    trace: list[dict[str, Any]],
    baseline_names: set[str],
    trace_blob: str,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    rid = str(rule.get("id") or rule.get("_source") or "rule")
    sev = str(rule.get("severity") or "medium")
    title = str(rule.get("title") or rid)
    rec_default = str(
        rule.get("recommendedAction")
        or "Inspect gateway events, tighten tool allowlists, and capture a fresh baseline after intentional changes."
    )
    match = rule.get("match")
    if not isinstance(match, dict):
        return out
    mtype = str(match.get("type") or "")

    if mtype == "trace_line_regex":
        pat = str(match.get("pattern") or "")
        if not pat:
            return out
        try:
            cre = re.compile(pat)
        except re.error:
            return out
        if cre.search(trace_blob):
            out.append(
                _finding(
                    rule_id=rid,
                    severity=sev,
                    title=title,
                    message=str(rule.get("message") or f"Pattern matched: {pat}"),
                    recommended_action=rec_default,
                )
            )
        return out

    if mtype == "event_payload_regex":
        event_name = str(match.get("event") or "")
        pat = str(match.get("pattern") or "")
        if not pat or not event_name:
            return out
        try:
            cre = re.compile(pat)
        except re.error:
            return out
        for row in trace:
            if row.get("entry_type") != "gateway_event":
                continue
            if row.get("event_name") != event_name:
                continue
            raw = row.get("raw_frame") if isinstance(row.get("raw_frame"), dict) else row
            blob = json.dumps(raw, ensure_ascii=False)
            if cre.search(blob):
                out.append(
                    _finding(
                        rule_id=rid,
                        severity=sev,
                        title=title,
                        message=str(
                            rule.get("message")
                            or f"Event {event_name} matched /{pat}/"
                        ),
                        recommended_action=rec_default,
                    )
                )
        return out

    if mtype == "event_sequence":
        steps = match.get("steps") or []
        event_name = str(match.get("event") or "session.tool")
        max_gap_s = float(match.get("max_gap_seconds") or 600)
        if len(steps) < 2:
            return out
        # Collect gateway events matching this event name
        relevant: list[tuple[str, dict[str, Any]]] = []
        for row in trace:
            if row.get("entry_type") != "gateway_event":
                continue
            if row.get("event_name") != event_name:
                continue
            ts = str(row.get("recorded_at") or row.get("timestamp") or "")
            raw = row.get("raw_frame") if isinstance(row.get("raw_frame"), dict) else row
            relevant.append((ts, raw))
        if not relevant:
            return out
        # Check each step has at least one matching event, and they appear in order
        import re as _re
        step_matches: list[list[tuple[str, dict[str, Any]]]] = []
        for step in steps:
            pat_s = str(step.get("pattern") or "")
            try:
                cre_s = _re.compile(pat_s)
            except _re.error:
                return out
            matched = [(ts, r) for ts, r in relevant if cre_s.search(json.dumps(r, ensure_ascii=False))]
            step_matches.append(matched)
        # All steps must have at least one match
        if not all(step_matches):
            return out
        # Verify temporal order: earliest match of step[i] must be <= earliest match of step[i+1]
        # Use lexicographic ISO timestamp comparison (works for UTC ISO-8601)
        in_order = True
        for i in range(len(step_matches) - 1):
            earliest_cur = min(ts for ts, _ in step_matches[i]) if step_matches[i] else ""
            earliest_next = min(ts for ts, _ in step_matches[i + 1]) if step_matches[i + 1] else ""
            if earliest_cur and earliest_next and earliest_cur > earliest_next:
                in_order = False
                break
        if in_order:
            out.append(
                _finding(
                    rule_id=rid,
                    severity=sev,
                    title=title,
                    message=str(rule.get("message") or f"Event sequence detected: {[s.get('pattern') for s in steps]}"),
                    recommended_action=rec_default,
                )
            )
        return out

    if mtype == "rate_limit":
        # 슬라이딩 윈도우 내 동일 도구 호출 횟수가 임계를 넘으면 finding.
        window_s = float(match.get("window_seconds") or 30)
        max_calls = int(match.get("max_calls") or 10)
        target_tools = match.get("tools") or None
        by_tool: dict[str, list[float]] = defaultdict(list)
        for row in trace:
            if row.get("entry_type") != "gateway_event":
                continue
            norm = row.get("normalized") or {}
            if norm.get("kind") != "session.tool":
                continue
            tool = _tool_name_from_normalized(norm)
            if target_tools and tool not in target_tools:
                continue
            ts = row.get("ts_ms")
            if not isinstance(ts, (int, float)):
                continue
            by_tool[tool].append(float(ts) / 1000.0)
        for tool, times in by_tool.items():
            times.sort()
            peak = 0
            j = 0
            for i, _t in enumerate(times):
                while j < len(times) and times[j] <= times[i] + window_s:
                    j += 1
                count = j - i
                if count > peak:
                    peak = count
            if peak >= max_calls:
                out.append(
                    _finding(
                        rule_id=rid,
                        severity=sev,
                        title=title,
                        message=str(
                            rule.get("message")
                            or f"{tool} called {peak} times within {window_s:.0f}s window (limit {max_calls})"
                        ),
                        recommended_action=rec_default,
                    )
                )
        return out

    if mtype == "loop_detect":
        # 동일 도구 + 동일 인자 연속 호출이 임계를 넘으면 finding.
        max_consec = int(match.get("max_identical_consecutive") or 5)
        target_tools = match.get("tools") or None
        seq: list[tuple[str, str]] = []
        for row in trace:
            if row.get("entry_type") != "gateway_event":
                continue
            norm = row.get("normalized") or {}
            if norm.get("kind") != "session.tool":
                continue
            tool = _tool_name_from_normalized(norm)
            if target_tools and tool not in target_tools:
                continue
            args_key = _args_key_from_event(row, norm)
            seq.append((tool, args_key))
        reported: set[tuple[str, str]] = set()
        i = 0
        while i < len(seq):
            j = i + 1
            while j < len(seq) and seq[j] == seq[i]:
                j += 1
            run = j - i
            if run >= max_consec and seq[i] not in reported:
                reported.add(seq[i])
                tool_name, _ = seq[i]
                out.append(
                    _finding(
                        rule_id=rid,
                        severity=sev,
                        title=title,
                        message=str(
                            rule.get("message")
                            or f"{tool_name} called {run} times consecutively with identical args"
                        ),
                        recommended_action=rec_default,
                    )
                )
            i = j
        return out

    if mtype == "tools_effective_diff":
        added_pat = str(match.get("added_regex") or ".*")
        try:
            cre = re.compile(added_pat)
        except re.error:
            return out
        if not baseline_names:
            out.append(
                _finding(
                    rule_id=f"{rid}-no-baseline",
                    severity="info",
                    title="Baseline missing for tools.effective diff",
                    message="Set SENTINEL_BASELINE_TOOLS_PATH to a JSON file listing expected tool_names.",
                    recommended_action="Copy scripts/sentinel/data/baseline-tools-effective.example.json and adjust.",
                )
            )
            return out
        names = _last_tools_effective_names(trace)
        if not names:
            out.append(
                _finding(
                    rule_id=f"{rid}-no-snapshot",
                    severity="low",
                    title="No tools.effective snapshot in trace",
                    message="Run ingest with tools snapshot enabled (default) so detect can diff the catalog.",
                    recommended_action="Re-run sentinel ingest, then detect.",
                )
            )
            return out
        added = [n for n in names if n not in baseline_names]
        matched = [n for n in added if cre.search(n)]
        for n in matched:
            out.append(
                _finding(
                    rule_id=rid,
                    severity=sev,
                    title=title,
                    message=str(rule.get("message") or f"New tool vs baseline: {n}"),
                    recommended_action=rec_default,
                )
            )
        return out

    return out


class RealTimeRateDetector:
    """
    Live event-stream detector for ingest callbacks.

    rate_limit / loop_detect 규칙만 처리한다. 배치 detect와 결과 형태는 동일하지만,
    이벤트가 들어오는 즉시 finding을 반환해 respond 단의 sessions.abort 경로가
    배치 주기를 기다리지 않게 해준다. 러너 wiring은 별도 PR에서 진행한다.

    사용:
        rules = _load_yaml_rules(rules_dir)
        det = RealTimeRateDetector(rules)
        for entry in stream:                 # entry == ingest._trace_record(...)
            findings = det.process(entry)    # 임계 도달 시 비어 있지 않음
    """

    def __init__(self, rules: list[dict[str, Any]]):
        self._rate: list[dict[str, Any]] = []
        self._loop: list[dict[str, Any]] = []
        for r in rules:
            m = r.get("match")
            if not isinstance(m, dict):
                continue
            t = m.get("type")
            if t == "rate_limit":
                self._rate.append(r)
            elif t == "loop_detect":
                self._loop.append(r)
        self._call_times: dict[tuple[str, str], list[float]] = defaultdict(list)
        self._consecutive: dict[tuple[str, str], list[str]] = defaultdict(list)

    def process(self, entry: dict[str, Any]) -> list[dict[str, Any]]:
        if entry.get("entry_type") != "gateway_event":
            return []
        norm = entry.get("normalized")
        if not isinstance(norm, dict) or norm.get("kind") != "session.tool":
            return []
        tool = _tool_name_from_normalized(norm)
        ts_ms = entry.get("ts_ms")
        now = float(ts_ms) / 1000.0 if isinstance(ts_ms, (int, float)) else 0.0
        out: list[dict[str, Any]] = []

        for rule in self._rate:
            m = rule.get("match") or {}
            target_tools = m.get("tools") or None
            if target_tools and tool not in target_tools:
                continue
            window_s = float(m.get("window_seconds") or 30)
            max_calls = int(m.get("max_calls") or 10)
            key = (str(rule.get("id") or rule.get("_source") or ""), tool)
            calls = self._call_times[key]
            calls.append(now)
            cutoff = now - window_s
            while calls and calls[0] < cutoff:
                calls.pop(0)
            if len(calls) >= max_calls:
                rid = str(rule.get("id") or "rate_limit")
                out.append(
                    _finding(
                        rule_id=rid,
                        severity=str(rule.get("severity") or "high"),
                        title=str(rule.get("title") or rid),
                        message=str(
                            rule.get("message")
                            or f"{tool} called {len(calls)} times within {window_s:.0f}s window (limit {max_calls})"
                        ),
                        recommended_action=str(rule.get("recommendedAction") or ""),
                    )
                )

        for rule in self._loop:
            m = rule.get("match") or {}
            target_tools = m.get("tools") or None
            if target_tools and tool not in target_tools:
                continue
            max_consec = int(m.get("max_identical_consecutive") or 5)
            args_key = _args_key_from_event(entry, norm)
            key = (str(rule.get("id") or rule.get("_source") or ""), tool)
            seq = self._consecutive[key]
            if seq and seq[-1] == args_key:
                seq.append(args_key)
            else:
                self._consecutive[key] = [args_key]
                seq = self._consecutive[key]
            if len(seq) >= max_consec:
                rid = str(rule.get("id") or "loop_detect")
                out.append(
                    _finding(
                        rule_id=rid,
                        severity=str(rule.get("severity") or "critical"),
                        title=str(rule.get("title") or rid),
                        message=str(
                            rule.get("message")
                            or f"{tool} called {len(seq)} times consecutively with identical args"
                        ),
                        recommended_action=str(rule.get("recommendedAction") or ""),
                    )
                )

        return out

    def reset(self) -> None:
        self._call_times.clear()
        self._consecutive.clear()


def run_detect(
    *,
    trace_path: Path,
    rules_dir: Path,
    baseline_path: Path | None,
) -> dict[str, Any]:
    trace = _load_trace(trace_path)
    baseline_names = _load_baseline(baseline_path)
    rules = _load_yaml_rules(rules_dir)
    trace_blob = "\n".join(json.dumps(r, ensure_ascii=False) for r in trace)

    findings: list[dict[str, Any]] = []
    for rule in rules:
        findings.extend(
            _eval_rule(rule, trace=trace, baseline_names=baseline_names, trace_blob=trace_blob)
        )

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "findings": findings,
        "meta": {
            "trace_path": str(trace_path),
            "rules_dir": str(rules_dir),
            "baseline_path": str(baseline_path) if baseline_path else None,
            "rules_loaded": len(rules),
            "trace_rows": len(trace),
        },
    }


def main() -> None:
    p = argparse.ArgumentParser(description="Sentinel detect → findings JSON on stdout")
    p.add_argument(
        "--trace",
        type=Path,
        default=Path(os.environ.get("SENTINEL_TRACE_PATH") or _default_trace_path()),
    )
    p.add_argument(
        "--rules-dir",
        type=Path,
        default=Path(os.environ.get("SENTINEL_RULES_DIR") or _default_rules_dir()),
    )
    p.add_argument(
        "--baseline",
        type=Path,
        default=None,
        help="JSON with tool_names list; default env SENTINEL_BASELINE_TOOLS_PATH or bundled example.",
    )
    p.add_argument("--out", type=Path, default=None, help="Also write findings to this path.")
    args = p.parse_args()

    baseline = args.baseline
    if baseline is None:
        env_b = os.environ.get("SENTINEL_BASELINE_TOOLS_PATH")
        baseline = Path(env_b) if env_b else _default_baseline_path()

    report = run_detect(trace_path=args.trace, rules_dir=args.rules_dir, baseline_path=baseline)
    text = json.dumps(report, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
