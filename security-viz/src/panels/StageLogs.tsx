export type StageLogsProps = {
  jsonlLines: string[];
  scenarioId: string;
};

export function StageLogs(props: StageLogsProps) {
  const download = () => {
    const blob = new Blob([props.jsonlLines.join("\n") + "\n"], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gateway-trace-${props.scenarioId || "session"}-${Date.now()}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel">
      <h2>4. Log collection</h2>
      <p className="muted">
        Every WebSocket frame observed by this dashboard is kept in order. Download as newline-delimited JSON for
        Sentinel alignment or runbook attachments.
      </p>
      <div className="row" style={{ marginBottom: 10 }}>
        <button type="button" className="primary" onClick={download} disabled={props.jsonlLines.length === 0}>
          Download JSONL ({props.jsonlLines.length} lines)
        </button>
      </div>
      <h3>Checklist</h3>
      <ul className="muted" style={{ fontSize: "0.82rem" }}>
        <li>Store the JSONL next to Sentinel <code>trace.jsonl</code> for the same wall-clock window.</li>
        <li>Capture <code>tools.effective</code> before and after plugin install when running S1.</li>
        <li>Note Guardrail or Direct preset in the runbook header.</li>
      </ul>
    </div>
  );
}
