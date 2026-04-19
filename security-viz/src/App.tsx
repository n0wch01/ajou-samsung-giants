import { useCallback, useState } from "react";
import { MessageToolFlow } from "./components/MessageToolFlow";
import { StageInput } from "./panels/StageInput";
import { StageScenario } from "./panels/StageScenario";
import { StageSentinel } from "./panels/StageSentinel";
import { useGatewayReadonly } from "./gateway/useGatewayReadonly";

export function App() {
  const gw = useGatewayReadonly();
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
          OpenClaw 세션을 읽기 전용으로 구독합니다. 카카오톡처럼 내 메시지, 에이전트 답변, 그에 이어진 도구 호출을 봅니다.
        </p>
      </header>
      <div className="app-body app-body-single">
        <main className="main main-single">
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
          <StageScenario wsUrl={wsUrl} token={token} sessionKey={sessionKey} />
          <StageSentinel wsUrl={wsUrl} token={token} sessionKey={sessionKey} />
          <MessageToolFlow entries={gw.timeline} connState={gw.connState} />
        </main>
      </div>
    </div>
  );
}
