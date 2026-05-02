import type { TimelineEntry } from "../gateway/normalizeEvent";

export type CompareGuardrailDirectProps = {
  observationMode: "guardrail" | "direct";
  onObservationMode: (m: "guardrail" | "direct") => void;
  timeline: TimelineEntry[];
};

function liveMetrics(tl: TimelineEntry[]) {
  const tool = tl.filter((t) => t.kind === "session.tool").length;
  const msg = tl.filter((t) => t.kind === "session.message").length;
  const appr = tl.filter((t) => t.kind === "approval").length;
  const cfg = [...tl].reverse().find((t) => t.title === "config.get");
  return { tool, msg, appr, hasConfig: Boolean(cfg) };
}

export function CompareGuardrailDirect(props: CompareGuardrailDirectProps) {
  const m = liveMetrics(props.timeline);
  return (
    <div className="panel">
      <h2>Guardrail vs Direct</h2>
      <p className="muted">
        Expected behaviors come from <code>docs/guardrail-vs-direct.md</code>. Use the observation lens to compare what
        you expect in a lab preset against what this read-only session is showing.
      </p>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="muted" htmlFor="obs">
          Observation lens
        </label>
        <select
          id="obs"
          value={props.observationMode}
          onChange={(e) => props.onObservationMode(e.target.value as "guardrail" | "direct")}
        >
          <option value="guardrail">Guardrail (operations-oriented)</option>
          <option value="direct">Direct (lab-only, relaxed)</option>
        </select>
      </div>
      <div className="compare-grid">
        <div className="compare-col">
          <h3>Guardrail (expected)</h3>
          <ul>
            <li>Sandboxed working dirs and constrained network egress.</li>
            <li>Tool allow and deny lists; plugin paths restricted.</li>
            <li>Sensitive <code>session.tool</code> calls require explicit approval.</li>
            <li>Secrets minimized; document effective policy via <code>config.get</code>.</li>
          </ul>
        </div>
        <div className="compare-col">
          <h3>Direct (expected)</h3>
          <ul>
            <li>
              <strong>Not for production</strong> — isolated hosts and accounts only.
            </li>
            <li>Relaxed controls so you can see unmitigated tool exposure.</li>
            <li>
              <code>tools.effective</code> may include plugin tools; pair runs with Guardrail evidence.
            </li>
          </ul>
        </div>
        <div className="compare-col">
          <h3>Live (this connection)</h3>
          <table className="table">
            <tbody>
              <tr>
                <th>Lens</th>
                <td>{props.observationMode === "guardrail" ? "Guardrail checklist" : "Direct checklist"}</td>
              </tr>
              <tr>
                <th>Transcript tools</th>
                <td>{m.tool}</td>
              </tr>
              <tr>
                <th>Transcript messages</th>
                <td>{m.msg}</td>
              </tr>
              <tr>
                <th>Approval-family events</th>
                <td>{m.appr}</td>
              </tr>
              <tr>
                <th>Config snapshot pulled</th>
                <td>{m.hasConfig ? "yes" : "no"}</td>
              </tr>
            </tbody>
          </table>
          <p className="muted" style={{ marginTop: 8 }}>
            {props.observationMode === "guardrail"
              ? "In Guardrail labs you typically expect fewer surprise tool executions and more approval or deny signals when a malicious plugin is present."
              : "In Direct labs you deliberately expect broader tool visibility; still capture JSONL for diffing against Guardrail runs."}
          </p>
        </div>
      </div>
    </div>
  );
}
