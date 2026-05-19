import { useEffect, useRef, useState } from "react";
import { useFindings, type SentinelFinding } from "../sentinel/useFindings";
import type { TimelineEntry } from "../gateway/normalizeEvent";
import type { NavAction } from "../App";
import { ScenarioFlowTrace } from "../components/ScenarioFlowTrace";

// ── 탐지 유형 분류 ────────────────────────────────────────────────────────

type DetectCategory = "plugin" | "md" | "abuse" | "other";

function categorize(f: SentinelFinding): DetectCategory {
  const id = f.ruleId.toLowerCase();
  if (id === "whitelist-violation" || id.includes("plugin") || id.includes("supply")) return "plugin";
  if (id === "md-signature-block" || id.includes("injection") || id.includes("readme") || id.includes("md-") || id.includes("vigil") || id.includes("prompt")) return "md";
  if (id.includes("rate") || id.includes("abuse") || id.includes("loop") || id.includes("exhaustion")) return "abuse";
  return "other";
}

function categoryLabel(cat: DetectCategory): string {
  if (cat === "plugin") return "악성 플러그인 탐지";
  if (cat === "md") return "악성 MD 탐지";
  if (cat === "abuse") return "API Abuse 탐지";
  return "기타 탐지";
}

// ── 도넛 차트 (SVG) ───────────────────────────────────────────────────────

const DONUT_COLORS: Record<DetectCategory, string> = {
  plugin: "#ef4444",
  md: "#f59e0b",
  abuse: "#3b82f6",
  other: "#6b7280",
};

type DonutProps = {
  plugin: number;
  md: number;
  abuse: number;
  other: number;
};

function DonutChart({ plugin, md, abuse, other }: DonutProps) {
  const total = plugin + md + abuse + other;
  const r = 54;
  const cx = 70;
  const cy = 70;
  const circumference = 2 * Math.PI * r;

  if (total === 0) {
    return (
      <svg width="140" height="140" viewBox="0 0 140 140">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1a2e4a" strokeWidth="18" />
        <text x={cx} y={cy - 6} textAnchor="middle" fill="#8a99b8" fontSize="11">탐지</text>
        <text x={cx} y={cy + 10} textAnchor="middle" fill="#8a99b8" fontSize="11">없음</text>
      </svg>
    );
  }

  const allSegments: { cat: DetectCategory; count: number }[] = [
    { cat: "plugin", count: plugin },
    { cat: "md", count: md },
    { cat: "abuse", count: abuse },
    { cat: "other", count: other },
  ];
  const segments = allSegments.filter((s) => s.count > 0);

  let offset = 0;
  const arcs = segments.map((s) => {
    const pct = s.count / total;
    const dash = pct * circumference;
    const gap = circumference - dash;
    const arc = { ...s, dash, gap, offset };
    offset += dash;
    return arc;
  });

  return (
    <svg width="140" height="140" viewBox="0 0 140 140">
      <g transform={`rotate(-90 ${cx} ${cy})`}>
        {arcs.map((arc) => (
          <circle
            key={arc.cat}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={DONUT_COLORS[arc.cat]}
            strokeWidth="18"
            strokeDasharray={`${arc.dash} ${arc.gap}`}
            strokeDashoffset={-arc.offset}
          />
        ))}
      </g>
      <text x={cx} y={cy - 6} textAnchor="middle" fill="#e8edf5" fontSize="22" fontWeight="bold">
        {total}
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" fill="#8a99b8" fontSize="10">
        총 탐지
      </text>
    </svg>
  );
}

// ── Severity 배지 ──────────────────────────────────────────────────────────

function SevBadge({ sev }: { sev: string }) {
  return <span className={`sev-badge sev-${sev}`}>{sev.toUpperCase()}</span>;
}

// ── 조치 안내 ─────────────────────────────────────────────────────────────

