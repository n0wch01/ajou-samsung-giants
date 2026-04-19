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

export function StageInput(props: StageInputProps) {
  const busy = props.connState === "connecting";
  const live = props.connState === "ready";
  return (
    <div className="panel">
      <h2>OpenClaw gateway</h2>
      <p className="muted">
        Read-only: subscribes to <code>sessions.subscribe</code> and <code>sessions.messages.subscribe</code> for the
        session below. Does not send chat or abort sessions.
      </p>
      <div className="row" style={{ marginTop: 10 }}>
        <div className="field" style={{ flex: 2 }}>
          <label htmlFor="ws">WebSocket URL</label>
          <input
            id="ws"
            value={props.wsUrl}
            onChange={(e) => props.onChangeWsUrl(e.target.value)}
            placeholder="ws://127.0.0.1:18789"
            autoComplete="off"
          />
        </div>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <div className="field" style={{ flex: 2 }}>
          <label htmlFor="sess">Session key</label>
          <input
            id="sess"
            value={props.sessionKey}
            onChange={(e) => props.onChangeSessionKey(e.target.value)}
            placeholder="agent:main"
            autoComplete="off"
          />
        </div>
        <div className="field" style={{ flex: 2 }}>
          <label htmlFor="tok">Gateway token</label>
          <input
            id="tok"
            type="password"
            value={props.token}
            onChange={(e) => props.onChangeToken(e.target.value)}
            placeholder="operator token"
            autoComplete="off"
          />
        </div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button type="button" className="primary" disabled={busy} onClick={props.onConnect}>
          {busy ? "Connecting…" : "Connect"}
        </button>
        <button type="button" disabled={!live && !busy} onClick={props.onDisconnect}>
          Disconnect
        </button>
        <span className={`pill ${live ? "ok" : props.error ? "err" : ""}`}>
          {live ? "Subscribed" : props.connState === "connecting" ? "Handshaking" : props.error ? "Error" : "Offline"}
        </span>
      </div>
      {props.error ? <p className="muted" style={{ color: "var(--danger)" }}>{props.error}</p> : null}
    </div>
  );
}
