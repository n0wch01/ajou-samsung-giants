import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { frameToTimelineEntry, type TimelineEntry } from "./normalizeEvent";
import {
  assertReadonlyMethod,
  buildConnectReq,
  newReqId,
  parseGwFrame,
  type GwFrame,
} from "./protocol";

export type ConnState = "idle" | "connecting" | "ready" | "error";

export type UseGatewayReadonly = {
  connState: ConnState;
  error: string | null;
  lastHello: unknown;
  timeline: TimelineEntry[];
  rawFrames: GwFrame[];
  jsonlLines: string[];
  connect: (wsUrl: string, token: string, sessionKey: string) => void;
  disconnect: () => void;
  /** Read-only RPC after hello. */
  sendReadonly: (method: string, params?: unknown) => Promise<unknown>;
};

const MAX_FRAMES = 2500;

export function useGatewayReadonly(): UseGatewayReadonly {
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<string, (f: GwFrame) => void>>(new Map());
  const sessionKeyRef = useRef<string>("");
  const connectReqIdRef = useRef<string | null>(null);
  /** OpenClaw sends `connect.challenge` before `connect` is accepted. */
  const connectSentRef = useRef(false);
  const challengeTimerRef = useRef<number | null>(null);

  const [connState, setConnState] = useState<ConnState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastHello, setLastHello] = useState<unknown>(null);
  const [rawFrames, setRawFrames] = useState<GwFrame[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);

  const appendFrame = useCallback((frame: GwFrame) => {
    setRawFrames((prev) => {
      const next = [...prev, frame];
      if (next.length > MAX_FRAMES) next.splice(0, next.length - MAX_FRAMES);
      return next;
    });
    const tl = frameToTimelineEntry(frame);
    if (tl) {
      setTimeline((prev) => {
        const next = [...prev, tl];
        if (next.length > MAX_FRAMES) next.splice(0, next.length - MAX_FRAMES);
        return next;
      });
    }
  }, []);

  const pushSynthetic = useCallback((label: string, raw: unknown) => {
    const entry: TimelineEntry = {
      id: newReqId(),
      at: Date.now(),
      kind: "other",
      title: label,
      subtitle: typeof raw === "string" ? raw : undefined,
      eventName: "viz.synthetic",
      raw,
    };
    setTimeline((prev) => [...prev, entry]);
  }, []);

  const sendRaw = useCallback((frame: GwFrame) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    if (frame.type === "req") {
      assertReadonlyMethod(frame.method);
    }
    ws.send(JSON.stringify(frame));
  }, []);

  const sendReadonly = useCallback(
    (method: string, params?: unknown) => {
      assertReadonlyMethod(method);
      const id = newReqId();
      const req: GwFrame = { type: "req", id, method, params };
      return new Promise<unknown>((resolve, reject) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error("WebSocket is not open"));
          return;
        }
        const timer = window.setTimeout(() => {
          pendingRef.current.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }, 30_000);
        pendingRef.current.set(id, (resFrame) => {
          window.clearTimeout(timer);
          if (resFrame.type !== "res") {
            reject(new Error("Invalid response frame"));
            return;
          }
          if (!resFrame.ok) {
            reject(new Error(resFrame.error?.message ?? resFrame.error?.code ?? "RPC error"));
            return;
          }
          resolve(resFrame.payload);
        });
        ws.send(JSON.stringify(req));
      });
    },
    [],
  );

  const disconnect = useCallback(() => {
    if (challengeTimerRef.current != null) {
      window.clearTimeout(challengeTimerRef.current);
      challengeTimerRef.current = null;
    }
    connectSentRef.current = false;
    wsRef.current?.close();
    wsRef.current = null;
    pendingRef.current.clear();
    connectReqIdRef.current = null;
    setConnState("idle");
  }, []);

  const connect = useCallback(
    (wsUrl: string, token: string, sessionKey: string) => {
      disconnect();
      connectSentRef.current = false;
      sessionKeyRef.current = sessionKey.trim();
      setError(null);
      setConnState("connecting");
      setLastHello(null);
      setRawFrames([]);
      setTimeline([]);

      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl);
      } catch (e) {
        setConnState("error");
        setError(e instanceof Error ? e.message : "Invalid WebSocket URL");
        return;
      }

      wsRef.current = socket;

      socket.onerror = () => {
        setConnState("error");
        setError("WebSocket error (check URL, TLS, and CORS/browser mixed content).");
      };

      socket.onclose = () => {
        if (wsRef.current === socket) wsRef.current = null;
        setConnState((s) => (s === "connecting" ? "error" : s === "ready" ? "idle" : s));
      };

      socket.onmessage = (ev) => {
        const frame = parseGwFrame(String(ev.data));
        if (!frame) return;
        appendFrame(frame);

        if (!connectSentRef.current && frame.type === "event" && frame.event === "connect.challenge") {
          const payload = frame.payload as { nonce?: unknown } | undefined;
          const nonce =
            payload && typeof payload === "object" && typeof payload.nonce === "string"
              ? payload.nonce.trim()
              : "";
          if (!nonce) {
            setError("connect.challenge missing nonce");
            setConnState("error");
            socket.close();
            return;
          }
          if (challengeTimerRef.current != null) {
            window.clearTimeout(challengeTimerRef.current);
            challengeTimerRef.current = null;
          }
          try {
            const connectFrame = buildConnectReq({ token });
            connectReqIdRef.current = connectFrame.id;
            connectSentRef.current = true;
            sendRaw(connectFrame);
          } catch (e) {
            setConnState("error");
            setError(e instanceof Error ? e.message : "connect send failed");
          }
          return;
        }

        if (frame.type === "res") {
          const cb = pendingRef.current.get(frame.id);
          if (cb) {
            pendingRef.current.delete(frame.id);
            cb(frame);
          }
          if (frame.ok && frame.payload && isHelloOk(frame.payload)) {
            setLastHello(frame.payload);
            setConnState("ready");
            setError(null);
          }
          if (!frame.ok && frame.error && frame.id === connectReqIdRef.current) {
            setError(frame.error.message ?? frame.error.code ?? "connect failed");
            setConnState("error");
          }
        }
      };

      socket.onopen = () => {
        if (challengeTimerRef.current != null) {
          window.clearTimeout(challengeTimerRef.current);
        }
        challengeTimerRef.current = window.setTimeout(() => {
          challengeTimerRef.current = null;
          if (!connectSentRef.current && wsRef.current === socket) {
            setError("Timed out waiting for gateway connect.challenge");
            setConnState("error");
            socket.close();
          }
        }, 15_000);
      };
    },
    [appendFrame, disconnect, sendRaw],
  );

  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  /** After hello, subscribe + optional snapshot (must not block connect()). */
  useEffect(() => {
    if (connState !== "ready" || !wsRef.current) return;
    const key = sessionKeyRef.current;
    if (!key) {
      pushSynthetic("sessions.messages.subscribe skipped", "Session key is empty.");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        /* 대시보드 타임라인의 도구 이벤트는 messages 전용 스트림에 없을 수 있어 세션 구독도 시도한다. */
        await sendReadonly("sessions.subscribe", { key });
      } catch (e) {
        if (!cancelled) {
          pushSynthetic(
            "sessions.subscribe failed",
            e instanceof Error ? e.message : String(e),
          );
        }
      }
      try {
        await sendReadonly("sessions.messages.subscribe", { key });
      } catch (e) {
        if (!cancelled) {
          pushSynthetic(
            "sessions.messages.subscribe failed",
            e instanceof Error ? e.message : String(e),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connState, pushSynthetic, sendReadonly]);

  const jsonlLines = useMemo(
    () => rawFrames.map((f) => JSON.stringify(f, replacer)),
    [rawFrames],
  );

  return {
    connState,
    error,
    lastHello,
    timeline,
    rawFrames,
    jsonlLines,
    connect,
    disconnect,
    sendReadonly,
  };
}

function isHelloOk(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && (payload as { type?: string }).type === "hello-ok");
}

function replacer(_k: string, v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  return v;
}
