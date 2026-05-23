import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { publicAsset } from "../lib/publicAsset";
import { sendScenarioThroughDevServer } from "../gateway/scenarioSend";
import { type GwFrame } from "../gateway/protocol";
import { apiPath } from "../lib/publicAsset";
import type { ConnState } from "../gateway/useGatewayReadonly";
import type { TimelineEntry } from "../gateway/normalizeEvent";
import type { NavAction } from "../App";
import { useFindings, type SentinelFinding } from "../sentinel/useFindings";
import { type ToolLine, SKIP_TEXT_RE, buildChatTurns } from "./messageToolFlowData";

type MessageToolFlowProps = {
  entries: TimelineEntry[];
  connState: ConnState;
  wsUrl: string;
  token: string;
  sessionKey: string;
  /** Python dev server 스트리밍으로 받은 GwFrame을 타임라인에 주입한다. */
  injectFrame?: (frame: GwFrame) => void;
  /** 채팅 탭에서 전송이 성공했을 때(시나리오 S1 전용 배지 맥락 해제 등) */
  onChatSent?: () => void;
  /** 탭/모니터링 네비게이션 콜백 */
  onNavigate?: (action: NavAction) => void;
  /** connect()가 호출된 시각(ms). 이 시점 이전 이벤트는 히스토리 재전송분으로 숨긴다. */
  connectedAt?: number | null;
  /** 바뀌면 누적된 findings 상태를 초기화 (Connect 재연결 등) */
  clearKey?: number;
};

function blockedCategory(ruleId: string): string {
  const id = ruleId.toLowerCase();
  if (id === "whitelist-violation" || id.includes("plugin") || id.includes("supply")) return "악성 플러그인 탐지";
  if (id === "md-signature-block" || id.includes("injection") || id.includes("readme") || id.includes("md-") || id.includes("vigil") || id.includes("prompt")) return "악성 MD 탐지";
  if (id.includes("rate") || id.includes("abuse") || id.includes("loop") || id.includes("exhaustion")) return "API Abuse 탐지";
  return "보안 위협 탐지";
}

function BlockedBubble({ finding, onNavigate }: { finding: SentinelFinding; onNavigate?: (a: NavAction) => void }) {
  const catLabel = blockedCategory(finding.ruleId);
  return (
    <div className="chat-blocked-notif">
      <div className="chat-blocked-icon">🚫</div>
      <div className="chat-blocked-body">
        <div className="chat-blocked-header">
          <span className="chat-blocked-title">보안 위협 탐지 및 차단됨</span>
          <span className="chat-blocked-cat">{catLabel}</span>
        </div>
        <div className="chat-blocked-msg">{finding.title}</div>
        {onNavigate && (
          <button
            type="button"
            className="chat-blocked-btn"
            onClick={() => onNavigate({ tab: "monitoring", highlightFindingId: finding.id })}
          >
            Monitoring 탭에서 확인 →
          </button>
        )}
      </div>
    </div>
  );
}



