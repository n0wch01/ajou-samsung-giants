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

/** Matches OpenClaw `GATEWAY_CLIENT_IDS` / `GATEWAY_CLIENT_MODES` (protocol v3). */
const CONTROL_UI_ID = "openclaw-tui";
const CONTROL_UI_MODE = "cli";

function guessClientPlatform(): string {
  if (typeof navigator === "undefined") return "macos";
  const ua = navigator.userAgent || "";
  const plat = navigator.platform || "";
  if (/Win/i.test(plat) || /Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(plat) || /Mac/i.test(ua)) return "macos";
  return "linux";
}

export function buildConnectReq(params: {
  token: string;
  scopes?: string[];
  /** 기본: 대시보드 읽기 전용. 시나리오 전송 등은 별도 id/mode로 두 번째 연결을 열 수 있음 */
  clientId?: string;
  clientMode?: string;
}): Extract<GwFrame, { type: "req" }> {
  const id = newReqId();
  return {
    type: "req",
    id,
    method: "connect",
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: params.clientId ?? CONTROL_UI_ID,
        version: "0.1.0",
        platform: guessClientPlatform(),
        mode: params.clientMode ?? CONTROL_UI_MODE,
      },
      role: "operator",
      scopes: params.scopes ?? ["operator.read"],
      caps: [],
      commands: [],
      permissions: {},
      auth: { token: params.token },
      locale: "en-US",
      userAgent: "openclaw-control-ui/0.1.0",
    },
  };
}
