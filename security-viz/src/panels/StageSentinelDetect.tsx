import { useCallback, useState } from "react";
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

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────

export type StageSentinelDetectProps = {
  wsUrl: string;
  token: string;
};

export function StageSentinelDetect({ wsUrl, token }: StageSentinelDetectProps) {
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [report, setReport] = useState<DetectReport | null>(null);
  const [stderrTail, setStderrTail] = useState<string | null>(null);
  const [controlMissing, setControlMissing] = useState(false);

  const runDetect = useCallback(async () => {
    setBusy(true);
    setHint(null);
    setStderrTail(null);
    try {
      const res = await fetch(apiPath("/api/sentinel/detect"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j: unknown = await res.json().catch(() => ({}));
      if (!res.ok || !isDetectOk(j)) {
        const err = (j && typeof j === "object" ? j : {}) as DetectApiErr & Record<string, unknown>;
        setControlMissing(res.status === 404);
        setReport(null);
        setStderrTail(typeof err.stderrTail === "string" ? err.stderrTail : null);
        setHint(
          typeof err.message === "string" ? err.message : `탐지 요청 실패 (${res.status})`,
        );
        return;
      }
      setControlMissing(false);
      const ok = j;
      setReport(ok.report);
      setStderrTail(ok.stderrTail?.trim() ? ok.stderrTail : null);
      const n = ok.report.findings?.length ?? 0;
      setHint(`탐지 완료: findings ${n}건 (rules ${ok.report.meta?.rules_loaded ?? "—"}, trace 행 ${ok.report.meta?.trace_rows ?? "—"})`);
    } catch (e) {
      setControlMissing(true);
      setReport(null);
      setHint(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

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
      <h2>Sentinel 탐지 (detect)</h2>
      {controlMissing ? (
        <p className="muted">개발 서버에서만 제어 가능합니다.</p>
      ) : (
        <>
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" className="primary" disabled={busy} onClick={() => void runDetect()}>
              {busy ? "탐지 실행 중…" : "규칙 검증 실행 (detect.py)"}
            </button>
          </div>
          {report?.meta ? (
            <p className="muted detect-meta" style={{ marginTop: 10, fontSize: "0.78rem" }}>
              trace: <code>{report.meta.trace_path}</code> · rules: <code>{report.meta.rules_dir}</code> ·
              baseline: <code>{report.meta.baseline_path ?? "—"}</code>
            </p>
          ) : null}
          {hint ? <p className="scenario-hint">{hint}</p> : null}
          {stderrTail ? (
            <details className="sentinel-logs">
              <summary>detect stderr (끝부분)</summary>
              <pre className="sentinel-pre">{stderrTail}</pre>
            </details>
          ) : null}
          {findings.length === 0 && report && !busy ? (
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