function RemediationGuide({
  finding,
  category,
  onNavigate,
}: {
  finding: SentinelFinding;
  category: DetectCategory;
  onNavigate: (a: NavAction) => void;
}) {
  if (category === "plugin") {
    const toolMatch = finding.message.match(/tool[:\s]+([^\s,]+)/i) ??
      finding.title.match(/tool[:\s]+([^\s,]+)/i);
    const toolId = toolMatch?.[1] ?? null;
    return (
      <div className="mon-remediation">
        <p className="mon-remediation-msg">해당 플러그인을 삭제하세요.</p>
        <button
          type="button"
          className="mon-remediation-btn mon-remediation-btn-danger"
          onClick={() => onNavigate({ tab: "policy", highlightToolId: toolId, highlightSection: "catalog" })}
        >
          Policy 탭에서 플러그인 삭제 →
        </button>
      </div>
    );
  }

  if (category === "md") {
    const fileMatch = finding.message.match(/([^\s]+\.md)/i) ??
      finding.title.match(/([^\s]+\.md)/i);
    const fileName = fileMatch?.[1] ?? "관련 마크다운 파일";
    return (
      <div className="mon-remediation">
        <p className="mon-remediation-msg">⚠ <strong>{fileName}</strong> 파일을 확인하세요.</p>
      </div>
    );
  }

  if (category === "abuse") {
    return (
      <div className="mon-remediation">
        <p className="mon-remediation-msg">허용 범위를 초과했습니다. 허용 횟수를 늘리려면 Policy 탭에서 허용 범위를 수정하세요.</p>
        <button
          type="button"
          className="mon-remediation-btn mon-remediation-btn-warn"
          onClick={() => onNavigate({ tab: "policy", highlightSection: "rateLimit" })}
        >
          Policy 탭에서 허용 범위 수정 →
        </button>
      </div>
    );
  }

  return null;
}

// ── History 아이템 ─────────────────────────────────────────────────────────

