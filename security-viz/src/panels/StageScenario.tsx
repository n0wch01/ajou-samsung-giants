import { useCallback, useEffect, useRef, useState } from "react";
import { sendScenarioThroughDevServer } from "../gateway/scenarioSend";
import { SCENARIO_REGISTRY, type ScenarioEntry } from "../scenarioRegistry";

export type StageScenarioProps = {
  wsUrl: string;
  token: string;
  sessionKey: string;
};

type PluginCheckState = "idle" | "checking" | "ok" | "missing" | "error";

type PluginStatus = {
  state: PluginCheckState;
  foundTools: string[];
  missingTools: string[];
  message?: string;
};

// ── 가드레일 ──────────────────────────────────────────────────────────────

type GuardrailState = "unknown" | "loading" | "on" | "off" | "error";

type GuardrailStatus = {
  state: GuardrailState;
  denyList: string[];
  message?: string;
};

async function fetchGuardrail(wsUrl: string, token: string, action: "on" | "off" | "status"): Promise<GuardrailStatus> {
  try {
    const res = await fetch("/api/scenario/guardrail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wsUrl, token, action }),
    });
    if (res.status === 404) {
      return { state: "error", denyList: [], message: "개발 서버에서만 사용 가능합니다." };
    }
    const j = (await res.json()) as {
      ok?: boolean;
      guardrailActive?: boolean;
      denyList?: string[];
      message?: string;
    };
    if (!j.ok) {
      return { state: "error", denyList: [], message: j.message ?? "요청 실패" };
    }
    return {
      state: j.guardrailActive ? "on" : "off",
      denyList: j.denyList ?? [],
    };
  } catch (e) {
    return { state: "error", denyList: [], message: e instanceof Error ? e.message : String(e) };
  }
}

function GuardrailToggle({ wsUrl, token }: { wsUrl: string; token: string }) {
  const [gs, setGs] = useState<GuardrailStatus>({ state: "unknown", denyList: [] });

  const load = useCallback(async (action: "on" | "off" | "status") => {
    const ws = wsUrl.trim();
    const tok = token.trim();
    if (!ws || !tok) return;
    setGs((prev) => ({ ...prev, state: "loading" }));
    const result = await fetchGuardrail(ws, tok, action);
    setGs(result);
  }, [wsUrl, token]);

  useEffect(() => {
    const ws = wsUrl.trim();
    const tok = token.trim();
    if (ws && tok) void load("status");
  }, [wsUrl, token, load]);

  const connected = wsUrl.trim() && token.trim();
  const isLoading = gs.state === "loading";
  const isOn = gs.state === "on";
  const isOff = gs.state === "off";

  return (
    <div className="guardrail-bar">
      <span className="guardrail-label">가드레일</span>
      <span className={`guardrail-badge guardrail-badge-${gs.state}`}>
        {gs.state === "unknown" && "미확인"}
        {gs.state === "loading" && "처리 중…"}
        {gs.state === "on" && `ON (${gs.denyList.length}개 차단)`}
        {gs.state === "off" && "OFF"}
        {gs.state === "error" && (gs.message ?? "오류")}
      </span>
      <div className="guardrail-actions">
        <button
          type="button"
          className={`guardrail-btn guardrail-btn-on${isOn ? " active" : ""}`}
          disabled={!connected || isLoading || isOn}
          onClick={() => void load("on")}
          title="S1 도구를 gateway.tools.deny에 추가 (가드레일 활성화)"
        >
          활성화
        </button>
        <button
          type="button"
          className={`guardrail-btn guardrail-btn-off${isOff ? " active" : ""}`}
          disabled={!connected || isLoading || isOff}
          onClick={() => void load("off")}
          title="gateway.tools.deny를 비워 모든 도구 허용 (가드레일 비활성화)"
        >
          비활성화
        </button>
        <button
          type="button"
          className="guardrail-btn guardrail-btn-refresh"
          disabled={!connected || isLoading}
          onClick={() => void load("status")}
          title="현재 상태 새로고침"
        >
          ↺
        </button>
      </div>
      {gs.state === "on" && gs.denyList.length > 0 && (
        <div className="guardrail-deny-list">
          {gs.denyList.map((t) => <code key={t} className="guardrail-deny-chip">{t}</code>)}
        </div>
      )}
    </div>
  );
}

async function checkPluginStatus(
  wsUrl: string,
  token: string,
  toolNames: string[],
): Promise<PluginStatus> {
  try {
    const res = await fetch("/api/scenario/plugin-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wsUrl, token, toolNames }),
    });
    if (res.status === 404) {
      return { state: "error", foundTools: [], missingTools: toolNames, message: "개발 서버에서만 확인 가능합니다." };
    }
    const j = (await res.json()) as {
      ok?: boolean;
      installed?: boolean;
      foundTools?: string[];
      missingTools?: string[];
      message?: string;
    };
    if (!j.ok) {
      return { state: "error", foundTools: [], missingTools: toolNames, message: j.message ?? "확인 실패" };
    }
    return {
      state: j.installed ? "ok" : "missing",
      foundTools: j.foundTools ?? [],
      missingTools: j.missingTools ?? [],
    };
  } catch (e) {
    return { state: "error", foundTools: [], missingTools: toolNames, message: e instanceof Error ? e.message : String(e) };
  }
}

