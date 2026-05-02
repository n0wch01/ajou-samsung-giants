import type { TimelineEntry } from "../gateway/normalizeEvent";

export type StageToolEvidenceProps = {
  timeline: TimelineEntry[];
};

export function StageToolEvidence(props: StageToolEvidenceProps) {
  const tools = props.timeline.filter((t) => t.kind === "session.tool");
  return (
    <div className="panel">
      <h2>3. Tool lifecycle and evidence</h2>
      <p className="muted">
        Rows are derived from gateway <code>session.tool</code> events. Arguments and statuses mirror whatever fields the
        gateway exposes; anything not present is simply omitted.
      </p>
      {tools.length === 0 ? (
        <p className="muted">No tool events in this timeline yet.</p>
      ) : (
        tools.map((t) => (
          <div key={t.id} className="tool-card">
            <div>
              <strong>{t.title}</strong>{" "}
              <span className="muted">
                {t.eventName} · {new Date(t.at).toLocaleTimeString()}
              </span>
            </div>
            {t.subtitle ? <div className="muted" style={{ marginTop: 4 }}>{t.subtitle}</div> : null}
            <pre>{JSON.stringify(t.raw, null, 2).slice(0, 4000)}</pre>
          </div>
        ))
      )}
    </div>
  );
}
