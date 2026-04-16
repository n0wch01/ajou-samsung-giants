export type StagePolicyProps = {
  configPayload: unknown | undefined;
  catalogPayload: unknown | undefined;
  onRefreshConfig: () => void;
  onRefreshCatalog: () => void;
  busy: boolean;
};

export function StagePolicy(props: StagePolicyProps) {
  const cfg = props.configPayload;
  const catalog = props.catalogPayload;
  return (
    <div className="panel">
      <h2>2. Guardrail inspection</h2>
      <p className="muted">
        Policy evidence uses read-only <code>config.get</code> and <code>tools.catalog</code>. Compare snapshots across
        Guardrail and Direct runs in your lab notebook; this view only shows the latest payloads seen in-browser.
      </p>
      <div className="row" style={{ marginBottom: 10 }}>
        <button type="button" disabled={props.busy} onClick={props.onRefreshConfig}>
          Refresh config.get
        </button>
        <button type="button" disabled={props.busy} onClick={props.onRefreshCatalog}>
          Refresh tools.catalog
        </button>
      </div>
      <h3>config.get (latest)</h3>
      <pre className="tool-card" style={{ marginTop: 6 }}>
        {cfg === undefined ? "No snapshot yet." : JSON.stringify(cfg, null, 2).slice(0, 12000)}
      </pre>
      <h3>tools.catalog (latest)</h3>
      <pre className="tool-card" style={{ marginTop: 6 }}>
        {catalog === undefined
          ? "Click “Refresh tools.catalog” after connecting."
          : JSON.stringify(catalog, null, 2).slice(0, 12000)}
      </pre>
    </div>
  );
}
