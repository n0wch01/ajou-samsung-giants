import { useCallback, useEffect, useRef, useState } from "react";
import { apiPath } from "../lib/publicAsset";
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

async function checkPluginStatus(
  wsUrl: string,
  token: string,
  toolNames: string[],
): Promise<PluginStatus> {
  try {
    const res = await fetch(apiPath("/api/scenario/plugin-status"), {
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

async function fetchGuardrail(wsUrl: string, token: string, action: "on" | "off" | "status") {
  try {
    const res = await fetch(apiPath("/api/scenario/guardrail"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wsUrl, token, action }),
    });
    const j = (await res.json()) as { ok?: boolean; guardrailActive?: boolean; denyList?: string[]; message?: string };
    if (!j.ok) return { state: "error" as const, denyList: [] as string[], message: j.message ?? "실패" };
    return { state: (j.guardrailActive ? "on" : "off") as "on" | "off", denyList: j.denyList ?? [] };
  } catch (e) {
    return { state: "error" as const, denyList: [] as string[], message: e instanceof Error ? e.message : String(e) };
  }
}

function GuardrailBar({ wsUrl, token }: { wsUrl: string; token: string }) {
  const [state, setState] = useState<"unknown" | "loading" | "on" | "off" | "error">("unknown");
  const [message, setMessage] = useState<string | undefined>();

  const run = useCallback(async (action: "on" | "off" | "status") => {
    if (!wsUrl.trim() || !token.trim()) return;
    setState("loading");
    const r = await fetchGuardrail(wsUrl, token, action);
    setState(r.state);
    setMessage("message" in r ? r.message : undefined);
  }, [wsUrl, token]);

  useEffect(() => { void run("status"); }, [run]);

  const connected = wsUrl.trim() && token.trim();
  const loading = state === "loading";

  return (
    <div className="scenario-guardrail-bar">
      <span className="scenario-guardrail-label">가드레일</span>
      <div className="scenario-guardrail-btns">
        <button
          type="button"
          className={`scenario-guardrail-btn scenario-guardrail-btn-on${state === "on" ? " active" : ""}`}
          disabled={!connected || loading || state === "on"}
          onClick={() => void run("on")}
        >
          ON
        </button>
        <button
          type="button"
          className={`scenario-guardrail-btn scenario-guardrail-btn-off${state === "off" ? " active" : ""}`}
          disabled={!connected || loading || state === "off"}
          onClick={() => void run("off")}
        >
          OFF
        </button>
      </div>
      <span className={`scenario-guardrail-status scenario-guardrail-status-${state}`}>
        {state === "unknown" && "미확인"}
        {state === "loading" && "…"}
        {state === "on" && "도구 차단 중"}
        {state === "off" && "도구 허용 중"}
        {state === "error" && (message ?? "오류")}
      </span>
    </div>
  );
}

async function managePlugin(action: "install" | "uninstall"): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(apiPath("/api/scenario/plugin-manage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const j = (await res.json()) as { ok?: boolean; message?: string; stderr?: string };
    if (!j.ok) return { ok: false, message: j.message ?? j.stderr ?? "실패" };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
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
  const [managingPlugin, setManagingPlugin] = useState<"install" | "uninstall" | null>(null);

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
      // 플러그인 미설치 시 자동 설치
      const ps = pluginStatuses[entry.id];
      if (entry.requiredTools?.length && ps?.state === "missing") {
        setHint("플러그인 자동 설치 중…");
        setManagingPlugin("install");
        const installResult = await managePlugin("install");
        setManagingPlugin(null);
        if (!installResult.ok) {
          setHint(`플러그인 설치 실패: ${installResult.message}`);
          return;
        }
        setHint("플러그인 설치 완료. 시나리오 실행 중…");
        await checkPlugin(entry);
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
    [overrideMessage, props.sessionKey, props.token, props.wsUrl, pluginStatuses, checkPlugin],
  );

  const handlePluginManage = useCallback(async (entry: ScenarioEntry, action: "install" | "uninstall") => {
    setManagingPlugin(action);
    setHint(action === "install" ? "플러그인 설치 중…" : "플러그인 제거 중…");
    const result = await managePlugin(action);
    if (!result.ok) {
      setManagingPlugin(null);
      setHint(`${action === "install" ? "설치" : "제거"} 실패: ${result.message}`);
      return;
    }
    setManagingPlugin(null);
    if (action === "uninstall") {
      setHint("제거 완료.");
      // 파일시스템에서 이미 제거됐으므로 Gateway 재연결 없이 바로 missing으로 설정
      setPluginStatuses((prev) => ({
        ...prev,
        [entry.id]: { state: "missing", foundTools: [], missingTools: entry.requiredTools ?? [] },
      }));
    } else {
      setHint("설치 완료. 상태를 확인합니다…");
      await checkPlugin(entry);
    }
  }, [checkPlugin]);

  const canSend = props.wsUrl.trim() && props.token.trim() && props.sessionKey.trim();

  return (
    <div className="panel scenario-panel scenario-panel-v2">
      <h2>시나리오 테스트</h2>
      <GuardrailBar wsUrl={props.wsUrl} token={props.token} />
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

              {ps !== null && (
                <div className="plugin-manage-row">
                  {ps.state === "missing" || ps.state === "error" ? (
                    <button
                      type="button"
                      className="plugin-manage-btn plugin-manage-btn-install"
                      disabled={managingPlugin !== null}
                      onClick={() => void handlePluginManage(s, "install")}
                    >
                      {managingPlugin === "install" ? "설치 중…" : "플러그인 설치"}
                    </button>
                  ) : ps.state === "ok" ? (
                    <button
                      type="button"
                      className="plugin-manage-btn plugin-manage-btn-uninstall"
                      disabled={managingPlugin !== null}
                      onClick={() => void handlePluginManage(s, "uninstall")}
                    >
                      {managingPlugin === "uninstall" ? "제거 중…" : "플러그인 제거"}
                    </button>
                  ) : null}
                </div>
              )}

              <div className="row scenario-card-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={!canSend || !active || busy || managingPlugin !== null}
                  onClick={() => void runScenario(s)}
                >
                  {busy ? "전송 중…" : managingPlugin === "install" ? "설치 후 실행 중…" : "이 시나리오 실행"}
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
