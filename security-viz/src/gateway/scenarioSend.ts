import { buildConnectReq, newReqId, parseGwFrame, type GwFrame } from "./protocol";

/** `send_scenario.py`와 동일한 게이트웨이 클라이언트 표시 */
const SCENARIO_CLIENT_ID = "cli";
const SCENARIO_CLIENT_MODE = "cli";

const DEFAULT_CHAT_METHOD = import.meta.env.VITE_SG_CHAT_METHOD?.trim() || "chat.send";

function isHelloOk(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && (payload as { type?: string }).type === "hello-ok");
}

function buildChatSendParams(sessionKey: string, message: string): Record<string, unknown> {
  return {
    key: sessionKey,
    sessionKey,
    message,
    text: message,
    idempotencyKey: newReqId(),
  };
}

export type ScenarioSendResult =
  | { ok: true; payload: unknown }
  | { ok: false; message: string };

/**
 * 읽기 전용 메인 연결과 분리된 **짧은** WebSocket으로 connect(+write) 후 chat.send 한 번만 호출하고 닫습니다.
 */
export function sendScenarioChatOnce(opts: {
  wsUrl: string;
  token: string;
  sessionKey: string;
  message: string;
  chatMethod?: string;
  signal?: AbortSignal;
}): Promise<ScenarioSendResult> {
  const wsUrl = opts.wsUrl.trim();
  const token = opts.token.trim();
  const sessionKey = opts.sessionKey.trim();
  const message = opts.message.trim();
  const chatMethod = (opts.chatMethod?.trim() || DEFAULT_CHAT_METHOD).trim();

  if (!wsUrl || !token || !sessionKey || !message) {
    return Promise.resolve({
      ok: false,
      message: "WebSocket URL, token, session key, message를 모두 채워 주세요.",
    });
  }

  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (e) {
      resolve({ ok: false, message: e instanceof Error ? e.message : "WebSocket URL이 잘못되었습니다." });
      return;
    }

    const pending = new Map<string, (frame: GwFrame) => void>();
    let connectSent = false;
    let connectReqId: string | null = null;
    let chatSent = false;
    let done = false;
    let challengeTimer: number | null = null;

    const finish = (r: ScenarioSendResult) => {
      if (done) return;
      done = true;
      if (challengeTimer != null) {
        window.clearTimeout(challengeTimer);
        challengeTimer = null;
      }
      pending.clear();
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    const fail = (msg: string) => finish({ ok: false, message: msg });

    const onAbort = () => fail("취소됨");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const sendRpc = (method: string, params: unknown, timeoutMs: number): Promise<unknown> =>
      new Promise((res, rej) => {
        const id = newReqId();
        const req: GwFrame = { type: "req", id, method, params };
        const timer = window.setTimeout(() => {
          pending.delete(id);
          rej(new Error(`${method} RPC 시간 초과`));
        }, timeoutMs);
        pending.set(id, (frame) => {
          window.clearTimeout(timer);
          if (frame.type !== "res") {
            rej(new Error("잘못된 응답 프레임"));
            return;
          }
          if (!frame.ok) {
            rej(new Error(frame.error?.message ?? frame.error?.code ?? `${method} RPC 오류`));
            return;
          }
          res(frame.payload);
        });
        socket.send(JSON.stringify(req));
      });

    const runChatAfterHello = async () => {
      if (chatSent) return;
      chatSent = true;
      try {
        const payload = await sendRpc(chatMethod, buildChatSendParams(sessionKey, message), 120_000);
        finish({ ok: true, payload });
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    };

    socket.onerror = () => {
      if (!done) fail("WebSocket 오류(URL·TLS·CORS·토큰을 확인하세요).");
    };

    socket.onclose = () => {
      if (!done) fail("연결이 끊겼습니다.");
    };

    socket.onopen = () => {
      challengeTimer = window.setTimeout(() => {
        if (!connectSent && !done) fail("connect.challenge 수신 시간 초과");
      }, 15_000);
    };

    socket.onmessage = (ev) => {
      if (done) return;
      const frame = parseGwFrame(String(ev.data));
      if (!frame) return;

      if (frame.type === "res") {
        const cb = pending.get(frame.id);
        if (cb) {
          pending.delete(frame.id);
          cb(frame);
        }
        if (connectReqId && frame.id === connectReqId) {
          if (!frame.ok) {
            fail(frame.error?.message ?? frame.error?.code ?? "connect 실패");
            return;
          }
          if (frame.payload && isHelloOk(frame.payload)) {
            void runChatAfterHello();
          } else {
            fail("hello-ok가 아닌 connect 응답입니다.");
          }
        }
      }

      if (!connectSent && frame.type === "event" && frame.event === "connect.challenge") {
        const payload = frame.payload as { nonce?: unknown } | undefined;
        const nonce =
          payload && typeof payload === "object" && typeof payload.nonce === "string"
            ? payload.nonce.trim()
            : "";
        if (!nonce) {
          fail("connect.challenge에 nonce가 없습니다.");
          return;
        }
        if (challengeTimer != null) {
          window.clearTimeout(challengeTimer);
          challengeTimer = null;
        }
        try {
          const connectFrame = buildConnectReq({
            token,
            scopes: ["operator.write", "operator.read"],
            clientId: SCENARIO_CLIENT_ID,
            clientMode: SCENARIO_CLIENT_MODE,
          });
          connectReqId = connectFrame.id;
          connectSent = true;
          socket.send(JSON.stringify(connectFrame));
        } catch (e) {
          fail(e instanceof Error ? e.message : "connect 전송 실패");
        }
      }
    };
  });
}
