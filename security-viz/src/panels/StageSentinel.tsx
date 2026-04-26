import { useCallback, useEffect, useRef, useState, useId } from "react";
import { apiPath, publicAsset } from "../lib/publicAsset";
import type { ConnState } from "../gateway/useGatewayReadonly";

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
  connState: ConnState;
};

async function fetchStatus(): Promise<SentinelStatusPayload | null> {
  const res = await fetch(apiPath("/api/sentinel/status"), { method: "GET" });
  if (!res.ok) return null;
  return (await res.json()) as SentinelStatusPayload;
}

export function StageSentinel(props: StageSentinelProps) {
  const [status, setStatus] = useState<SentinelStatusPayload | null>(null);
  const [controlMissing, setControlMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localHint, setLocalHint] = useState<string | null>(null);
  const [abortOpen, setAbortOpen] = useState(false);
  const [abortBusy, setAbortBusy] = useState(false);
  const dialogId = useId();
  const pollRef = useRef<number | null>(null);
  const autoStartedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = await fetchStatus();
      if (!s) { setControlMissing(true); setStatus(null); return; }
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
    return () => { if (pollRef.current != null) window.clearInterval(pollRef.current); };
  }, [refresh]);

  const onStart = useCallback(async (silent = false) => {
    const ws = props.wsUrl.trim();
    const tok = props.token.trim();
    const key = props.sessionKey.trim() || "agent:main";
    if (!ws || !tok) {
      if (!silent) setLocalHint("WebSocket URL과 토큰을 먼저 입력하세요.");
      return;
    }
    setBusy(true);
    if (!silent) setLocalHint(null);
    try {
      const res = await fetch(apiPath("/api/sentinel/start"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wsUrl: ws, token: tok, sessionKey: key }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok && !silent) setLocalHint(j.message ?? `시작 실패 (${res.status})`);
      await refresh();
    } catch (e) {
      if (!silent) setLocalHint(e instanceof Error ? e.message : "요청 실패");
    } finally {
      setBusy(false);
    }
  }, [props.sessionKey, props.token, props.wsUrl, refresh]);

  const onStop = useCallback(async () => {
    setBusy(true);
    setLocalHint(null);
    try {
      const res = await fetch(apiPath("/api/sentinel/stop"), { method: "POST" });
      if (!res.ok) setLocalHint(`중지 요청 실패 (${res.status})`);
      else setLocalHint("Sentinel ingest를 중지했습니다.");
      await refresh();
    } catch (e) {
      setLocalHint(e instanceof Error ? e.message : "요청 실패");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  // gateway 연결되면 자동 시작
  useEffect(() => {
    if (props.connState !== "ready") {
      autoStartedRef.current = false;
      return;
    }
    if (autoStartedRef.current) return;
    if (controlMissing) return;
    if (status === null) return; // 상태 로드 대기
    if (status.running) { autoStartedRef.current = true; return; }
    autoStartedRef.current = true;
    void onStart(true);
  }, [props.connState, status, controlMissing, onStart]);

  const onAbortConfirm = useCallback(async () => {
    const ws = props.wsUrl.trim();
    const tok = props.token.trim();
    const key = props.sessionKey.trim();
    if (!ws || !tok || !key) {
      setLocalHint("sessions.abort에는 WebSocket URL, 토큰, 세션 키가 모두 필요합니다.");
      setAbortOpen(false);
      return;
    }
    setAbortBusy(true);
    try {
      const res = await fetch(apiPath("/api/sentinel/abort"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wsUrl: ws, token: tok, sessionKey: key }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      setLocalHint(
        j.ok
          ? `sessions.abort 전송 완료 (세션: ${key})`
          : `sessions.abort 실패: ${j.message ?? res.status}`,
      );
    } catch (e) {
      setLocalHint(e instanceof Error ? e.message : "abort 요청 실패");
    } finally {
      setAbortBusy(false);
      setAbortOpen(false);
    }
  }, [props.sessionKey, props.token, props.wsUrl]);

  useEffect(() => {
    if (!localHint) return;
    const t = window.setTimeout(() => setLocalHint(null), 5000);
    return () => window.clearTimeout(t);
  }, [localHint]);

  const fmtUptime = (ms: number | null | undefined) =>
    ms == null ? "—" : `${Math.floor(ms / 1000)}초`;

  return (
    <div className="panel sentinel-panel">
      <div className="sentinel-header">
        <h2>Sentinel 수집</h2>
        {status?.running ? (
          <img src={publicAsset("chitoclaw1.png")} alt="sentinel active" className="sentinel-chito" />
        ) : null}
      </div>
      {controlMissing ? (
        <p className="muted">개발 서버(<code>run-viz.sh</code>)에서만 제어 가능합니다.</p>
      ) : (
        <>
          <div className="sentinel-status-grid">
            <div>
              <span className="sentinel-label">프로세스</span>
              <span className={`sentinel-pill ${status?.running ? "ok" : "warn"}`}>
                {status?.running ? "실행 중" : "중지됨"}
              </span>
              {status?.running && status.pid ? (
                <div className="muted" style={{ marginTop: 3, fontSize: "0.72rem" }}>pid {status.pid}</div>
              ) : null}
            </div>
            <div>
              <span className="sentinel-label">가동 시간</span>
              <span className="sentinel-value">{fmtUptime(status?.uptimeMs)}</span>
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
            {!status?.running && (
              <button type="button" className="primary" disabled={busy} onClick={() => void onStart(false)}>
                수동 시작
              </button>
            )}
            <button type="button" disabled={busy || !status?.running} onClick={() => void onStop()}>
              Sentinel 중지
            </button>
            <button
              type="button"
              className="abort-btn"
              disabled={abortBusy}
              onClick={() => setAbortOpen(true)}
              title="sessions.abort — 에이전트 세션을 즉시 중단합니다"
            >
              세션 중단
            </button>
          </div>

          {abortOpen && (
            <dialog
              open
              aria-labelledby={dialogId}
              className="abort-dialog"
              onKeyDown={(e) => { if (e.key === "Escape") setAbortOpen(false); }}
            >
              <h3 id={dialogId}>sessions.abort 실행 확인</h3>
              <p>
                <strong>sessions.abort</strong>를 전송하면 OpenClaw 에이전트 세션이 즉시 중단됩니다.
                진행 중인 작업은 취소되고 복구되지 않을 수 있습니다.
              </p>
              <p className="muted" style={{ fontSize: "0.82rem" }}>
                세션 키: <code>{props.sessionKey || "—"}</code>
              </p>
              <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
                <button type="button" disabled={abortBusy} onClick={() => setAbortOpen(false)}>
                  취소
                </button>
                <button
                  type="button"
                  className="abort-btn"
                  disabled={abortBusy}
                  onClick={() => void onAbortConfirm()}
                >
                  {abortBusy ? "전송 중…" : "sessions.abort 실행"}
                </button>
              </div>
            </dialog>
          )}

          {status?.stderrTail?.trim() ? (
            <details className="sentinel-logs">
              <summary>프로세스 로그</summary>
              <pre className="sentinel-pre">{status.stderrTail}</pre>
            </details>
          ) : null}

          {localHint ? <p className="scenario-hint">{localHint}</p> : null}
        </>
      )}
    </div>
  );
}
