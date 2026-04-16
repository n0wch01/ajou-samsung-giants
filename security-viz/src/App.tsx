import { useCallback, useMemo, useState } from "react";
import { Timeline } from "./components/Timeline";
import { CompareGuardrailDirect } from "./panels/CompareGuardrailDirect";
import { StageInput } from "./panels/StageInput";
import { StageLogs } from "./panels/StageLogs";
import { StagePolicy } from "./panels/StagePolicy";
import { StageRiskSummary } from "./panels/StageRiskSummary";
import { StageThreats } from "./panels/StageThreats";
import { StageToolEvidence } from "./panels/StageToolEvidence";
import { useGatewayReadonly } from "./gateway/useGatewayReadonly";
import { useFindings } from "./sentinel/useFindings";

type Step = "input" | "compare" | "policy" | "tools" | "logs" | "threats" | "risk";

function extractTimelineRaw(
  title: string,
  list: { title: string; raw: unknown }[],
): unknown | undefined {
  const hit = [...list].reverse().find((t) => t.title === title);
  return hit?.raw;
}

export function App() {
  const gw = useGatewayReadonly();
  const [step, setStep] = useState<Step>("input");
  const [wsUrl, setWsUrl] = useState(() => localStorage.getItem("sg.viz.wsUrl") ?? "");
  const [token, setToken] = useState(() => localStorage.getItem("sg.viz.token") ?? "");
  const [sessionKey, setSessionKey] = useState(() => localStorage.getItem("sg.viz.sessionKey") ?? "agent:main");
  const [scenarioId, setScenarioId] = useState("S1-plugin-supply-chain");
  const [observationMode, setObservationMode] = useState<"guardrail" | "direct">("guardrail");
  const [configSnap, setConfigSnap] = useState<unknown | undefined>(undefined);
  const [catalogSnap, setCatalogSnap] = useState<unknown | undefined>(undefined);
  const [selectedTlId, setSelectedTlId] = useState<string | null>(null);
  const [useSse, setUseSse] = useState(false);

  const findingsState = useFindings({ pollMs: 8000, useSse });

  const busyRpc = gw.connState !== "ready";

  const configDisplayed = useMemo(() => {
    if (configSnap !== undefined) return configSnap;
    return extractTimelineRaw("config.get", gw.timeline);
  }, [configSnap, gw.timeline]);

  const catalogDisplayed = useMemo(() => {
    if (catalogSnap !== undefined) return catalogSnap;
    return extractTimelineRaw("tools.catalog", gw.timeline);
  }, [catalogSnap, gw.timeline]);

  const onConnect = useCallback(() => {
    localStorage.setItem("sg.viz.wsUrl", wsUrl);
    localStorage.setItem("sg.viz.token", token);
    localStorage.setItem("sg.viz.sessionKey", sessionKey);
    setConfigSnap(undefined);
    setCatalogSnap(undefined);
    gw.connect(wsUrl.trim(), token.trim(), sessionKey.trim());
  }, [gw, sessionKey, token, wsUrl]);

  const onRefreshConfig = useCallback(async () => {
    try {
      const p = await gw.sendReadonly("config.get", {});
      setConfigSnap(p);
    } catch {
      /* StagePolicy shows last known */
    }
  }, [gw]);

  const onRefreshCatalog = useCallback(async () => {
    try {
      const p = await gw.sendReadonly("tools.catalog", {});
      setCatalogSnap(p);
    } catch {
      /* optional */
    }
  }, [gw]);

  const selectedEntry = gw.timeline.find((t) => t.id === selectedTlId) ?? null;

  const steps: { id: Step; label: string }[] = [
    { id: "input", label: "1 · Input" },
    { id: "compare", label: "Guardrail / Direct" },
    { id: "policy", label: "2 · Policy" },
    { id: "tools", label: "3 · Tools" },
    { id: "logs", label: "4 · Logs" },
    { id: "threats", label: "Threats" },
    { id: "risk", label: "5 · Report" },
  ];

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>security-viz — OpenClaw gateway observer</h1>
        <p className="sub">Read-only WebSocket client, staged pipeline, Sentinel findings bridge.</p>
      </header>
      <div className="app-body">
        <aside className="sidebar">
          <nav className="stack">
            {steps.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`timeline-btn ${step === s.id ? "active" : ""}`}
                onClick={() => setStep(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>
          <div style={{ marginTop: 16 }}>
            <Timeline entries={gw.timeline} activeId={selectedTlId} onSelect={setSelectedTlId} />
          </div>
        </aside>
        <main className="main">
          {step === "input" ? (
            <StageInput
              wsUrl={wsUrl}
              token={token}
              sessionKey={sessionKey}
              scenarioId={scenarioId}
              onChangeWsUrl={setWsUrl}
              onChangeToken={setToken}
              onChangeSessionKey={setSessionKey}
              onChangeScenarioId={setScenarioId}
              onConnect={onConnect}
              onDisconnect={gw.disconnect}
              connState={gw.connState}
              error={gw.error}
            />
          ) : null}
          {step === "compare" ? (
            <CompareGuardrailDirect
              observationMode={observationMode}
              onObservationMode={setObservationMode}
              timeline={gw.timeline}
            />
          ) : null}
          {step === "policy" ? (
            <StagePolicy
              configPayload={configDisplayed}
              catalogPayload={catalogDisplayed}
              onRefreshConfig={onRefreshConfig}
              onRefreshCatalog={onRefreshCatalog}
              busy={busyRpc}
            />
          ) : null}
          {step === "tools" ? <StageToolEvidence timeline={gw.timeline} /> : null}
          {step === "logs" ? <StageLogs jsonlLines={gw.jsonlLines} scenarioId={scenarioId} /> : null}
          {step === "threats" ? (
            <StageThreats
              findings={findingsState.findings}
              loading={findingsState.loading}
              error={findingsState.error}
              onRefresh={findingsState.refresh}
              useSse={useSse}
              onToggleSse={setUseSse}
            />
          ) : null}
          {step === "risk" ? (
            <StageRiskSummary scenarioId={scenarioId} findings={findingsState.findings} timeline={gw.timeline} />
          ) : null}

          {selectedEntry ? (
            <section className="panel" style={{ marginTop: 16 }}>
              <h2>Selected timeline event</h2>
              <p className="muted">
                {selectedEntry.eventName} · {new Date(selectedEntry.at).toLocaleString()}
              </p>
              <pre className="tool-card">{JSON.stringify(selectedEntry.raw, null, 2).slice(0, 8000)}</pre>
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}
