import { useCallback, useState } from "react";

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

export function StageSentinelDetect() {
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
      const res = await fetch("/api/sentinel/detect", {
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
        <p className="muted">
          이 API는 Vite 개발 서버에서만 제공됩니다. 터미널에서는{" "}
          <code>PYTHONPATH=scripts python scripts/sentinel/detect.py</code>를 실행하세요.
        </p>
      ) : (
        <>
          <p className="muted">
            현재 <code>trace.jsonl</code>과 <code>rules/*.yaml</code>, 베이스라인 JSON을 읽어 규칙을 평가합니다. 먼저
            위에서 ingest로 trace를 쌓은 뒤 실행하는 것이 좋습니다.
          </p>
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
            <p className="muted" style={{ marginTop: 10 }}>
              발화한 규칙이 없습니다. trace가 비었거나 패턴이 맞지 않았을 수 있습니다.
            </p>
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
        </>
      )}
    </div>
  );
}
