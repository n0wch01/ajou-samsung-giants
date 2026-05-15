import { describe, it, expect } from "vitest";

// Test normalizeFindings logic without mounting hooks
// (extracted inline since the function is not exported)
type SentinelFinding = {
  id: string;
  ruleId: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  message: string;
  recommendedAction: string;
  timestamp?: string;
};

function normalizeFindings(body: unknown): SentinelFinding[] {
  if (Array.isArray(body)) return body as SentinelFinding[];
  if (body && typeof body === "object") {
    const f = (body as { findings?: unknown }).findings;
    if (Array.isArray(f)) return f as SentinelFinding[];
  }
  return [];
}

function mergeById(prev: SentinelFinding[], next: SentinelFinding[]): SentinelFinding[] {
  const map = new Map<string, SentinelFinding>();
  for (const p of prev) map.set(p.id, p);
  for (const n of next) map.set(n.id, n);
  return [...map.values()].sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
}

const SAMPLE: SentinelFinding = {
  id: "f1",
  ruleId: "rule-1",
  severity: "high",
  title: "Test finding",
  message: "Something bad happened",
  recommendedAction: "Fix it",
  timestamp: "2026-01-01T00:00:00Z",
};

describe("normalizeFindings", () => {
  it("accepts a bare array", () => {
    const result = normalizeFindings([SAMPLE]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("f1");
  });

  it("unwraps { findings: [...] } shape", () => {
    const result = normalizeFindings({ findings: [SAMPLE] });
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("high");
  });

  it("returns empty array for null", () => {
    expect(normalizeFindings(null)).toEqual([]);
  });

  it("returns empty array for unexpected object without findings", () => {
    expect(normalizeFindings({ meta: {} })).toEqual([]);
  });

  it("returns empty array for non-array non-object", () => {
    expect(normalizeFindings("bad")).toEqual([]);
    expect(normalizeFindings(42)).toEqual([]);
  });
});

describe("mergeById", () => {
  it("deduplicates by id, keeping latest", () => {
    const old: SentinelFinding = { ...SAMPLE, title: "old" };
    const updated: SentinelFinding = { ...SAMPLE, title: "new" };
    const result = mergeById([old], [updated]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("new");
  });

  it("appends new findings", () => {
    const f2: SentinelFinding = { ...SAMPLE, id: "f2", timestamp: "2026-01-02T00:00:00Z" };
    const result = mergeById([SAMPLE], [f2]);
    expect(result).toHaveLength(2);
  });

  it("sorts by timestamp", () => {
    const early: SentinelFinding = { ...SAMPLE, id: "early", timestamp: "2026-01-01T00:00:00Z" };
    const late: SentinelFinding = { ...SAMPLE, id: "late", timestamp: "2026-01-02T00:00:00Z" };
    const result = mergeById([late], [early]);
    expect(result[0].id).toBe("early");
    expect(result[1].id).toBe("late");
  });

  it("handles entries without timestamp", () => {
    const noTs: SentinelFinding = { ...SAMPLE, id: "no-ts", timestamp: undefined };
    const result = mergeById([], [SAMPLE, noTs]);
    expect(result).toHaveLength(2);
  });
});