export function MessageToolFlow(props: MessageToolFlowProps) {
  const [openToolId, setOpenToolId] = useState<string | null>(null);
  const liveEntries = useMemo(() => {
    const threshold = props.connectedAt != null ? props.connectedAt - 10_000 : null;
    if (threshold == null) return props.entries;
    return props.entries.filter((e) => e.at >= threshold);
  }, [props.entries, props.connectedAt]);

  const { turns, orphanTools, orphanAssistantChunks } = useMemo(
    () => buildChatTurns(liveEntries),
    [liveEntries],
  );

  // ── Sentinel 실시간 findings → BlockedBubble ──────────────────────────────
  const { findings } = useFindings({ pollMs: 600, useSse: false, clearKey: props.clearKey });
  const seenFindingIdsRef = useRef<Set<string>>(new Set());
  const [blockedNotifs, setBlockedNotifs] = useState<SentinelFinding[]>([]);
  const clearKeyTimeRef = useRef<number>(Date.now());

  useEffect(() => {
    setBlockedNotifs([]);
    seenFindingIdsRef.current = new Set();
    clearKeyTimeRef.current = Date.now();
  }, [props.clearKey]);

  useEffect(() => {
    // 첫 유저 턴 이후 findings만 표시 — ingest 시작 시 생성된 배치 findings 제외
    const firstTurnAt = turns.length > 0 ? turns[0].at : null;
    if (!firstTurnAt) return; // 유저 메시지가 없으면 표시 안 함
    const threshold = Math.max(
      clearKeyTimeRef.current,
      props.connectedAt ?? 0,
      firstTurnAt,
    );
    // ruleId 기준 중복 제거 (같은 규칙이 배치+실시간 두 번 생성되는 경우)
    const seenRuleIds = new Set(
      [...seenFindingIdsRef.current].map((id) => {
        const f = findings.find((x) => x.id === id);
        return f?.ruleId ?? id;
      }),
    );
    const newOnes = findings.filter((f) => {
      if (!f._rt) return false; // 배치 findings 제외, realtime만 BlockedBubble에 표시
      if (seenFindingIdsRef.current.has(f.id)) return false;
      if (seenRuleIds.has(f.ruleId)) return false;
      if (!f.timestamp) return false;
      if (new Date(f.timestamp).getTime() < threshold) return false;
      return true;
    });
    if (newOnes.length === 0) return;
    newOnes.forEach((f) => {
      seenFindingIdsRef.current.add(f.id);
      seenRuleIds.add(f.ruleId);
    });
    setBlockedNotifs((prev) => [...prev, ...newOnes]);
  }, [findings, props.connectedAt, turns]);

  // 차단 finding이 발생한 "그 턴"의 assistant 응답만 숨김 (이후 정상 턴까지 숨겨지지 않도록 턴 윈도우로 한정)
  const blockedTurnIds = useMemo(() => {
    const result = new Set<string>();
    if (blockedNotifs.length === 0) return result;
    const blockTimes = blockedNotifs
      .map((f) => (f.timestamp ? new Date(f.timestamp).getTime() : null))
      .filter((t): t is number => t !== null);
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const windowEnd = i + 1 < turns.length ? turns[i + 1].at : Infinity;
      if (blockTimes.some((bt) => bt >= t.at && bt < windowEnd)) {
        result.add(t.id);
      }
    }
    return result;
  }, [turns, blockedNotifs]);

  // turns + blockedNotifs를 시각순으로 병합, finding 이후 assistant 답변 숨김
  const chatItems = useMemo(() => {
    type TurnItem = { kind: "turn"; at: number; turn: (typeof turns)[number] };
    type FindingItem = { kind: "finding"; at: number; finding: SentinelFinding };
    const items: (TurnItem | FindingItem)[] = [
      ...turns.map((t) => ({ kind: "turn" as const, at: t.at, turn: t })),
      ...blockedNotifs
        .filter((f) => f.timestamp)
        .map((f) => ({ kind: "finding" as const, at: new Date(f.timestamp!).getTime(), finding: f })),
    ];
    items.sort((a, b) => a.at - b.at);
    return items;
  }, [turns, blockedNotifs]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  // 사용자가 위로 스크롤하면 자동 스크롤 잠시 중단
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      userScrolledUp.current = !atBottom;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 새 메시지/이벤트가 오면 바닥으로 스크롤
  useEffect(() => {
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [turns, orphanAssistantChunks]);

  if (props.connState !== "ready") {
    return (
      <section className="chat-room chat-room-empty">
        <div className="chat-empty-state">
          <img src={publicAsset("photo/claw.png")} alt="openclaw" className="chat-empty-illust" />
          <h3 className="chat-empty-title">Gateway Not Connected</h3>
          <p className="chat-empty-desc">
            왼쪽 패널에서 WebSocket URL과 토큰을 입력한 뒤<br />
            <strong>Connect</strong>를 눌러 OpenClaw Gateway에 연결하세요.
          </p>
          <div className="chat-empty-steps">
            <div className="chat-empty-step"><span className="chat-empty-step-num">1</span>WebSocket URL 입력</div>
            <div className="chat-empty-step-arrow">→</div>
            <div className="chat-empty-step"><span className="chat-empty-step-num">2</span>세션 키 · 토큰 입력</div>
            <div className="chat-empty-step-arrow">→</div>
            <div className="chat-empty-step"><span className="chat-empty-step-num">3</span>Connect 클릭</div>
          </div>
        </div>
      </section>
    );
  }

  const empty =
    turns.length === 0 && orphanTools.length === 0 && orphanAssistantChunks.length === 0;

  return (
    <section className="chat-room">
      <div className="chat-room-title">
        채팅
      </div>
      <div className="chat-room-scroll" ref={scrollRef}>
        {empty ? (
          <div className="chat-empty-state chat-empty-state-inline">
            <img
              src={publicAsset("photo/chitoclaw4.png")}
              alt="chito and openclaw"
              className="chat-empty-illust chat-empty-illust--xl"
            />
            <h3 className="chat-empty-title">No session activity yet</h3>
            <p className="chat-empty-desc">
              테스트 프롬프트를 입력하면 Agent 응답과<br />보안 이벤트가 이곳에 실시간으로 표시됩니다.
            </p>
            <ul className="chat-empty-list">
              <li><span className="chat-empty-badge badge-blue">Agent</span>Agent Message &amp; Response</li>
              <li><span className="chat-empty-badge badge-purple">Tool</span>Tool Invocation</li>
              <li><span className="chat-empty-badge badge-orange">Policy</span>Policy Violation</li>
              <li><span className="chat-empty-badge badge-red">Alert</span>Sentinel Alert</li>
            </ul>
          </div>
        ) : null}

        {orphanAssistantChunks.length > 0 ? (
          <div className="chat-orphan">
            <div className="chat-orphan-label">사용자 메시지 이전 답변</div>
            <div className="chat-row-assistant">
              <div className="chat-bubble-assistant chat-bubble-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {orphanAssistantChunks.join("\n\n")}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        ) : null}

        {orphanTools.length > 0 ? (
          <div className="chat-orphan">
            <div className="chat-orphan-label">사용자 메시지 이전에 수집된 도구</div>
            <ToolList
              tools={orphanTools}
              align="left"
              openToolId={openToolId}
              setOpenToolId={setOpenToolId}
            />
          </div>
        ) : null}

        {chatItems.map((item) => {
          if (item.kind === "finding") {
            return (
              <BlockedBubble
                key={`finding-${item.finding.id}`}
                finding={item.finding}
                onNavigate={props.onNavigate}
              />
            );
          }
          const turn = item.turn;
          // 차단이 이 턴 안에서 발생한 경우에만 응답 숨김 (이후 정상 턴은 그대로 표시)
          const suppressAssistant = blockedTurnIds.has(turn.id) && turn.assistantChunks.length > 0;
          return (
            <div key={turn.id} className="chat-turn">
              <time className="chat-time" dateTime={new Date(turn.at).toISOString()}>
                {new Date(turn.at).toLocaleTimeString()}
              </time>
              <div className="chat-row-user">
                <div className="chat-user-stack">
                  {turn.userMeta ? <div className="chat-user-meta">{turn.userMeta}</div> : null}
                  <div className="chat-bubble-user">{turn.userText}</div>
                </div>
              </div>
              <div className="chat-tools-block">
                {turn.tools.length > 0 ? (
                  <>
                    <div className="chat-tools-caption">이 메시지 이후 호출된 도구</div>
                    <ToolList
                      tools={turn.tools}
                      align="right"
                      openToolId={openToolId}
                      setOpenToolId={setOpenToolId}
                    />
                  </>
                ) : (
                  <div className="chat-tools-none">연결된 도구 호출 기록 없음</div>
                )}
              </div>
              {turn.assistantChunks.length > 0 && !suppressAssistant ? (
                <div className="chat-row-assistant chat-row-assistant-after-tools">
                  <img
                    src={publicAsset("photo/sgclaw2.png")}
                    alt="sgclaw"
                    className="chat-msg-avatar chat-msg-avatar--plain chat-msg-avatar--md"
                  />
                  <div className="chat-bubble-assistant chat-bubble-md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {turn.assistantChunks.join("\n\n")}
                    </ReactMarkdown>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <ChatInput
        wsUrl={props.wsUrl}
        token={props.token}
        sessionKey={props.sessionKey}
        injectFrame={props.injectFrame}
      />
    </section>
  );
}

function ChatInput(props: { wsUrl: string; token: string; sessionKey: string; injectFrame?: (frame: GwFrame) => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(() => setHint(null), 5000);
    return () => window.clearTimeout(t);
  }, [hint]);

  const sendViaGateway = useCallback(async (msg: string) => {
    if (props.injectFrame) {
      // Dev server가 Python(device 서명)으로 구독+전송 후 이벤트를 스트리밍해줌
      setText("");
      inputRef.current?.focus();
      try {
        const res = await fetch(apiPath("/api/scenario/chat-stream"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wsUrl: props.wsUrl,
            token: props.token,
            sessionKey: props.sessionKey,
            message: msg,
          }),
        });
        if (!res.ok || !res.body) {
          const j = await res.json().catch(() => ({})) as { message?: string };
          setHint(j.message ?? `HTTP ${res.status}`);
          return;
        }
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
              const frame = JSON.parse(trimmed) as { type?: string; event?: string };
              if (frame.type === "event") props.injectFrame!(frame as import("../gateway/protocol").GwFrame);
            } catch { /* ignore parse errors */ }
          }
        }
      } catch (e) {
        setHint(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    const res = await sendScenarioThroughDevServer({
      wsUrl: props.wsUrl,
      token: props.token,
      sessionKey: props.sessionKey,
      message: msg,
      scenarioId: "chat",
    });
    const isNoReply = !res.ok && res.message != null && SKIP_TEXT_RE.test(res.message.trim());
    if (res.ok || isNoReply) {
      setText("");
      inputRef.current?.focus();
    } else {
      setHint(res.message);
    }
  }, [props.wsUrl, props.token, props.sessionKey, props.injectFrame]);

  const send = useCallback(async () => {
    const msg = text.trim();
    if (!msg || sending) return;
    setSending(true);
    setHint(null);
    try {
      await sendViaGateway(msg);
    } finally {
      setSending(false);
    }
  }, [text, sending, sendViaGateway]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글/일본어 등 IME 조합 중 Enter는 조합 확정용이므로 전송하지 않음
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="chat-input-bar">

      {hint ? <p className="chat-input-hint">{hint}</p> : null}
      <div className="chat-input-row">
        <textarea
          ref={inputRef}
          className="chat-input-textarea"
          placeholder="메시지 입력 (Shift+Enter 줄바꿈, Enter 전송)"
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="chat-input-send"
          disabled={sending || !text.trim()}
          onClick={() => void send()}
        >
          {sending ? "⏳" : "전송"}
        </button>
      </div>
    </div>
  );
}

function ToolList(props: {
  tools: ToolLine[];
  align: "left" | "right";
  openToolId: string | null;
  setOpenToolId: (id: string | null) => void;
}) {
  const cls = props.align === "right" ? "chat-tool-list chat-tool-list-right" : "chat-tool-list";
  return (
    <ul className={cls}>
      {props.tools.map((t) => {
        const open = props.openToolId === t.id;
        const expandable = Boolean(t.argsFull?.trim() || t.outputFull?.trim());
        return (
          <li key={t.id} className="chat-tool-item">
            <button
              type="button"
              className={`chat-tool-pill ${open ? "chat-tool-pill-open" : ""}`}
              onClick={() => props.setOpenToolId(open ? null : t.id)}
              disabled={!expandable}
            >
              <span className="chat-tool-pill-main">
                <span className="chat-tool-pill-name">{t.name}</span>
                {t.meta ? <span className="chat-tool-pill-meta"> · {t.meta}</span> : null}
              </span>
              {expandable ? (
                <span className="chat-tool-pill-chev" aria-hidden>
                  {open ? "▲" : "▼"}
                </span>
              ) : null}
            </button>
            {open && expandable ? (
              <div className="chat-tool-detail">
                {t.argsFull?.trim() ? (
                  <div className="chat-tool-detail-block">
                    <div className="chat-tool-detail-label">입력 / 인자</div>
                    <pre className="chat-tool-args">{t.argsFull}</pre>
                  </div>
                ) : null}
                {t.outputFull?.trim() ? (
                  <div className="chat-tool-detail-block">
                    <div className="chat-tool-detail-label">출력 (Tool output)</div>
                    <pre className="chat-tool-args chat-tool-args-output">{t.outputFull}</pre>
                  </div>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