function HistoryItem({
  finding,
  isOpen,
  isHighlighted,
  timeline,
  onToggle,
  onNavigate,
}: {
  finding: SentinelFinding;
  isOpen: boolean;
  isHighlighted: boolean;
  timeline: TimelineEntry[];
  onToggle: () => void;
  onNavigate: (a: NavAction) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const category = categorize(finding);

  useEffect(() => {
    if (isHighlighted && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [isHighlighted]);

  return (
    <div
      ref={ref}
      className={`mon-history-item${isOpen ? " mon-history-item-open" : ""}${isHighlighted ? " mon-history-item-highlight" : ""}`}
    >
      <button type="button" className="mon-history-row" onClick={onToggle}>
        <SevBadge sev={finding.severity} />
        <span className={`mon-history-cat mon-history-cat-${category}`}>{categoryLabel(category)}</span>
        <span className="mon-history-title">{finding.title}</span>
        <span className="mon-history-rule">{finding.ruleId}</span>
        <span className="mon-history-ts">
          {finding.timestamp ? new Date(finding.timestamp).toLocaleString("ko-KR") : "—"}
        </span>
        <span className="mon-history-chev">{isOpen ? "▲" : "▼"}</span>
      </button>

      {isOpen && (
        <div className="mon-history-body">
          <div className="mon-detail-section">
            <div className="mon-detail-label">탐지 메시지</div>
            <p className="mon-detail-text">{finding.message}</p>
          </div>
          {finding.recommendedAction && (
            <div className="mon-detail-section">
              <div className="mon-detail-label">권고 조치</div>
              <p className="mon-detail-text">{finding.recommendedAction}</p>
            </div>
          )}
          <div className="mon-detail-section">
            <div className="mon-detail-label">실행 흐름</div>
            <ScenarioFlowTrace
              entries={timeline}
              highlightFindingId={finding.id}
              anchorTimestamp={finding.timestamp ? new Date(finding.timestamp).getTime() : null}
            />
          </div>
          <div className="mon-detail-section">
            <div className="mon-detail-label">조치</div>
            <RemediationGuide finding={finding} category={category} onNavigate={onNavigate} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────

export type StageMonitoringProps = {
  timeline: TimelineEntry[];
  highlightFindingId: string | null;
  onNavigate: (a: NavAction) => void;
  /** 0이면 reset-findings 완료 전 — 이전 데이터가 서버에 남아있을 수 있어 표시하지 않음 */
  alertResetKey?: number;
  /** 바뀌면 누적된 findings 상태를 초기화 (Connect 재연결 등) */
  clearKey?: number;
};

export function StageMonitoring({ timeline, highlightFindingId, onNavigate, alertResetKey = 0, clearKey }: StageMonitoringProps) {
  const { findings: rawFindings, error } = useFindings({ pollMs: 1000, useSse: false, clearKey });
  // reset-findings 완료 전(alertResetKey === 0)에는 이전 세션 데이터가 남아있을 수 있으므로 숨김
  const findings = alertResetKey > 0 ? rawFindings : [];
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (highlightFindingId) {
      setOpenId(highlightFindingId);
    }
  }, [highlightFindingId]);

  const pluginCount = findings.filter((f) => categorize(f) === "plugin").length;
  const mdCount = findings.filter((f) => categorize(f) === "md").length;
  const abuseCount = findings.filter((f) => categorize(f) === "abuse").length;
  const otherCount = findings.filter((f) => categorize(f) === "other").length;
  const total = findings.length;

  const sorted = [...findings].sort((a, b) =>
    (b.timestamp ?? "").localeCompare(a.timestamp ?? ""),
  );

  return (
    <div className="mon-page">
      {/* ── 페이지 헤더 ── */}
      <div className="mon-page-header">
        <div>
          <h2 className="sc-page-title">Monitoring</h2>
          <p className="sc-page-desc">탐지된 보안 위협의 요약과 상세 내역을 확인합니다.</p>
        </div>
      </div>

      {error && <p className="mon-error">⚠ {error}</p>}

      {/* ── Summary ── */}
      <div className="mon-summary">
        <div className="mon-summary-cards">
          <div className="mon-summary-card mon-summary-card-plugin">
            <div className="mon-summary-count">{pluginCount}</div>
            <div className="mon-summary-label">악성 플러그인 탐지</div>
          </div>
          <div className="mon-summary-card mon-summary-card-md">
            <div className="mon-summary-count">{mdCount}</div>
            <div className="mon-summary-label">악성 MD 탐지</div>
          </div>
          <div className="mon-summary-card mon-summary-card-abuse">
            <div className="mon-summary-count">{abuseCount}</div>
            <div className="mon-summary-label">API Abuse 탐지</div>
          </div>
        </div>

        <div className="mon-donut-wrap">
          <DonutChart plugin={pluginCount} md={mdCount} abuse={abuseCount} other={otherCount} />
          <div className="mon-donut-legend">
            <div className="mon-legend-item"><span className="mon-legend-dot" style={{ background: DONUT_COLORS.plugin }} />악성 플러그인</div>
            <div className="mon-legend-item"><span className="mon-legend-dot" style={{ background: DONUT_COLORS.md }} />악성 MD</div>
            <div className="mon-legend-item"><span className="mon-legend-dot" style={{ background: DONUT_COLORS.abuse }} />API Abuse</div>
            {otherCount > 0 && (
              <div className="mon-legend-item"><span className="mon-legend-dot" style={{ background: DONUT_COLORS.other }} />기타</div>
            )}
          </div>
        </div>
      </div>

      {/* ── History ── */}
      <div className="mon-history-section">
        <div className="mon-history-header">
          <h3 className="mon-history-title-text">탐지 내역</h3>
          <span className="mon-history-count">{total}건</span>
        </div>

        {sorted.length === 0 && (
          <div className="mon-history-empty">
            <span className="mon-history-empty-icon">◎</span>
            <p>탐지된 보안 위협이 없습니다.</p>
          </div>
        )}

        <div className="mon-history-list">
          {sorted.map((f) => (
            <HistoryItem
              key={f.id}
              finding={f}
              isOpen={openId === f.id}
              isHighlighted={highlightFindingId === f.id}
              timeline={timeline}
              onToggle={() => setOpenId((prev) => (prev === f.id ? null : f.id))}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
