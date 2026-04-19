import { useCallback, useEffect, useRef, useState } from "react";
import { sendScenarioThroughDevServer } from "../gateway/scenarioSend";
import { SCENARIO_REGISTRY, type ScenarioEntry } from "../scenarioRegistry";

export type StageScenarioProps = {
  wsUrl: string;
  token: string;
  sessionKey: string;
};

function escapeForDoubleQuotedShell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
}

function buildSendScript(props: {
  wsUrl: string;
  token: string;
  sessionKey: string;
  scenarioId: string;
  message: string;
}): string {
  const w = escapeForDoubleQuotedShell(props.wsUrl.trim());
  const t = escapeForDoubleQuotedShell(props.token.trim());
  const k = escapeForDoubleQuotedShell(props.sessionKey.trim());
  const m = escapeForDoubleQuotedShell(props.message);
  return [
    "# SG 리포지토리 루트에서 실행. chat.send에 operator.write 스코프가 필요합니다.",
    `export OPENCLAW_GATEWAY_WS_URL="${w}"`,
    `export OPENCLAW_GATEWAY_TOKEN="${t}"`,
    `export OPENCLAW_GATEWAY_SESSION_KEY="${k}"`,
    `export OPENCLAW_GATEWAY_SCOPES="operator.write,operator.read"`,
    `export OPENCLAW_SCENARIO_MESSAGE="${m}"`,
    `PYTHONPATH=scripts python3 scripts/runner/send_scenario.py --scenario ${props.scenarioId}`,
  ].join("\n");
}

export function StageScenario(props: StageScenarioProps) {
  const [overrideMessage, setOverrideMessage] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!hint) return;
    const id = window.setTimeout(() => setHint(null), 7000);
    return () => window.clearTimeout(id);
  }, [hint]);

  const runScenario = useCallback(
    async (entry: ScenarioEntry) => {
      const ws = props.wsUrl.trim();
      const tok = props.token.trim();
      const key = props.sessionKey.trim();
      const body = (overrideMessage.trim() || entry.defaultMessage || "").trim();
      if (!ws || !tok || !key || !body) {
        setHint("연결 탭에서 WebSocket URL·토큰·세션 키를 채운 뒤 다시 시도하세요.");
        return;
      }
      if (entry.status !== "active") {
        setHint("이 시나리오는 아직 planned 입니다.");
        return;
      }
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setSendingId(entry.id);
      setHint(`${entry.id} chat.send 전송 중…`);
      try {
        const res = await sendScenarioThroughDevServer({
          wsUrl: ws,
          token: tok,
          sessionKey: key,
          message: body,
          scenarioId: entry.id,
          signal: ac.signal,
        });
        if (res.ok) {
          setHint(`${entry.id} 전송 완료. 세션 탭에서 같은 세션으로 연결되어 있으면 타임라인에 반영됩니다.`);
        } else {
          setHint(res.message);
        }
      } catch (e) {
        setHint(e instanceof Error ? e.message : String(e));
      } finally {
        setSendingId(null);
        abortRef.current = null;
      }
    },
    [overrideMessage, props.sessionKey, props.token, props.wsUrl],
  );

  const copyScriptFor = useCallback(
    async (entry: ScenarioEntry) => {
      const ws = props.wsUrl.trim();
      const tok = props.token.trim();
      const key = props.sessionKey.trim();
      if (!ws || !tok || !key) {
        setHint("URL·토큰·세션 키를 먼저 채워 주세요.");
        return;
      }
      const msg = (overrideMessage.trim() || entry.defaultMessage || "").trim();
      const script = buildSendScript({
        wsUrl: ws,
        token: tok,
        sessionKey: key,
        scenarioId: entry.id,
        message: msg,
      });
      try {
        await navigator.clipboard.writeText(script);
        setHint(`${entry.id}용 터미널 스크립트를 복사했습니다.`);
      } catch {
        setHint("클립보드 복사에 실패했습니다.");
      }
    },
    [overrideMessage, props.sessionKey, props.token, props.wsUrl],
  );

  const canSend = props.wsUrl.trim() && props.token.trim() && props.sessionKey.trim();

  return (
    <div className="panel scenario-panel scenario-panel-v2">
      <h2>시나리오 테스트</h2>
      <p className="muted">
        <strong>이 시나리오 실행</strong>은 Vite 개발 서버가 호스트에서 <code>send_scenario.py</code>를 돌려
        <code>chat.send</code>를 보냅니다(로컬 <code>device.json</code>으로 <code>operator.write</code> 유지).{" "}
        <code>npm run dev</code> / <code>run-viz.sh</code>가 아니면 API가 없어 실패합니다. 메시지는 아래에서 덮어쓸 수 있습니다.
      </p>

      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="scen-override">메시지 덮어쓰기 (선택, 비우면 각 시나리오 기본값)</label>
        <textarea
          id="scen-override"
          className="scenario-textarea"
          rows={3}
          spellCheck={false}
          placeholder="비워 두면 카탈로그 기본 메시지로 전송됩니다."
          value={overrideMessage}
          onChange={(e) => setOverrideMessage(e.target.value)}
        />
      </div>

      <div className="scenario-card-grid">
        {SCENARIO_REGISTRY.map((s) => {
          const active = s.status === "active";
          const busy = sendingId === s.id;
          return (
            <div key={s.id} className={`scenario-card ${active ? "is-active" : "is-planned"}`}>
              <div className="scenario-card-top">
                <strong className="scenario-card-id">{s.id}</strong>
                <span className={`scenario-status-pill ${s.status}`}>{s.status}</span>
              </div>
              <div className="scenario-card-title">{s.title}</div>
              <code className="scenario-card-path">{s.docPath}</code>
              <div className="row scenario-card-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={!canSend || !active || busy}
                  onClick={() => void runScenario(s)}
                >
                  {busy ? "전송 중…" : "이 시나리오 실행"}
                </button>
                <button type="button" disabled={!canSend} onClick={() => void copyScriptFor(s)}>
                  CLI 스크립트 복사
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {hint ? <p className="scenario-hint">{hint}</p> : null}
    </div>
  );
}
