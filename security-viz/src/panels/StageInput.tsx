import type { ConnState } from "../gateway/useGatewayReadonly";

export type StageInputProps = {
  wsUrl: string;
  token: string;
  sessionKey: string;
  onChangeWsUrl: (v: string) => void;
  onChangeToken: (v: string) => void;
  onChangeSessionKey: (v: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  connState: ConnState;
  error: string | null;
};

type StatusVariant = "live" | "connecting" | "error" | "offline";

function getStatus(connState: ConnState, error: string | null): StatusVariant {
  if (connState === "ready") return "live";
  if (connState === "connecting") return "connecting";
  if (error) return "error";
  return "offline";
}

const STATUS_CONFIG = {
  live:       { dot: "cp-dot-live",       label: "Live Monitoring",  sub: "Subscribed",  card: "cp-status-card-live" },
  connecting: { dot: "cp-dot-connecting", label: "Handshaking…",     sub: "Connecting",  card: "cp-status-card-connecting" },
  error:      { dot: "cp-dot-error",      label: "Connection Error", sub: "Error",       card: "cp-status-card-error" },
  offline:    { dot: "cp-dot-offline",    label: "Offline",          sub: "Disconnected",card: "cp-status-card-offline" },
};

export function StageInput(props: StageInputProps) {
  const busy = props.connState === "connecting";
  const live = props.connState === "ready";
  const variant = getStatus(props.connState, props.error);
  const cfg = STATUS_CONFIG[variant];

  return (
    <div className="cp-panel">
      {/* 패널 헤더 */}
      <div className="cp-header">
        <span className="cp-header-title">Gateway 연결</span>
        <span className="cp-header-sub">AI Agent Monitor</span>
      </div>

      {/* 상태 카드 */}
      <div className={`cp-status-card ${cfg.card}`}>
        <div className="cp-status-top">
          <span className="cp-status-label">GATEWAY STATUS</span>
          <span className={`cp-dot ${cfg.dot}`} />
        </div>
        <div className="cp-status-main">{cfg.label}</div>
        <div className="cp-status-sub">{cfg.sub}</div>
      </div>

      {/* 구분선 + 섹션 */}
      <div className="cp-section">
        <span className="cp-section-label">Connection</span>
        <div className="field">
          <label htmlFor="ws">WebSocket URL</label>
          <input
            id="ws"
            value={props.wsUrl}
            onChange={(e) => props.onChangeWsUrl(e.target.value)}
            placeholder="ws://127.0.0.1:18789"
            autoComplete="off"
          />
          <span className="cp-field-hint">게이트웨이 서버 주소입니다. 로컬 실행 시 기본값을 사용하세요.</span>
        </div>
        <div className="field">
          <label htmlFor="sess">Session Key</label>
          <input
            id="sess"
            value={props.sessionKey}
            onChange={(e) => props.onChangeSessionKey(e.target.value)}
            placeholder="agent:main"
            autoComplete="off"
          />
          <span className="cp-field-hint">모니터링할 에이전트 세션 이름입니다.</span>
        </div>
        <div className="field">
          <label htmlFor="tok">Gateway Token</label>
          <input
            id="tok"
            type="password"
            value={props.token}
            onChange={(e) => props.onChangeToken(e.target.value)}
            placeholder="operator token"
            autoComplete="off"
          />
          <span className="cp-field-hint">게이트웨이 접근 인증 토큰입니다. 관리자로부터 발급받거나 로컬 실행의 경우 로컬의 토큰을 입력하세요.</span>
        </div>
      </div>

      {/* 액션 버튼 */}
      <div className="cp-section">
        <div className="cp-btn-row">
          <button className="cp-btn-connect" type="button" disabled={busy} onClick={props.onConnect}>
            {busy ? "Connecting…" : "Connect"}
          </button>
          <button className="cp-btn-disconnect" type="button" disabled={!live && !busy} onClick={props.onDisconnect}>
            Disconnect
          </button>
        </div>
      </div>

      {props.error && (
        <p className="cp-error">{props.error}</p>
      )}
    </div>
  );
}
