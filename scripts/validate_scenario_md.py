"""
Validate scenario and runbook Markdown against Phase 1 SSOT headings and frontmatter.

Usage:
  python -m scripts.validate_scenario_md
  python scripts/validate_scenario_md.py [--repo-root PATH]
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover - runtime guard
    print("PyYAML is required: pip install -r scripts/requirements.txt", file=sys.stderr)
    raise SystemExit(2) from exc

HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*$")


def _repo_root(explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit.resolve()
    here = Path(__file__).resolve().parent.parent
    return here


def _split_frontmatter(text: str) -> tuple[dict[str, Any] | None, str]:
    if not text.startswith("---"):
        return None, text
    lines = text.splitlines()
    if len(lines) < 2 or lines[0].strip() != "---":
        return None, text
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return None, text
    raw = "\n".join(lines[1:end])
    body = "\n".join(lines[end + 1 :])
    try:
        fm = yaml.safe_load(raw) or {}
    except yaml.YAMLError:
        return {}, body
    if not isinstance(fm, dict):
        return {}, body
    return fm, body


def _headings(md_body: str) -> list[str]:
    out: list[str] = []
    for line in md_body.splitlines():
        m = HEADING_RE.match(line)
        if m:
            out.append(m.group(1).strip())
    return out


def _heading_match(headings: list[str], pattern: str) -> bool:
    rx = re.compile(pattern)
    return any(rx.search(h) for h in headings)


def validate_scenario(path: Path) -> list[str]:
    errors: list[str] = []
    text = path.read_text(encoding="utf-8")
    fm, body = _split_frontmatter(text)
    if fm is None:
        errors.append(f"{path}: missing YAML frontmatter (---)")
        return errors
    for key in ("scenario_id", "title", "inference"):
        if key not in fm or fm[key] in (None, ""):
            errors.append(f"{path}: frontmatter missing or empty `{key}`")
    inf = fm.get("inference")
    allowed_inf = {"dgx_spark", "local"}
    if inf not in allowed_inf:
        errors.append(f"{path}: inference must be one of {sorted(allowed_inf)}, got {inf!r}")
    hs = _headings(body)
    if not _heading_match(hs, r"목적"):
        errors.append(f"{path}: missing heading containing `목적`")
    if not _heading_match(hs, r"데이터"):
        errors.append(f"{path}: missing heading containing `데이터`")
    if not _heading_match(hs, r"윤리|샌드박스"):
        errors.append(f"{path}: missing heading containing `윤리` or `샌드박스`")
    guard = _heading_match(hs, r"Guardrail") or _heading_match(hs, r"가드레일.*Direct|Direct.*가드레일|Guardrail.*Direct")
    if not guard:
        errors.append(f"{path}: missing Guardrail/Direct section (e.g. `Guardrail vs Direct`)")
    return errors


def validate_runbook(path: Path) -> list[str]:
    errors: list[str] = []
    text = path.read_text(encoding="utf-8")
    fm, body = _split_frontmatter(text)
    if fm is None:
        errors.append(f"{path}: missing YAML frontmatter (---)")
        return errors
    if fm.get("kind") != "runbook":
        errors.append(f"{path}: frontmatter `kind` must be `runbook`")
    if not fm.get("runbook_id"):
        errors.append(f"{path}: frontmatter missing `runbook_id`")
    hs = _headings(body)
    name = path.name
    if name == "pipeline-stages.md":
        required = [
            (r"의도", "1. 의도 및 입력"),
            (r"가드레일", "2. 가드레일 검사"),
            (r"도구", "3. 도구 수명주기"),
            (r"로그", "4. 로그 수집"),
            (r"위험", "5. 위험 요약"),
        ]
        for pat, hint in required:
            if not _heading_match(hs, pat):
                errors.append(f"{path}: missing `{pat}` heading stage ({hint})")
    elif name == "risk-rubric.md":
        checks = [
            (r"Likelihood|가능성", "Likelihood"),
            (r"Impact|영향", "Impact"),
            (r"격자", "Likelihood×Impact 격자"),
            (r"STRIDE", "STRIDE"),
            (r"KPI", "시나리오 KPI"),
        ]
        for pat, label in checks:
            if not _heading_match(hs, pat):
                errors.append(f"{path}: missing `{label}` section (heading match `{pat}`)")
    else:
        errors.append(f"{path}: unknown runbook file (add rules in validate_scenario_md.py)")
    return errors


def _load_catalog(root: Path) -> dict[str, Any]:
    cat = root / "scenarios" / "catalog.yaml"
    if not cat.is_file():
        raise FileNotFoundError(f"catalog not found: {cat}")
    data = yaml.safe_load(cat.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise ValueError("catalog.yaml must be a mapping at top level")
    return data


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Validate SG scenario and runbook Markdown.")
    p.add_argument(
        "--repo-root",
        type=Path,
        default=None,
        help="Repository root (default: parent of scripts/)",
    )
    args = p.parse_args(argv)
    root = _repo_root(args.repo_root)
    errors: list[str] = []
    try:
        catalog = _load_catalog(root)
    except (OSError, ValueError) as e:
        print(str(e), file=sys.stderr)
        return 1
    scenarios = catalog.get("scenarios") or []
    if not isinstance(scenarios, list):
        print("catalog.yaml: `scenarios` must be a list", file=sys.stderr)
        return 1
    for row in scenarios:
        if not isinstance(row, dict):
            continue
        if row.get("status") != "active":
            continue
        rel = row.get("path")
        if not rel or not isinstance(rel, str):
            errors.append("catalog: active scenario missing string `path`")
            continue
        path = (root / "scenarios" / rel).resolve()
        if not path.is_file():
            errors.append(f"catalog: active scenario file missing: {path}")
            continue
        errors.extend(validate_scenario(path))
    rb_dir = root / "runbooks"
    if rb_dir.is_dir():
        for md in sorted(rb_dir.glob("*.md")):
            errors.extend(validate_runbook(md))
    else:
        errors.append(f"missing runbooks directory: {rb_dir}")
    if errors:
        for line in errors:
            print(line, file=sys.stderr)
        return 1
    print("OK: scenario + runbook Markdown validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