export function StageScenario(props: StageScenarioProps) {
  const [overrideMessage, setOverrideMessage] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // scenarioId → PluginStatus
  const [pluginStatuses, setPluginStatuses] = useState<Record<string, PluginStatus>>({});
  const checkingRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    if (!hint) return;
    const id = window.setTimeout(() => setHint(null), 7000);
    return () => window.clearTimeout(id);
  }, [hint]);

  const checkPlugin = useCallback(
    async (entry: ScenarioEntry) => {
      if (!entry.requiredTools?.length) return;
      const ws = props.wsUrl.trim();
      const tok = props.token.trim();
      if (!ws || !tok) return;
      if (checkingRef.current[entry.id]) return;
      checkingRef.current[entry.id] = true;
      setPluginStatuses((prev) => ({ ...prev, [entry.id]: { state: "checking", foundTools: [], missingTools: [] } }));
      const status = await checkPluginStatus(ws, tok, entry.requiredTools);
      checkingRef.current[entry.id] = false;
      setPluginStatuses((prev) => ({ ...prev, [entry.id]: status }));
    },
    [props.wsUrl, props.token],
  );

  // 연결 정보가 바뀌면 requiredTools가 있는 시나리오를 자동 확인
  useEffect(() => {
    const ws = props.wsUrl.trim();
    const tok = props.token.trim();
    if (!ws || !tok) return;
    for (const entry of SCENARIO_REGISTRY) {
      if (entry.requiredTools?.length && entry.status === "active") {
        void checkPlugin(entry);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.wsUrl, props.token]);

  const runScenario = useCallback(
    async (entry: ScenarioEntry) => {
      const ws = props.wsUrl.trim();
      const tok = props.token.trim();
      const key = props.sessionKey.trim();
      const body = (overrideMessage.trim() || entry.defaultMessage || "").trim();
      if (!ws || !tok || !key || !body) {
        setHint("gateway 패널에서 WebSocket URL·토큰·세션 키를 채운 뒤 다시 시도하세요.");
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
          setHint(`${entry.id} 전송 완료. 채팅 탭에서 타임라인을 확인하세요.`);
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

  const canSend = props.wsUrl.trim() && props.token.trim() && props.sessionKey.trim();

  return (
    <div className="panel scenario-panel scenario-panel-v2">
      <h2>시나리오 테스트</h2>
      <GuardrailToggle wsUrl={props.wsUrl} token={props.token} />
      <div className="field" style={{ marginTop: 12 }}>
        {SCENARIO_REGISTRY.filter((s) => s.messageVariants && s.status === "active").map((s) => (
          <div key={s.id}>
            <div className="variant-btn-row">
              {s.messageVariants!.map((v) => (
                <button
                  key={v.label}
                  type="button"
                  className={`variant-btn${overrideMessage === v.message ? " variant-btn-active" : ""}`}
                  onClick={() => setOverrideMessage(overrideMessage === v.message ? "" : v.message)}
                  title={v.message}
                >
                  {v.label}
                </button>
              ))}
            </div>
            {overrideMessage ? (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 6 }}>
                {overrideMessage}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      <div className="scenario-card-grid">
        {SCENARIO_REGISTRY.map((s) => {
          const active = s.status === "active";
          const busy = sendingId === s.id;
          const ps = s.requiredTools?.length ? (pluginStatuses[s.id] ?? { state: "idle", foundTools: [], missingTools: [] }) : null;
          const pluginBlocking = ps !== null && (ps.state === "missing" || ps.state === "error");
          return (
            <div key={s.id} className={`scenario-card ${active ? "is-active" : "is-planned"}`}>
              <div className="scenario-card-top">
                <strong className="scenario-card-id">{s.id}</strong>
                <span className={`scenario-status-pill ${s.status}`}>{s.status}</span>
              </div>
              <div className="scenario-card-title">{s.title}</div>
              <code className="scenario-card-path">{s.docPath}</code>

              {ps !== null && (
                <div className="plugin-status-row">
                  {ps.state === "idle" && (
                    <span className="plugin-status plugin-status-idle">플러그인 미확인</span>
                  )}
                  {ps.state === "checking" && (
                    <span className="plugin-status plugin-status-checking">플러그인 확인 중…</span>
                  )}
                  {ps.state === "ok" && (
                    <span className="plugin-status plugin-status-ok">
                      ✓ 플러그인 설치됨 ({ps.foundTools.length}개 도구)
                    </span>
                  )}
                  {ps.state === "missing" && (
                    <span className="plugin-status plugin-status-missing">
                      ✗ 플러그인 미설치 — {ps.missingTools.join(", ")}
                    </span>
                  )}
                  {ps.state === "error" && (
                    <span className="plugin-status plugin-status-error">
                      {ps.message ?? "확인 실패"}
                    </span>
                  )}
                  <button
                    type="button"
                    className="plugin-recheck-btn"
                    disabled={ps.state === "checking"}
                    onClick={() => void checkPlugin(s)}
                    title="플러그인 설치 상태 재확인"
                  >
                    재확인
                  </button>
                </div>
              )}

              {ps?.state === "missing" && (
                <div className="plugin-install-hint">
                  <code>openclaw plugins install ./mock-malicious-plugin</code>
                </div>
              )}

              <div className="row scenario-card-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={!canSend || !active || busy || pluginBlocking}
                  onClick={() => void runScenario(s)}
                  title={pluginBlocking ? "플러그인을 먼저 설치하세요" : undefined}
                >
                  {busy ? "전송 중…" : "이 시나리오 실행"}
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
