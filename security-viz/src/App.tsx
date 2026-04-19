import { useCallback, useState } from "react";
import { MessageToolFlow } from "./components/MessageToolFlow";
import { StageInput } from "./panels/StageInput";
import { StageScenario } from "./panels/StageScenario";
import { StageSentinel } from "./panels/StageSentinel";
import { StageSentinelDetect } from "./panels/StageSentinelDetect";
import { useGatewayReadonly } from "./gateway/useGatewayReadonly";

export type AppMainTab = "session" | "scenario" | "sentinel";

export function App() {
  const gw = useGatewayReadonly();
  const [tab, setTab] = useState<AppMainTab>("session");
  const [wsUrl, setWsUrl] = useState(
    () =>
      (import.meta.env.VITE_SG_GATEWAY_WS_URL as string | undefined)?.trim() ||
      localStorage.getItem("sg.viz.wsUrl") ||
      "",
  );
  const [token, setToken] = useState(() => localStorage.getItem("sg.viz.token") ?? "");
  const [sessionKey, setSessionKey] = useState(
    () =>
      (import.meta.env.VITE_SG_SESSION_KEY as string | undefined)?.trim() ||
      localStorage.getItem("sg.viz.sessionKey") ||
      "agent:main",
  );

  const onConnect = useCallback(() => {
    localStorage.setItem("sg.viz.wsUrl", wsUrl);
    localStorage.setItem("sg.viz.token", token);
    localStorage.setItem("sg.viz.sessionKey", sessionKey);
    gw.connect(wsUrl.trim(), token.trim(), sessionKey.trim());
  }, [gw, sessionKey, token, wsUrl]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>security-viz</h1>
        <p className="sub">
          SG-OpenClaw Gateway를 읽기 전용으로 구독하고, 시나리오 주입과 Sentinel 수집·탐지를 한 화면에서 전환합니다.
        </p>
      </header>
      <nav className="app-tabs" role="tablist" aria-label="주요 영역">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "session"}
          className={tab === "session" ? "app-tab active" : "app-tab"}
          onClick={() => setTab("session")}
        >
          세션 · 타임라인
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "scenario"}
          className={tab === "scenario" ? "app-tab active" : "app-tab"}
          onClick={() => setTab("scenario")}
        >
          시나리오
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "sentinel"}
          className={tab === "sentinel" ? "app-tab active" : "app-tab"}
          onClick={() => setTab("sentinel")}
        >
          Sentinel
        </button>
      </nav>
      <div className="app-body app-body-single">
        <main className="main main-single">
          <section className="tab-panel" role="tabpanel" hidden={tab !== "session"}>
            <StageInput
              wsUrl={wsUrl}
              token={token}
              sessionKey={sessionKey}
              onChangeWsUrl={setWsUrl}
              onChangeToken={setToken}
              onChangeSessionKey={setSessionKey}
              onConnect={onConnect}
              onDisconnect={gw.disconnect}
              connState={gw.connState}
              error={gw.error}
            />
            <MessageToolFlow entries={gw.timeline} connState={gw.connState} />
          </section>

          <section className="tab-panel" role="tabpanel" hidden={tab !== "scenario"}>
            <StageScenario wsUrl={wsUrl} token={token} sessionKey={sessionKey} />
          </section>

          <section className="tab-panel" role="tabpanel" hidden={tab !== "sentinel"}>
            <div className="sentinel-tab-stack">
              <StageSentinel wsUrl={wsUrl} token={token} sessionKey={sessionKey} />
              <StageSentinelDetect />
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
