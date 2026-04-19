import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sendScenarioChatOnce } from "../gateway/scenarioSend";
import { SCENARIO_REGISTRY, scenarioById } from "../scenarioRegistry";

export type StageScenarioProps = {
  wsUrl: string;
  token: string;
  sessionKey: string;
};

function escapeForDoubleQuotedShell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
}

function buildSendScript(props: {
  wsUrl: string;
  token: string;
  sessionKey: string;
  scenarioId: string;
  message: string;
}): string {
  const w = escapeForDoubleQuotedShell(props.wsUrl.trim());
  const t = escapeForDoubleQuotedShell(props.token.trim());
  const k = escapeForDoubleQuotedShell(props.sessionKey.trim());
  const m = escapeForDoubleQuotedShell(props.message);
  return [
    "# 터미널에서 SG 리포지토리 루트로 이동한 뒤 붙여 넣으세요. chat.send에 operator.write 스코프가 필요합니다.",
    `export OPENCLAW_GATEWAY_WS_URL="${w}"`,
    `export OPENCLAW_GATEWAY_TOKEN="${t}"`,
    `export OPENCLAW_GATEWAY_SESSION_KEY="${k}"`,
    `export OPENCLAW_GATEWAY_SCOPES="operator.write,operator.read"`,
    `export OPENCLAW_SCENARIO_MESSAGE="${m}"`,
    `PYTHONPATH=scripts python3 scripts/runner/send_scenario.py --scenario ${props.scenarioId}`,
  ].join("\n");
}

export function StageScenario(props: StageScenarioProps) {
  const [scenarioId, setScenarioId] = useState("S1");
  const [message, setMessage] = useState(() => scenarioById("S1")?.defaultMessage ?? "");
  const [hint, setHint] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!hint) return;
    const id = window.setTimeout(() => setHint(null), 6500);
    return () => window.clearTimeout(id);
  }, [hint]);

  const selected = useMemo(() => scenarioById(scenarioId), [scenarioId]);

  const onPickScenario = useCallback((id: string) => {
    setScenarioId(id);
    const s = scenarioById(id);
    if (s) setMessage(s.defaultMessage);
  }, []);

  const copyScript = useCallback(async () => {
    const ws = props.wsUrl.trim();
    const tok = props.token.trim();
    const key = props.sessionKey.trim();
    if (!ws || !tok || !key) {
      setHint("위 패널에서 WebSocket URL·토큰·세션 키를 먼저 채워 주세요.");
      return;
    }
    if (selected?.status !== "active") {
      setHint("이 시나리오는 아직 planned 입니다. 메시지만 참고용으로 복사할 수 있습니다.");
    }
    const script = buildSendScript({
      wsUrl: ws,
      token: tok,
      sessionKey: key,
      scenarioId,
      message: message.trim() || selected?.defaultMessage || "",
    });
    try {
      await navigator.clipboard.writeText(script);
      setHint(
        "클립보드에 전송 스크립트를 복사했습니다. 터미널에서 SG 리포지토리 루트로 이동한 뒤 붙여 넣어 실행하세요.",
      );
    } catch {
      setHint("클립보드 복사에 실패했습니다. 브라우저 권한을 확인해 주세요.");
    }
  }, [message, props.sessionKey, props.token, props.wsUrl, scenarioId, selected?.defaultMessage, selected?.status]);

  const copyMessageOnly = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message);
      setHint("시나리오 메시지 본문만 복사했습니다.");
    } catch {
      setHint("클립보드 복사에 실패했습니다.");
    }
  }, [message]);

  const onResetMessage = useCallback(() => {
    if (selected) setMessage(selected.defaultMessage);
  }, [selected]);

  const onSendNow = useCallback(async () => {
    const ws = props.wsUrl.trim();
    const tok = props.token.trim();
    const key = props.sessionKey.trim();
    const body = (message.trim() || selected?.defaultMessage || "").trim();
    if (!ws || !tok || !key || !body) {
      setHint("WebSocket URL·토큰·세션 키·메시지를 확인해 주세요.");
      return;
    }
    if (sending) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setSending(true);
    setHint("chat.send 전송 중… (별도 연결, operator.write)");
    try {
      const res = await sendScenarioChatOnce({
        wsUrl: ws,
        token: tok,
        sessionKey: key,
        message: body,
        signal: ac.signal,
      });
      if (res.ok) {
        setHint("전송 완료. 위에서 같은 세션으로 연결되어 있으면 채팅에 곧 반영됩니다.");
      } else {
        setHint(res.message);
      }
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [message, props.sessionKey, props.token, props.wsUrl, selected?.defaultMessage, sending]);

  return (
    <div className="panel scenario-panel">
      <h2>시나리오 테스트</h2>
      <p className="muted">
        <strong>지금 전송</strong>은 메인 Viz 연결과 별도의 짧은 WebSocket으로 <code>operator.write</code> 연결 후{" "}
        <code>chat.send</code> 한 번만 보냅니다. 토큰에 쓰기 스코프가 없으면 실패합니다. 터미널을 쓰려면 아래{" "}
        <strong>전송 스크립트 복사</strong>를 사용하세요.
      </p>

      <div className="row" style={{ marginTop: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="scen">시나리오</label>
          <select
            id="scen"
            value={scenarioId}
            onChange={(e) => onPickScenario(e.target.value)}
          >
            {SCENARIO_REGISTRY.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} — {s.title} ({s.status})
              </option>
            ))}
          </select>
        </div>
        {selected ? (
          <div className="field scenario-meta" style={{ flex: 2 }}>
            <label>문서</label>
            <span className="muted scenario-doc">{selected.docPath}</span>
          </div>
        ) : null}
      </div>

      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="scen-msg">주입할 메시지 (chat.send)</label>
        <textarea
          id="scen-msg"
          className="scenario-textarea"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          spellCheck={false}
          disabled={!selected}
        />
      </div>

      <div className="row scenario-actions" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="primary"
          onClick={onSendNow}
          disabled={
            sending ||
            !props.wsUrl.trim() ||
            !props.token.trim() ||
            !props.sessionKey.trim() ||
            !(message.trim() || selected?.defaultMessage || "").trim()
          }
        >
          {sending ? "전송 중…" : "지금 전송 (chat.send)"}
        </button>
        <button type="button" onClick={copyScript} disabled={!props.wsUrl.trim() || !props.token.trim() || !props.sessionKey.trim()}>
          전송 스크립트 복사
        </button>
        <button type="button" onClick={copyMessageOnly}>
          메시지만 복사
        </button>
        <button type="button" onClick={onResetMessage} disabled={!selected}>
          기본 문구로 되돌리기
        </button>
      </div>
      {selected?.status === "planned" ? (
        <p className="scenario-warn">
          이 ID는 catalog 상 <strong>planned</strong>입니다. 스크립트는 실행되지만 시나리오 SSOT 문서는 아직 없을 수 있습니다.
        </p>
      ) : null}
      {hint ? <p className="scenario-hint">{hint}</p> : null}
    </div>
  );
}
