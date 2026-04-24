import { useCallback, useState } from "react";
import { publicAsset } from "./lib/publicAsset";
import { MessageToolFlow } from "./components/MessageToolFlow";
import { StageInput } from "./panels/StageInput";
import { StagePolicy } from "./panels/StagePolicy";
import { StageScenario } from "./panels/StageScenario";
import { StageSentinel } from "./panels/StageSentinel";
import { StageSentinelDetect } from "./panels/StageSentinelDetect";
import { useGatewayReadonly } from "./gateway/useGatewayReadonly";

export type AppMainTab = "chat" | "scenario" | "policy" | "sentinel";

export function App() {
  const gw = useGatewayReadonly();
  const [tab, setTab] = useState<AppMainTab>("chat");
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

  const [configPayload, setConfigPayload] = useState<unknown>(undefined);
  const [catalogPayload, setCatalogPayload] = useState<unknown>(undefined);
  const [configError, setConfigError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);

  const onConnect = useCallback(() => {
    localStorage.setItem("sg.viz.wsUrl", wsUrl);
    localStorage.setItem("sg.viz.token", token);
    localStorage.setItem("sg.viz.sessionKey", sessionKey);
    gw.connect(wsUrl.trim(), token.trim(), sessionKey.trim());
  }, [gw, sessionKey, token, wsUrl]);

  const onRefreshConfig = useCallback(async () => {
    setPolicyBusy(true);
    setConfigError(null);
    try {
      const res = await gw.sendReadonly("config.get", {});
      setConfigPayload(res);
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolicyBusy(false);
    }
  }, [gw]);

  const onRefreshCatalog = useCallback(async () => {
    setPolicyBusy(true);
    setCatalogError(null);
    try {
      const res = await gw.sendReadonly("tools.catalog", { includePlugins: true });
      setCatalogPayload(res);
    } catch (e) {
      setCatalogError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolicyBusy(false);
    }
  }, [gw]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-header-chito-wrap">
            <img src={publicAsset("sgclaw_nobg.png")} alt="sgclaw" className="app-header-chito" />
          </div>
          <div>
            <h1>SG-ClawWatch</h1>
          </div>
        </div>
      </header>
      <nav className="app-tabs" role="tablist" aria-label="주요 영역">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "chat"}
          className={tab === "chat" ? "app-tab active" : "app-tab"}
          onClick={() => setTab("chat")}
        >
          채팅
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
          aria-selected={tab === "policy"}
          className={tab === "policy" ? "app-tab active" : "app-tab"}
          onClick={() => setTab("policy")}
        >
          정책
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
      <div className="app-body">
        <aside className="app-sidebar-left">
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
        </aside>
        <main className="app-main">
          <section className="tab-panel chat-tab-panel" role="tabpanel" hidden={tab !== "chat"}>
            <MessageToolFlow
              entries={gw.timeline}
              connState={gw.connState}
              wsUrl={wsUrl}
              token={token}
              sessionKey={sessionKey}
            />
          </section>

          <section className="tab-panel" role="tabpanel" hidden={tab !== "scenario"}>
            <StageScenario wsUrl={wsUrl} token={token} sessionKey={sessionKey} />
          </section>

          <section className="tab-panel" role="tabpanel" hidden={tab !== "policy"}>
            <StagePolicy
              configPayload={configPayload}
              catalogPayload={catalogPayload}
              configError={configError}
              catalogError={catalogError}
              onRefreshConfig={() => void onRefreshConfig()}
              onRefreshCatalog={() => void onRefreshCatalog()}
              busy={policyBusy}
            />
          </section>

          <section className="tab-panel" role="tabpanel" hidden={tab !== "sentinel"}>
            <div className="sentinel-tab-stack">
              <StageSentinel wsUrl={wsUrl} token={token} sessionKey={sessionKey} />
              <StageSentinelDetect wsUrl={wsUrl} token={token} />
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
