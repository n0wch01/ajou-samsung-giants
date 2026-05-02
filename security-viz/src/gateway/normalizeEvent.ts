import type { GwFrame } from "./protocol";

export type TimelineKind = "session.message" | "session.tool" | "chat" | "approval" | "other";

export type TimelineEntry = {
  id: string;
  at: number;
  kind: TimelineKind;
  title: string;
  subtitle?: string;
  eventName: string;
  raw: unknown;
};

let seq = 0;

/** 게이트웨이 버전에 따라 `session.tool`, `session.tool.start`, `session.tool.result` 등으로 올 수 있음 */
function isSessionToolEventName(event: string): boolean {
  return event === "session.tool" || event.startsWith("session.tool.");
}

function pickTitle(event: string, payload: unknown): { kind: TimelineKind; title: string; subtitle?: string } {
  if (isSessionToolEventName(event)) {
    const p = payload as Record<string, unknown> | undefined;
    const call = p?.call;
    const callName =
      call && typeof call === "object" && !Array.isArray(call) && typeof (call as { name?: string }).name === "string"
        ? (call as { name: string }).name
        : "";
    const name =
      (typeof p?.name === "string" && p.name) ||
      (typeof p?.tool === "string" && p.tool) ||
      (typeof p?.toolName === "string" && p.toolName) ||
      callName ||
      "tool";
    return { kind: "session.tool", title: name, subtitle: summarizeTool(p) };
  }
  if (event === "agent" || event.startsWith("agent.")) {
    const p = payload as Record<string, unknown> | undefined;
    const k =
      (typeof p?.type === "string" && p.type.toLowerCase()) ||
      (typeof p?.kind === "string" && p.kind.toLowerCase()) ||
      "";
    if (k === "tool" || k === "tool_call" || k === "toolcall" || k === "tool_use") {
      const call = p?.call;
      const callName =
        call && typeof call === "object" && !Array.isArray(call) && typeof (call as { name?: string }).name === "string"
          ? (call as { name: string }).name
          : "";
      const name =
        (typeof p?.name === "string" && p.name) ||
        (typeof p?.toolName === "string" && p.toolName) ||
        (typeof p?.tool === "string" && p.tool) ||
        callName ||
        "tool";
      return { kind: "session.tool", title: name, subtitle: summarizeTool(p) };
    }
  }
  if (event === "session.message") {
    const p = payload as Record<string, unknown> | undefined;
    let role = typeof p?.role === "string" && p.role ? p.role : "";
    if (!role && p) {
      const inner = nestedMessage(p);
      if (inner && typeof inner.role === "string" && inner.role) role = inner.role;
    }
    if (!role && p && typeof p.kind === "string" && /^(user|assistant|system|tool|human)$/i.test(p.kind)) {
      role = p.kind.toLowerCase();
    }
    if (!role) role = "message";
    return { kind: "session.message", title: `message (${role})`, subtitle: summarizeMessage(p) };
  }
  if (event === "chat") {
    const p = payload as Record<string, unknown> | undefined;
    const state = typeof p?.state === "string" ? p.state : "update";
    return { kind: "chat", title: `chat ${state}`, subtitle: summarizeMessage(p) };
  }
  if (event.includes("approval")) {
    return { kind: "approval", title: event, subtitle: JSON.stringify(payload)?.slice(0, 240) };
  }
  return { kind: "other", title: event, subtitle: undefined };
}

function nestedMessage(p: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!p) return undefined;
  const m = p.message;
  if (m && typeof m === "object" && !Array.isArray(m)) return m as Record<string, unknown>;
  return undefined;
}

function summarizeMessage(p: Record<string, unknown> | undefined): string | undefined {
  if (!p) return undefined;
  for (const key of ["text", "content"] as const) {
    const v = p[key];
    if (typeof v === "string" && v.trim()) return v.slice(0, 200);
  }
  const topMsg = p.message;
  if (typeof topMsg === "string" && topMsg.trim()) return topMsg.slice(0, 200);
  const inner = nestedMessage(p);
  if (inner) {
    for (const key of ["text", "content", "body"] as const) {
      const v = inner[key];
      if (typeof v === "string" && v.trim()) return v.slice(0, 200);
    }
    const parts = inner.parts ?? inner.content;
    if (Array.isArray(parts)) {
      const chunks: string[] = [];
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const t = (part as Record<string, unknown>).text ?? (part as Record<string, unknown>).content;
        if (typeof t === "string") chunks.push(t);
      }
      const joined = chunks.join("").trim();
      if (joined) return joined.slice(0, 200);
    }
  }
  return undefined;
}

function summarizeTool(p: Record<string, unknown> | undefined): string | undefined {
  if (!p) return undefined;
  const status = typeof p.status === "string" ? p.status : undefined;
  const phase = typeof p.phase === "string" ? p.phase : undefined;
  const args = p.args ?? p.arguments ?? p.input;
  const bits = [status, phase].filter(Boolean).join(" · ");
  let tail = "";
  if (args !== undefined) {
    try {
      tail = JSON.stringify(args).slice(0, 220);
    } catch {
      tail = "[unserializable]";
    }
  }
  return [bits, tail].filter(Boolean).join(" — ") || undefined;
}

export function frameToTimelineEntry(frame: GwFrame): TimelineEntry | null {
  if (frame.type !== "event") return null;
  const at = Date.now();
  const { kind, title, subtitle } = pickTitle(frame.event, frame.payload);
  seq += 1;
  return {
    id: `tl-${at}-${seq}`,
    at,
    kind,
    title,
    subtitle,
    eventName: frame.event,
    raw: { event: frame.event, payload: frame.payload, seq: frame.seq },
  };
}
