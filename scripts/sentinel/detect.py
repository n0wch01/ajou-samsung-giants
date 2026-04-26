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
