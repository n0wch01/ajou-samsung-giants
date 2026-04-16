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

function pickTitle(event: string, payload: unknown): { kind: TimelineKind; title: string; subtitle?: string } {
  if (event === "session.tool") {
    const p = payload as Record<string, unknown> | undefined;
    const name =
      (typeof p?.name === "string" && p.name) ||
      (typeof p?.tool === "string" && p.tool) ||
      (typeof p?.toolName === "string" && p.toolName) ||
      "tool";
    return { kind: "session.tool", title: name, subtitle: summarizeTool(p) };
  }
  if (event === "session.message") {
    const p = payload as Record<string, unknown> | undefined;
    const role = typeof p?.role === "string" ? p.role : "message";
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

function summarizeMessage(p: Record<string, unknown> | undefined): string | undefined {
  if (!p) return undefined;
  const text = p.text ?? p.content ?? p.message;
  if (typeof text === "string") return text.slice(0, 200);
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
