import type { TimelineEntry } from "../gateway/normalizeEvent";
import type { SentinelFinding } from "../sentinel/useFindings";

export type StageRiskSummaryProps = {
  scenarioId: string;
  findings: SentinelFinding[];
  timeline: TimelineEntry[];
};

function maxSeverity(fs: SentinelFinding[]): SentinelFinding["severity"] | "none" {
  const rank: Record<SentinelFinding["severity"], number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
    info: 1,
  };
  let best: SentinelFinding["severity"] | "none" = "none";
  let score = 0;
  for (const f of fs) {
    const s = rank[f.severity] ?? 0;
    if (s > score) {
      score = s;
      best = f.severity;
    }
  }
  return best;
}

export function StageRiskSummary(props: StageRiskSummaryProps) {
  const tools = props.timeline.filter((t) => t.kind === "session.tool").length;
  const appr = props.timeline.filter((t) => t.kind === "approval").length;
  const sev = maxSeverity(props.findings);
  return (
    <div className="panel">
      <h2>5. Risk-style report</h2>
      <p className="muted">
        Lightweight rollup for lab reporting: combine Sentinel severity, transcript tool traffic, and approval signals.
        Formal likelihood and impact scoring stays in <code>runbooks/risk-rubric.md</code>.
      </p>
      <table className="table">
        <tbody>
          <tr>
            <th>Scenario</th>
            <td>{props.scenarioId || "—"}</td>
          </tr>
          <tr>
            <th>STRIDE tags (S1 supply chain)</th>
            <td>Tampering (tooling), Spoofing (plugin identity), Elevation (unexpected capabilities)</td>
          </tr>
          <tr>
            <th>Top Sentinel severity</th>
            <td>{sev === "none" ? "none observed" : sev}</td>
          </tr>
          <tr>
            <th>Tool events observed</th>
            <td>{tools}</td>
          </tr>
          <tr>
            <th>Approval-related events</th>
            <td>{appr}</td>
          </tr>
          <tr>
            <th>Active findings</th>
            <td>{props.findings.length}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
