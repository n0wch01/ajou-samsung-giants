import { useCallback, useEffect, useState } from "react";
import { publicAsset, apiPath } from "./lib/publicAsset";
import { MessageToolFlow } from "./components/MessageToolFlow";
import { StageInput } from "./panels/StageInput";
import { StagePolicy } from "./panels/StagePolicy";
import { StageScenario } from "./panels/StageScenario";
import { StageMonitoring } from "./panels/StageMonitoring";
import { StageDocs } from "./panels/StageDocs";
import { useGatewayReadonly } from "./gateway/useGatewayReadonly";

export type AppMainTab = "chat" | "monitoring" | "policy" | "scenario" | "docs";

export type NavAction = {
  tab: AppMainTab;
  highlightFindingId?: string | null;
  highlightToolId?: string | null;
  highlightSection?: string | null;
};

type ThemeMode = "dark" | "light";

export function App() {
  const gw = useGatewayReadonly();
  const [tab, setTab] = useState<AppMainTab>("chat");

  // 라이트/다크 테마 — documentElement[data-theme] + localStorage 저장
  const [theme, setTheme] = useState<ThemeMode>(
    () => (localStorage.getItem("sg.viz.theme") === "light" ? "light" : "dark"),
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("sg.viz.theme", theme);
  }, [theme]);
  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);
  const [alertResetKey, setAlertResetKey] = useState(0);
  const [monitoringClearKey, setMonitoringClearKey] = useState(0);

  // 페이지 로드 시 이전 세션 데이터 전체 초기화
  useEffect(() => {
    void (async () => {
      // ingest.py 종료 → trace 삭제 → findings 초기화 순으로 처리
      await fetch(apiPath("/api/sentinel/stop"), { method: "POST" }).catch(() => {});
      await fetch(apiPath("/api/sentinel/clear-trace"), { method: "POST" }).catch(() => {});
      await fetch(apiPath("/api/sentinel/reset-findings"), { method: "POST" }).catch(() => {});
      // 서버 초기화 완료 후 프론트엔드 상태도 초기화
      setMonitoringClearKey((k) => k + 1);
      setAlertResetKey((k) => k + 1);
    })();
  }, []);
  const [highlightFindingId, setHighlightFindingId] = useState<string | null>(null);
  const [highlightToolId, setHighlightToolId] = useState<string | null>(null);
  const [highlightSection, setHighlightSection] = useState<string | null>(null);

  const [wsUrl, setWsUrl] = useState(
    () =>
      (import.meta.env.VITE_SG_GATEWAY_WS_URL as string | undefined)?.trim() ||
      localStorage.getItem("sg.viz.wsUrl") ||
      "",
  );
  const [token, setToken] = useState(() => localStorage.getItem("sg.viz.token") ?? "");
  const [sessionKey, setSessionKey] = useState(() => {
    const env = (import.meta.env.VITE_SG_SESSION_KEY as string | undefined)?.trim();
    if (env) return env;
    const stored = localStorage.getItem("sg.viz.sessionKey");
    if (stored === "main" || stored === "agent:main") return "agent:main:main";
    return stored || "agent:main:main";
  });

  const [configPayload, setConfigPayload] = useState<unknown>(undefined);
  const [catalogPayload, setCatalogPayload] = useState<unknown>(undefined);
  const [configError, setConfigError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);

  const navigate = useCallback((action: NavAction) => {
    setTab(action.tab);
    setHighlightFindingId(action.highlightFindingId ?? null);
    setHighlightToolId(action.highlightToolId ?? null);
    setHighlightSection(action.highlightSection ?? null);
  }, []);

  const onConnect = useCallback(() => {
    localStorage.setItem("sg.viz.wsUrl", wsUrl);
    localStorage.setItem("sg.viz.token", token);
    localStorage.setItem("sg.viz.sessionKey", sessionKey);
    gw.connect(wsUrl.trim(), token.trim(), sessionKey.trim());
    void fetch(apiPath("/api/sentinel/reset-findings"), { method: "POST" }).catch(() => {});
    setMonitoringClearKey((k) => k + 1);
  }, [gw, sessionKey, token, wsUrl]);

  const onRefreshConfig = useCallback(async () => {
    setConfigBusy(true);
    setConfigError(null);
    try {
      const ws = wsUrl.trim();
      const tok = token.trim();
      const url = apiPath(`/api/policy/config-get?wsUrl=${encodeURIComponent(ws)}&token=${encodeURIComponent(tok)}`);
      const res = await fetch(url);
      const j = (await res.json()) as { ok?: boolean; payload?: unknown; message?: string };
      if (!j.ok) throw new Error(j.message ?? "config.get 실패");
      setConfigPayload(j.payload);
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfigBusy(false);
    }
  }, [wsUrl, token]);

  const onRefreshCatalog = useCallback(async () => {
    setCatalogBusy(true);
    setCatalogError(null);
    try {
      const ws = wsUrl.trim();
      const tok = token.trim();
      const url = apiPath(`/api/policy/catalog?wsUrl=${encodeURIComponent(ws)}&token=${encodeURIComponent(tok)}`);
      const res = await fetch(url);
      const j = (await res.json()) as { ok?: boolean; payload?: unknown; message?: string };
      if (!j.ok) throw new Error(j.message ?? "tools.catalog 실패");
      setCatalogPayload(j.payload);
    } catch (e) {
      setCatalogError(e instanceof Error ? e.message : String(e));
    } finally {
      setCatalogBusy(false);
    }
  }, [wsUrl, token]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-header-title-tabs">
            <div className="app-header-brand">
              <img
                src={publicAsset("photo/sgclaw2.png")}
                alt="치토클로"
                className="chat-room-avatar chat-room-avatar--plain chat-room-avatar--brand"
              />
              <h1 className="app-header-title">SG-AgentSentinel</h1>
            </div>
            <nav className="app-tabs" role="tablist" aria-label="주요 영역">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "chat"}
                className={tab === "chat" ? "app-tab active" : "app-tab"}
                onClick={() => navigate({ tab: "chat" })}
              >
                Chat
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "monitoring"}
                className={tab === "monitoring" ? "app-tab active" : "app-tab"}
                onClick={() => navigate({ tab: "monitoring" })}
              >
                Monitoring
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "policy"}
                className={tab === "policy" ? "app-tab active" : "app-tab"}
                onClick={() => navigate({ tab: "policy" })}
              >
                Policy
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "scenario"}
                className={tab === "scenario" ? "app-tab active" : "app-tab"}
                onClick={() => navigate({ tab: "scenario" })}
              >
                Test Scenario
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "docs"}
                className={tab === "docs" ? "app-tab active" : "app-tab"}
                onClick={() => navigate({ tab: "docs" })}
              >
                Docs
              </button>
            </nav>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={theme === "light"}
            className="app-theme-switch"
            onClick={toggleTheme}
            aria-label="라이트/다크 모드 전환"
            title={theme === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환"}
          >
            <span className="app-theme-switch-knob" aria-hidden="true">
              {theme === "dark" ? "🌙" : "☀"}
            </span>
          </button>
        </div>
      </header>
      <div className="app-body">
        <aside className="app-sidebar-left">
          <div className="app-sidebar-stack">
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
          </div>
        </aside>
        <main className="app-main">
          <section className="tab-panel chat-tab-panel" role="tabpanel" hidden={tab !== "chat"}>
            <MessageToolFlow
              entries={gw.timeline}
              connState={gw.connState}
              wsUrl={wsUrl}
              token={token}
              sessionKey={sessionKey}
              injectFrame={gw.injectFrame}
              onNavigate={navigate}
              connectedAt={gw.connectedAt}
              clearKey={monitoringClearKey}
            />
          </section>

          <section className="tab-panel" role="tabpanel" hidden={tab !== "monitoring"}>
            <StageMonitoring
              timeline={gw.timeline}
              highlightFindingId={highlightFindingId}
              onNavigate={navigate}
              alertResetKey={alertResetKey}
              clearKey={monitoringClearKey}
            />
          </section>

          <section className="tab-panel" role="tabpanel" hidden={tab !== "policy"}>
            <StagePolicy
              configPayload={configPayload}
              catalogPayload={catalogPayload}
              configError={configError}
              catalogError={catalogError}
              onRefreshConfig={() => void onRefreshConfig()}
              onRefreshCatalog={() => void onRefreshCatalog()}
              configBusy={configBusy}
              catalogBusy={catalogBusy}
              highlightToolId={highlightToolId}
              highlightSection={highlightSection}
              wsUrl={wsUrl}
              token={token}
            />
          </section>

          <section className="tab-panel scenario-tab-panel" role="tabpanel" hidden={tab !== "scenario"}>
            <StageScenario wsUrl={wsUrl} token={token} sessionKey={sessionKey} entries={gw.timeline} injectFrame={gw.injectFrame} />
          </section>

          <section className="tab-panel docs-tab-panel" role="tabpanel" hidden={tab !== "docs"}>
            <StageDocs />
          </section>
        </main>
      </div>
    </div>
  );
}
