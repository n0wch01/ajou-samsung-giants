import { useCallback, useEffect, useRef, useState } from "react";
import { apiPath } from "../lib/publicAsset";
import { sendScenarioThroughDevServer } from "../gateway/scenarioSend";
import { SCENARIO_REGISTRY, type ScenarioEntry } from "../scenarioRegistry";
import { ScenarioFlowTrace } from "../components/ScenarioFlowTrace";
import type { TimelineEntry } from "../gateway/normalizeEvent";
import type { GwFrame } from "../gateway/protocol";

export type StageScenarioProps = {
  wsUrl: string;
  token: string;
  sessionKey: string;
  entries: TimelineEntry[];
  onS1RunSuccess?: () => void;
  injectFrame?: (frame: GwFrame) => void;
};

type PluginCheckState = "idle" | "checking" | "ok" | "missing" | "error";

type PluginStatus = {
  state: PluginCheckState;
  foundTools: string[];
  missingTools: string[];
  message?: string;
};

const SCENARIO_DESCRIPTIONS: Record<string, string> = {
  S1: "악성 플러그인을 통한 도구 위조 및 외부 데이터 유출 시뮬레이션",
  S2: "README 내 프롬프트 인젝션을 통한 민감 데이터 유출 시뮬레이션",
  S3: "종료 조건 없는 반복 도구 호출로 API 남용 및 과금 유발 시뮬레이션",
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

async function managePlugin(action: "install" | "uninstall"): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(apiPath("/api/scenario/plugin-manage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const j = (await res.json()) as { ok?: boolean; message?: string; stderr?: string; stdout?: string };
    if (!j.ok) {
      const detail = [j.message, j.stderr, j.stdout].filter(Boolean).join(" | ");
      return { ok: false, message: detail || "실패" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export function StageScenario(props: StageScenarioProps) {
  const { entries } = props;
  const [hint, setHint] = useState<string | null>(null);
  const [hintType, setHintType] = useState<"ok" | "err" | "info">("info");
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [lastRunScenarioId, setLastRunScenarioId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [pluginStatuses, setPluginStatuses] = useState<Record<string, PluginStatus>>({});
  const checkingRef = useRef<Record<string, boolean>>({});
  const [managingPlugin, setManagingPlugin] = useState<"install" | "uninstall" | null>(null);

  const canSend = !!(props.wsUrl.trim() && props.token.trim() && props.sessionKey.trim());
  const activeCount = SCENARIO_REGISTRY.filter((s) => s.status === "active").length;

  const showHint = useCallback((msg: string, type: "ok" | "err" | "info" = "info") => {
    setHint(msg);
    setHintType(type);
  }, []);

  useEffect(() => {
    if (!hint) return;
    const id = window.setTimeout(() => setHint(null), 7000);
    return () => window.clearTimeout(id);
  }, [hint]);

  const checkPlugin = useCallback(async (entry: ScenarioEntry): Promise<PluginStatus | undefined> => {
    if (!entry.requiredTools?.length) return undefined;
    const ws = props.wsUrl.trim();
    const tok = props.token.trim();
    if (!ws || !tok) return undefined;
    if (checkingRef.current[entry.id]) return undefined;
    checkingRef.current[entry.id] = true;
    setPluginStatuses((prev) => ({ ...prev, [entry.id]: { state: "checking", foundTools: [], missingTools: [] } }));
    const status = await checkPluginStatus(ws, tok, entry.requiredTools);
    checkingRef.current[entry.id] = false;
    setPluginStatuses((prev) => ({ ...prev, [entry.id]: status }));
    return status;
  }, [props.wsUrl, props.token]);

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

  const runScenario = useCallback(async (entry: ScenarioEntry) => {
    const ws = props.wsUrl.trim();
    const tok = props.token.trim();
    const key = props.sessionKey.trim();
    const body = (entry.defaultMessage || "").trim();
    if (!ws || !tok || !key || !body) {
      showHint("gateway 패널에서 WebSocket URL·토큰·세션 키를 채운 뒤 다시 시도하세요.", "err");
      return;
    }
    if (entry.status !== "active") {
      showHint("이 시나리오는 아직 planned 입니다.", "err");
      return;
    }

    if (entry.id === "S3") {
      showHint(`${entry.id}: Sentinel 재시작 중 (trace 초기화 + auto-abort 활성화)…`, "info");
      try {
        await fetch(apiPath("/api/sentinel/stop"), { method: "POST" }).catch(() => {});
        await fetch(apiPath("/api/sentinel/clear-trace"), { method: "POST" }).catch(() => {});
        const startRes = await fetch(apiPath("/api/sentinel/start"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wsUrl: ws, token: tok, sessionKey: key }),
        });
        const startJ = (await startRes.json()) as { ok?: boolean; message?: string };
        if (!startJ.ok) {
          showHint(`Sentinel 재시작 실패: ${startJ.message ?? "unknown"} — 수동으로 시작 후 재실행하세요.`, "err");
          return;
        }
        await new Promise<void>((r) => window.setTimeout(r, 2000));
      } catch (e) {
        showHint(`Sentinel 재시작 오류: ${e instanceof Error ? e.message : String(e)}`, "err");
        return;
      }
    }

    let ps: PluginStatus | undefined = pluginStatuses[entry.id];
    if (entry.requiredTools?.length && (!ps || ps.state === "idle" || ps.state === "checking")) {
      ps = await checkPlugin(entry);
    }
    if (entry.requiredTools?.length && ps?.state === "missing") {
      showHint("플러그인 자동 설치 중…", "info");
      setManagingPlugin("install");
      const installResult = await managePlugin("install");
      setManagingPlugin(null);
      if (!installResult.ok) {
        showHint(`플러그인 설치 실패: ${installResult.message}`, "err");
        return;
      }
      showHint("게이트웨이 재시작 대기 중… (4초)", "info");
      await new Promise<void>((r) => window.setTimeout(r, 4000));
      const afterInstall = await checkPlugin(entry);
      if (afterInstall?.state !== "ok") {
        showHint("설치 완료 후 tools.catalog에 도구가 아직 없습니다. 게이트웨이 연결 상태를 확인 후 재확인하세요.", "err");
        return;
      }
      showHint("플러그인 반영 확인됨. 시나리오 실행 중…", "ok");
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setSendingId(entry.id);
    setLastRunScenarioId(entry.id);
    showHint(`${entry.id} 전송 중…`, "info");
    try {
      if (props.injectFrame) {
        const res = await fetch(apiPath("/api/scenario/chat-stream"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ac.signal,
          body: JSON.stringify({
            wsUrl: ws, token: tok, sessionKey: key,
            message: body, scenarioId: entry.id, resetSession: true,
          }),
        });
        if (!res.ok || !res.body) {
          const j = await res.json().catch(() => ({})) as { message?: string };
          showHint(j.message ?? `HTTP ${res.status}`, "err");
        } else {
          if (entry.id === "S1") props.onS1RunSuccess?.();
          showHint(`${entry.id} 전송 완료.`, "ok");
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const frame = JSON.parse(trimmed) as { type?: string };
                if (frame.type === "event") props.injectFrame!(frame as GwFrame);
                else if (frame.type === "error") showHint((frame as { message?: string }).message ?? "스트리밍 오류", "err");
              } catch { /* skip malformed line */ }
            }
          }
        }
      } else {
        const res = await sendScenarioThroughDevServer({
          wsUrl: ws, token: tok, sessionKey: key,
          message: body, scenarioId: entry.id, signal: ac.signal,
        });
        if (res.ok) {
          if (entry.id === "S1") props.onS1RunSuccess?.();
          showHint(`${entry.id} 전송 완료.`, "ok");
        } else {
          showHint(res.message ?? "전송 실패", "err");
        }
      }
    } catch (e) {
      if ((e as DOMException)?.name !== "AbortError") {
        showHint(e instanceof Error ? e.message : String(e), "err");
      }
    } finally {
      setSendingId(null);
      abortRef.current = null;
    }
  }, [props, pluginStatuses, checkPlugin, showHint]);

  const handlePluginManage = useCallback(async (entry: ScenarioEntry, action: "install" | "uninstall") => {
    setManagingPlugin(action);
    showHint(action === "install" ? "플러그인 설치 중…" : "플러그인 제거 중…", "info");
    const result = await managePlugin(action);
    if (!result.ok) {
      setManagingPlugin(null);
      showHint(`${action === "install" ? "설치" : "제거"} 실패: ${result.message}`, "err");
      return;
    }
    setManagingPlugin(null);
    if (action === "uninstall") {
      showHint("제거 완료. 왼쪽 패널에서 Connect를 다시 눌러 재연결하세요.", "ok");
      setPluginStatuses((prev) => ({
        ...prev,
        [entry.id]: { state: "missing", foundTools: [], missingTools: entry.requiredTools ?? [] },
      }));
    } else {
      showHint("게이트웨이 재시작 대기 중… (4초)", "info");
      await new Promise<void>((r) => window.setTimeout(r, 4000));
      const st = await checkPlugin(entry);
      if (st?.state !== "ok") {
        showHint("설치 후 카탈로그에 도구가 아직 없습니다. 연결 상태 확인 후 재확인하세요.", "err");
      } else {
        showHint("설치 완료. 도구가 카탈로그에 반영되었습니다.", "ok");
      }
    }
  }, [checkPlugin, showHint]);

  return (
    <div className="sc-page">

      {/* ── 페이지 헤더 ── */}
      <div className="sc-page-header">
        <div className="sc-page-title-wrap">
          <h2 className="sc-page-title">Test Scenario</h2>
          <p className="sc-page-desc">AI Agent 보안 시나리오를 선택하고 실행하여 탐지 및 대응 결과를 확인하세요.</p>
        </div>
        <div className="sc-status-bar">
          <div className="sc-status-item">
            <span className="sc-status-label">ACTIVE SCENARIOS</span>
            <span className="sc-status-value">{activeCount}</span>
          </div>
          <div className="sc-status-divider" />
          <div className="sc-status-item">
            <span className="sc-status-label">GATEWAY</span>
            <span className={`sc-status-chip ${canSend ? "sc-chip-ok" : "sc-chip-off"}`}>
              {canSend ? "● Connected" : "○ Not Set"}
            </span>
          </div>
          <div className="sc-status-divider" />
          <div className="sc-status-item">
            <span className="sc-status-label">MONITORING</span>
            <span className={`sc-status-chip ${canSend ? "sc-chip-ok" : "sc-chip-off"}`}>
              {canSend ? "● On" : "○ Off"}
            </span>
          </div>
        </div>
      </div>

      {/* ── 힌트 토스트 ── */}
      {hint && (
        <div className={`sc-toast sc-toast-${hintType}`}>{hint}</div>
      )}

      {/* ── 시나리오 카드 그리드 ── */}
      <div className="sc-card-grid">
        {SCENARIO_REGISTRY.map((s) => {
          const active = s.status === "active";
          const busy = sendingId === s.id;
          const ps = s.requiredTools?.length
            ? (pluginStatuses[s.id] ?? { state: "idle", foundTools: [], missingTools: [] })
            : null;

          return (
            <div key={s.id} className={`sc-card ${active ? "sc-card-active" : "sc-card-planned"}`}>

              {/* 카드 헤더 */}
              <div className="sc-card-header">
                <div className="sc-card-header-top">
                  <span className="sc-card-id">{s.id}</span>
                  <span className={`sc-card-status ${active ? "sc-card-status-active" : "sc-card-status-planned"}`}>
                    {active ? "● Active" : "○ Planned"}
                  </span>
                </div>
                <h3 className="sc-card-title">{s.title}</h3>
              </div>

              {/* 카드 바디 */}
              <div className="sc-card-body">
                <code className="sc-card-path">{s.docPath}</code>
                <p className="sc-card-desc">{SCENARIO_DESCRIPTIONS[s.id]}</p>

                {/* 플러그인 상태 */}
                {ps !== null && (
                  <div className="sc-plugin-row">
                    <span className={`sc-plugin-status sc-plugin-${ps.state}`}>
                      {ps.state === "idle"     && "플러그인 미확인"}
                      {ps.state === "checking" && "확인 중…"}
                      {ps.state === "ok"       && `✓ 플러그인 설치됨 (${ps.foundTools.length}개)`}
                      {ps.state === "missing"  && `✗ 미설치 — ${ps.missingTools.join(", ")}`}
                      {ps.state === "error"    && (ps.message ?? "확인 실패")}
                    </span>
                    <button
                      type="button"
                      className="sc-btn-ghost"
                      disabled={ps.state === "checking"}
                      onClick={() => void checkPlugin(s)}
                    >
                      재확인
                    </button>
                  </div>
                )}
              </div>

              {/* 카드 푸터 */}
              <div className="sc-card-footer">
                <button
                  type="button"
                  className="sc-btn-primary"
                  disabled={!canSend || !active || busy || (ps !== null && managingPlugin !== null)}
                  onClick={() => void runScenario(s)}
                >
                  {busy ? "실행 중…" : managingPlugin === "install" ? "플러그인 설치 중…" : "시나리오 실행"}
                </button>

                {ps !== null && (
                  <>
                    {(ps.state === "missing" || ps.state === "error") && (
                      <button
                        type="button"
                        className="sc-btn-success"
                        disabled={managingPlugin !== null}
                        onClick={() => void handlePluginManage(s, "install")}
                      >
                        {managingPlugin === "install" ? "설치 중…" : "플러그인 설치"}
                      </button>
                    )}
                    {ps.state === "ok" && (
                      <button
                        type="button"
                        className="sc-btn-danger"
                        disabled={managingPlugin !== null}
                        onClick={() => void handlePluginManage(s, "uninstall")}
                      >
                        {managingPlugin === "uninstall" ? "제거 중…" : "플러그인 제거"}
                      </button>
                    )}
                  </>
                )}

              </div>

            </div>
          );
        })}
      </div>

      <ScenarioFlowTrace entries={entries} sessionKey={props.sessionKey} scenarioId={lastRunScenarioId} />
    </div>
  );
}
