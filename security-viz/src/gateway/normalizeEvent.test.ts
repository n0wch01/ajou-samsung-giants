import { describe, it, expect } from "vitest";
import { frameToTimelineEntry } from "./normalizeEvent";
import type { GwFrame } from "./protocol";

function makeFrame(event: string, payload: unknown = {}): GwFrame {
  return { type: "event", event, seq: 1, id: "test-id", payload };
}

describe("frameToTimelineEntry", () => {
  it("returns null for non-event frames", () => {
    const frame = { type: "res", ok: true, id: "r1", seq: 1 } as unknown as GwFrame;
    expect(frameToTimelineEntry(frame)).toBeNull();
  });

  it("classifies session.tool events", () => {
    const entry = frameToTimelineEntry(makeFrame("session.tool", { name: "exec" }));
    expect(entry?.kind).toBe("session.tool");
    expect(entry?.title).toBe("exec");
    expect(entry?.eventName).toBe("session.tool");
  });

  it("classifies session.tool.start events", () => {
    const entry = frameToTimelineEntry(makeFrame("session.tool.start", { tool: "browser" }));
    expect(entry?.kind).toBe("session.tool");
    expect(entry?.title).toBe("browser");
  });

  it("falls back to 'tool' when no name in session.tool payload", () => {
    const entry = frameToTimelineEntry(makeFrame("session.tool", {}));
    expect(entry?.kind).toBe("session.tool");
    expect(entry?.title).toBe("tool");
  });

  it("classifies session.message events", () => {
    const entry = frameToTimelineEntry(makeFrame("session.message", { role: "user", text: "hello" }));
    expect(entry?.kind).toBe("session.message");
    expect(entry?.title).toBe("message (user)");
    expect(entry?.subtitle).toContain("hello");
  });

  it("classifies approval events (non-session.tool prefix)", () => {
    // events with "approval" that don't start with "session.tool." are classified as approval
    const entry = frameToTimelineEntry(makeFrame("approval.required", {}));
    expect(entry?.kind).toBe("approval");
  });

  it("classifies session.tool.approval as session.tool (session.tool.* takes priority)", () => {
    // session.tool.* prefix wins over approval keyword check
    const entry = frameToTimelineEntry(makeFrame("session.tool.approval.required", {}));
    expect(entry?.kind).toBe("session.tool");
  });

  it("classifies chat events", () => {
    const entry = frameToTimelineEntry(makeFrame("chat", { state: "streaming" }));
    expect(entry?.kind).toBe("chat");
    expect(entry?.title).toContain("streaming");
  });

  it("classifies unknown events as other", () => {
    const entry = frameToTimelineEntry(makeFrame("some.unknown.event", {}));
    expect(entry?.kind).toBe("other");
    expect(entry?.title).toBe("some.unknown.event");
  });

  it("assigns unique ids across calls", () => {
    const e1 = frameToTimelineEntry(makeFrame("session.tool", { name: "a" }));
    const e2 = frameToTimelineEntry(makeFrame("session.tool", { name: "b" }));
    expect(e1?.id).not.toBe(e2?.id);
  });

  it("truncates subtitle for approval events", () => {
    const longPayload = { detail: "x".repeat(500) };
    const entry = frameToTimelineEntry(makeFrame("approval.required", longPayload));
    expect(entry?.subtitle?.length).toBeLessThanOrEqual(240);
  });
});
