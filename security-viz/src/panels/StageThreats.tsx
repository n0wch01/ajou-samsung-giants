import type { SentinelFinding } from "../sentinel/useFindings";

export type StageThreatsProps = {
  findings: SentinelFinding[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  useSse: boolean;
  onToggleSse: (v: boolean) => void;
};

function sevClass(s: SentinelFinding["severity"]): string {
  return `finding sev-${s}`;
}

export function StageThreats(props: StageThreatsProps) {
  return (
    <div className="panel">
      <h2>Threats (Sentinel findings)</h2>
      <p className="muted">
        Findings load from a small HTTP service (Phase 1 convention: <code>GET /findings</code>) or optional{" "}
        <code>GET /findings/stream</code> SSE. In Vite dev, requests proxy to <code>http://127.0.0.1:8787</code> via{" "}
        <code>/sentinel-api/*</code>.
      </p>
      <div className="row" style={{ marginBottom: 10 }}>
        <button type="button" onClick={props.onRefresh} disabled={props.loading}>
          {props.loading ? "Loading…" : "Refresh findings"}
        </button>
        <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={props.useSse}
            onChange={(e) => props.onToggleSse(e.target.checked)}
          />
          SSE stream
        </label>
      </div>
      {props.error ? <p className="muted" style={{ color: "var(--warn)" }}>{props.error}</p> : null}
      {props.findings.length === 0 && !props.loading ? (
        <p className="muted">No findings returned. Run Sentinel detect or stub a local findings server on port 8787.</p>
      ) : null}
      <div className="stack">
        {props.findings.map((f) => (
          <div key={f.id} className={sevClass(f.severity)}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <strong>{f.title}</strong>
              <span className="muted">
                {f.severity.toUpperCase()} · {f.ruleId}
              </span>
            </div>
            <div style={{ marginTop: 4, fontSize: "0.82rem" }}>{f.message}</div>
            <div className="muted" style={{ marginTop: 6, fontSize: "0.78rem" }}>
              <strong>Recommended:</strong> {f.recommendedAction}
            </div>
            {f.timestamp ? (
              <div className="muted" style={{ marginTop: 4, fontSize: "0.72rem" }}>
                {f.timestamp}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
