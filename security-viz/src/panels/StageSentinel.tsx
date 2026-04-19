import { useCallback, useEffect, useRef, useState } from "react";

export type SentinelStatusPayload = {
  controlAvailable: boolean;
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  uptimeMs: number | null;
  lastExitCode: number | null;
  trace: { path: string; exists: boolean; mtimeMs: number | null; bytes: number | null };
  stderrTail: string;
  spawnError: string | null;
};

export type StageSentinelProps = {
  wsUrl: string;
  token: string;
  sessionKey: string;
};

async function fetchStatus(): Promise<SentinelStatusPayload | null> {
  const res = await fetch("/api/sentinel/status", { method: "GET" });
  if (!res.ok) return null;
  return (await res.json()) as SentinelStatusPayload;
}

export function StageSentinel(props: StageSentinelProps) {
  const [status, setStatus] = useState<SentinelStatusPayload | null>(null);
  const [controlMissing, setControlMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localHint, setLocalHint] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await fetchStatus();
      if (!s) {
        setControlMissing(true);
        setStatus(null);
        return;
      }
      setControlMissing(false);
      setStatus(s);
    } catch {
      setControlMissing(true);
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    pollRef.current = window.setInterval(() => void refresh(), 2000);
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
    };
  }, [refresh]);

  const onStart = useCallback(async () => {
    const ws = props.wsUrl.trim();
    const tok = props.token.trim();
    const key = props.sessionKey.trim() || "agent:main";
    if (!ws || !tok) {
      setLocalHint("WebSocket URL과 토큰을 먼저 입력하세요.");
      return;
    }
    setBusy(true);
    setLocalHint(null);
    try {
      const res = await fetch("/api/sentinel/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wsUrl: ws, token: tok, sessionKey: key }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok) {
        setLocalHint(j.message ?? `시작 실패 (${res.status})`);
      } else {
        setLocalHint("Sentinel ingest를 시작했습니다.");
      }
      await refresh();
    } catch (e) {
      setLocalHint(e instanceof Error ? e.message : "요청 실패");
    } finally {
      setBusy(false);
    }
  }, [props.sessionKey, props.token, props.wsUrl, refresh]);

  const onStop = useCallback(async () => {
    setBusy(true);
    setLocalHint(null);
    try {
      const res = await fetch("/api/sentinel/stop", { method: "POST" });
      if (!res.ok) setLocalHint(`중지 요청 실패 (${res.status})`);
      else setLocalHint("Sentinel ingest를 중지했습니다.");
      await refresh();
    } catch (e) {
      setLocalHint(e instanceof Error ? e.message : "요청 실패");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    if (!localHint) return;
    const t = window.setTimeout(() => setLocalHint(null), 5000);
    return () => window.clearTimeout(t);
  }, [localHint]);

  const fmtTime = (ms: number | null | undefined) => {
    if (ms == null) return "—";
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return "—";
    }
  };

  const fmtBytes = (n: number | null | undefined) => {
    if (n == null) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="panel sentinel-panel">
      <h2>Sentinel 수집 (ingest)</h2>
      {controlMissing ? (
        <p className="muted">
          이 제어 API는 <strong>Vite 개발 서버</strong>(<code>npm run dev</code> / <code>run-viz.sh</code>)에서만
          제공됩니다. <code>vite preview</code>나 정적 배포에서는 토글을 쓸 수 없습니다. 대신 터미널에서{" "}
          <code>scripts/sentinel/ingest.py</code>를 실행하세요.
        </p>
      ) : (
        <>
          <p className="muted">
            게이트웨이 이벤트를 <code>scripts/sentinel/data/trace.jsonl</code>에 씁니다. 위 연결 정보와 동일한 URL·토큰·세션
            키로 프로세스를 띄웁니다.
          </p>
          <div className="sentinel-status-grid">
            <div>
              <span className="sentinel-label">프로세스</span>
              <span className={`sentinel-pill ${status?.running ? "ok" : "warn"}`}>
                {status?.running ? `실행 중${status.pid ? ` (pid ${status.pid})` : ""}` : "중지됨"}
              </span>
            </div>
            <div>
              <span className="sentinel-label">가동 시간</span>
              <span className="sentinel-value">
                {status?.running && status.uptimeMs != null
                  ? `${Math.floor(status.uptimeMs / 1000)}초`
                  : "—"}
              </span>
            </div>
            <div>
              <span className="sentinel-label">trace.jsonl</span>
              <span className="sentinel-value">
                {status?.trace.exists
                  ? `${fmtBytes(status.trace.bytes)} · 갱신 ${fmtTime(status.trace.mtimeMs)}`
                  : "파일 없음 (시작 후 생성)"}
              </span>
            </div>
            {status?.lastExitCode != null && !status.running ? (
              <div className="sentinel-span-3">
                <span className="sentinel-label">마지막 종료 코드</span>
                <span className={status.lastExitCode === 0 ? "sentinel-value" : "sentinel-err"}>
                  {status.lastExitCode}
                </span>
              </div>
            ) : null}
            {status?.spawnError ? (
              <div className="sentinel-span-3">
                <span className="sentinel-label">시작 오류</span>
                <span className="sentinel-err">{status.spawnError}</span>
              </div>
            ) : null}
          </div>

          <div className="row sentinel-actions" style={{ marginTop: 10 }}>
            <button type="button" className="primary" disabled={busy || status?.running} onClick={onStart}>
              Sentinel 시작
            </button>
            <button type="button" disabled={busy || !status?.running} onClick={onStop}>
              Sentinel 중지
            </button>
            <button type="button" disabled={busy} onClick={() => void refresh()}>
              상태 새로고침
            </button>
          </div>

          {status?.stderrTail?.trim() ? (
            <details className="sentinel-logs">
              <summary>프로세스 로그 (끝부분)</summary>
              <pre className="sentinel-pre">{status.stderrTail}</pre>
            </details>
          ) : null}

          {localHint ? <p className="scenario-hint">{localHint}</p> : null}
        </>
      )}
    </div>
  );
}
