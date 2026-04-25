import { useCallback, useEffect, useRef, useState } from "react";
import { apiPath } from "../lib/publicAsset";

export type DetectFinding = {
  id: string;
  ruleId: string;
  severity: string;
  title: string;
  message: string;
  recommendedAction?: string;
  timestamp?: string;
};

export type DetectReport = {
  generated_at?: string;
  findings?: DetectFinding[];
  meta?: {
    trace_path?: string;
    rules_dir?: string;
    baseline_path?: string | null;
    rules_loaded?: number;
    trace_rows?: number;
  };
};

type DetectApiOk = {
  ok: true;
  report: DetectReport;
  stderrTail?: string;
};

type DetectApiErr = {
  ok: false;
  message?: string;
  stderrTail?: string;
  stdoutHead?: string;
};

function isDetectOk(x: unknown): x is DetectApiOk {
  return Boolean(x && typeof x === "object" && (x as DetectApiOk).ok === true && "report" in (x as object));
}

// ── 대응(Remediation) ────────────────────────────────────────────────────

type GuardrailState = "unknown" | "loading" | "on" | "off" | "error";

type GuardrailStatus = {
  state: GuardrailState;
  denyList: string[];
  message?: string;
};

async function callGuardrail(wsUrl: string, token: string, action: "on" | "off" | "status"): Promise<GuardrailStatus> {
  try {
    const res = await fetch(apiPath("/api/scenario/guardrail"), {
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

function RemediationPanel({ findings, wsUrl, token }: {
  findings: DetectFinding[];
  wsUrl: string;
  token: string;
}) {
  const [gs, setGs] = useState<GuardrailStatus>({ state: "unknown", denyList: [] });

  const applyGuardrail = useCallback(async (action: "on" | "off") => {
    const ws = wsUrl.trim();
    const tok = token.trim();
    if (!ws || !tok) return;
    setGs((prev) => ({ ...prev, state: "loading" }));
    const result = await callGuardrail(ws, tok, action);
    setGs(result);
  }, [wsUrl, token]);

  const connected = wsUrl.trim() && token.trim();
  const isLoading = gs.state === "loading";
  const isBlocked = gs.state === "on";
  const isAllowed = gs.state === "off";

  // CRITICAL/HIGH findings에서 도구 이름 추출
  const suspiciousTools = Array.from(new Set(
    findings
      .filter((f) => f.severity === "critical" || f.severity === "high" || f.severity === "CRITICAL" || f.severity === "HIGH")
      .flatMap((f) => {
        const matches = f.message.match(/util_\w+/g) ?? [];
        return matches;
      })
  ));

  if (findings.length === 0) return null;

  return (
    <div className="remediation-panel">
      <h3 className="remediation-title">대응 조치</h3>
      <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 12 }}>
        탐지된 위협에 대해 gateway에서 해당 도구를 즉시 차단할 수 있습니다.
      </p>

      <div className="remediation-action-row">
        <div className="remediation-status">
          {gs.state === "unknown" && <span className="remediation-badge remediation-badge-unknown">차단 상태 미확인</span>}
          {gs.state === "loading" && <span className="remediation-badge remediation-badge-loading">처리 중…</span>}
          {gs.state === "on" && (
            <span className="remediation-badge remediation-badge-blocked">
              차단 적용됨 — {gs.denyList.length}개 도구 비활성화
            </span>
          )}
          {gs.state === "off" && <span className="remediation-badge remediation-badge-allowed">차단 해제됨 — 도구 허용 중</span>}
          {gs.state === "error" && <span className="remediation-badge remediation-badge-error">{gs.message ?? "오류"}</span>}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="remediation-block-btn"
            disabled={!connected || isLoading || isBlocked}
            onClick={() => void applyGuardrail("on")}
            title="탐지된 도구를 gateway.tools.deny에 등록하여 즉시 차단"
          >
            {isLoading ? "적용 중…" : "악성 도구 차단"}
          </button>
          {isBlocked && (
            <button
              type="button"
              className="remediation-unblock-btn"
              disabled={!connected || isLoading || isAllowed}
              onClick={() => void applyGuardrail("off")}
              title="차단 해제 (재테스트용)"
            >
              차단 해제
            </button>
          )}
        </div>
      </div>

      {suspiciousTools.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <span className="muted" style={{ fontSize: "0.75rem" }}>탐지된 의심 도구</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
            {suspiciousTools.map((t) => (
              <code key={t} className="guardrail-deny-chip">{t}</code>
            ))}
          </div>
        </div>
      )}

      {gs.state === "on" && gs.denyList.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <span className="muted" style={{ fontSize: "0.75rem" }}>현재 차단된 도구</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
            {gs.denyList.map((t) => <code key={t} className="guardrail-deny-chip">{t}</code>)}
          </div>
        </div>
      )}
    </div>
  );
}

type FindingsApiResponse = {
  ok: boolean;
  report?: DetectReport;
  checkedAt?: number | null;
  busy?: boolean;
  message?: string;
};

const POLL_INTERVAL_MS = 3000;

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────

export type StageSentinelDetectProps = {
  wsUrl: string;
  token: string;
};

