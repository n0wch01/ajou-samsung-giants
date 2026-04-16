/** OpenClaw gateway JSON framing (read-only client). */

export type GwError = { code: string; message: string; details?: unknown; retryable?: boolean };

export type GwFrame =
  | { type: "req"; id: string; method: string; params?: unknown }
  | { type: "res"; id: string; ok: boolean; payload?: unknown; error?: GwError }
  | { type: "event"; event: string; payload?: unknown; seq?: number; stateVersion?: unknown };

/** Methods the dashboard may call (no chat.send, sessions.abort, etc.). */
export const READONLY_METHODS = new Set([
  "connect",
  "sessions.list",
  "sessions.subscribe",
  "sessions.unsubscribe",
  "sessions.messages.subscribe",
  "sessions.messages.unsubscribe",
  "config.get",
  "tools.catalog",
  "tools.effective",
]);

export function assertReadonlyMethod(method: string): void {
  if (!READONLY_METHODS.has(method)) {
    throw new Error(`Blocked non-readonly gateway method: ${method}`);
  }
}

export function newReqId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function parseGwFrame(raw: string): GwFrame | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const o = v as { type?: string };
    if (o.type === "req" || o.type === "res" || o.type === "event") {
      return v as GwFrame;
    }
    return null;
  } catch {
    return null;
  }
}

export function buildConnectReq(params: {
  token: string;
  scopes?: string[];
}): GwFrame {
  const id = newReqId();
  return {
    type: "req",
    id,
    method: "connect",
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "security-viz",
        version: "0.1.0",
        platform: "web",
        mode: "operator",
      },
      role: "operator",
      scopes: params.scopes ?? ["operator.read"],
      auth: { token: params.token },
      locale: "en-US",
      userAgent: "security-viz/0.1.0",
    },
  };
}