export function StageSentinelDetect({ wsUrl, token }: StageSentinelDetectProps) {
  const [report, setReport] = useState<DetectReport | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [serverBusy, setServerBusy] = useState(false);
  const [controlMissing, setControlMissing] = useState(false);
  const [forceRunBusy, setForceRunBusy] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [traceExists, setTraceExists] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const prevFindingCount = useRef<number>(0);
  const [newAlert, setNewAlert] = useState(false);

  const fetchFindings = useCallback(async () => {
    try {
      const res = await fetch(apiPath("/api/sentinel/findings"), { method: "GET" });
      if (res.status === 404) { setControlMissing(true); return; }
      const j = (await res.json().catch(() => null)) as FindingsApiResponse | null;
      if (!j?.ok || !j.report) return;
      setControlMissing(false);
      setReport(j.report);
      setCheckedAt(j.checkedAt ?? null);
      setServerBusy(j.busy ?? false);
      setTraceExists((j.report?.findings?.length ?? 0) > 0 || Boolean(j.checkedAt));
      const n = j.report.findings?.length ?? 0;
      if (n > prevFindingCount.current) {
        setNewAlert(true);
        setTimeout(() => setNewAlert(false), 4000);
      }
      prevFindingCount.current = n;
    } catch {
      /* silent poll failure */
    }
  }, []);

  // 자동 폴링
  useEffect(() => {
    void fetchFindings();
    const id = window.setInterval(() => void fetchFindings(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [fetchFindings]);

  // 수동 즉시 실행
  const forceRun = useCallback(async () => {
    setForceRunBusy(true);
    setHint(null);
    try {
      const res = await fetch(apiPath("/api/sentinel/detect"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j: unknown = await res.json().catch(() => ({}));
      if (!res.ok || !isDetectOk(j)) {
        const err = (j && typeof j === "object" ? j : {}) as DetectApiErr & Record<string, unknown>;
        setHint(typeof err.message === "string" ? err.message : `탐지 실패 (${res.status})`);
        return;
      }
      setReport(j.report);
      setCheckedAt(Date.now());
      const n = j.report.findings?.length ?? 0;
      setHint(`즉시 검사 완료 — findings ${n}건`);
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e));
    } finally {
      setForceRunBusy(false);
    }
  }, []);

  const clearTrace = useCallback(async () => {
    setClearBusy(true);
    try {
      const res = await fetch(apiPath("/api/sentinel/clear-trace"), { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      setHint(j.ok ? "수집 데이터(trace.jsonl)를 삭제했습니다." : `삭제 실패: ${j.message ?? res.status}`);
      if (j.ok) {
        setReport(null);
        setCheckedAt(null);
        setTraceExists(false);
        prevFindingCount.current = 0;
      }
    } catch (e) {
      setHint(e instanceof Error ? e.message : "삭제 실패");
    } finally {
      setClearBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(() => setHint(null), 5000);
    return () => window.clearTimeout(t);
  }, [hint]);

  const findings = report?.findings ?? [];

  function sevClass(s: string): string {
    const x = (s || "medium").toLowerCase();
    if (x === "critical") return "finding sev-critical";
    if (x === "high") return "finding sev-high";
    if (x === "medium") return "finding sev-medium";
    if (x === "low") return "finding sev-low";
    return "finding sev-info";
  }

  return (
    <div className="panel sentinel-detect-panel">
      <div className="detect-header">
        <h2>Sentinel 탐지</h2>
        {!controlMissing && (
          <div className="detect-live-badge">
            <span className={`detect-live-dot ${serverBusy ? "detect-live-dot-busy" : "detect-live-dot-ok"}`} />
            {serverBusy ? "분석 중…" : "실시간 감시 중"}
          </div>
        )}
      </div>
      {controlMissing ? (
        <p className="muted">개발 서버(<code>run-viz.sh</code>)에서만 제어 가능합니다.</p>
      ) : (
        <>
          <div className="detect-toolbar">
            <button type="button" disabled={forceRunBusy} onClick={() => void forceRun()}>
              {forceRunBusy ? "검사 중…" : "지금 즉시 검사"}
            </button>
            <button
              type="button"
              className="trace-clear-btn"
              disabled={clearBusy || !traceExists}
              title="수집된 trace.jsonl 삭제 — Sentinel 중지 후 사용"
              onClick={() => void clearTrace()}
            >
              {clearBusy ? "삭제 중…" : "수집 데이터 삭제"}
            </button>
            {checkedAt ? (
              <span className="muted" style={{ fontSize: "0.75rem" }}>
                마지막 갱신 {new Date(checkedAt).toLocaleTimeString()}
              </span>
            ) : null}
          </div>

          {newAlert && findings.length > 0 ? (
            <div className="detect-new-alert">
              ⚠ 새 탐지 결과 — findings {findings.length}건
            </div>
          ) : null}

          {hint ? <p className="scenario-hint">{hint}</p> : null}

          {findings.length === 0 && report ? (
            <p className="muted" style={{ marginTop: 10 }}>발화한 규칙 없음</p>
          ) : null}

          <div className="stack detect-findings-stack">
            {findings.map((f) => (
              <div key={f.id} className={sevClass(f.severity)}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <strong>{f.title}</strong>
                  <span className="muted">
                    {(f.severity || "medium").toUpperCase()} · {f.ruleId}
                  </span>
                </div>
                <div style={{ marginTop: 4, fontSize: "0.82rem" }}>{f.message}</div>
                {f.recommendedAction ? (
                  <div className="muted" style={{ marginTop: 6, fontSize: "0.78rem" }}>
                    <strong>권장:</strong> {f.recommendedAction}
                  </div>
                ) : null}
                {f.timestamp ? (
                  <div className="muted" style={{ marginTop: 4, fontSize: "0.72rem" }}>
                    {f.timestamp}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {findings.length > 0 && (
            <RemediationPanel findings={findings} wsUrl={wsUrl} token={token} />
          )}
        </>
      )}
    </div>
  );
}
