import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StageThreats } from "./StageThreats";
import type { SentinelFinding } from "../sentinel/useFindings";

const FINDING: SentinelFinding = {
  id: "f1",
  ruleId: "s1-supply-chain",
  severity: "high",
  title: "Mock plugin detected",
  message: "Trace contains mock-malicious-plugin marker.",
  recommendedAction: "Investigate and remove plugin.",
  timestamp: "2026-01-01T00:00:00.000Z",
};

function renderThreats(overrides: Partial<Parameters<typeof StageThreats>[0]> = {}) {
  const defaults = {
    findings: [],
    loading: false,
    error: null,
    onRefresh: vi.fn(),
    useSse: false,
    onToggleSse: vi.fn(),
  };
  render(<StageThreats {...defaults} {...overrides} />);
}

describe("StageThreats", () => {
  it("shows empty state when no findings", () => {
    renderThreats();
    expect(screen.getByText(/no findings/i)).toBeInTheDocument();
  });

  it("shows loading text when loading=true", () => {
    renderThreats({ loading: true });
    const btn = screen.getByRole("button", { name: /loading/i });
    expect(btn).toBeDisabled();
  });

  it("shows error message when error is set", () => {
    renderThreats({ error: "connection refused" });
    expect(screen.getByText(/connection refused/i)).toBeInTheDocument();
  });

  it("renders a finding card", () => {
    renderThreats({ findings: [FINDING] });
    expect(screen.getByText("Mock plugin detected")).toBeInTheDocument();
    expect(screen.getByText(/Trace contains mock-malicious-plugin/)).toBeInTheDocument();
    expect(screen.getByText(/HIGH/)).toBeInTheDocument();
    expect(screen.getByText(/s1-supply-chain/)).toBeInTheDocument();
  });

  it("shows recommendedAction for a finding", () => {
    renderThreats({ findings: [FINDING] });
    expect(screen.getByText(/Investigate and remove plugin/)).toBeInTheDocument();
  });

  it("shows timestamp for a finding", () => {
    renderThreats({ findings: [FINDING] });
    expect(screen.getByText(FINDING.timestamp!)).toBeInTheDocument();
  });

  it("calls onRefresh when Refresh button clicked", async () => {
    const onRefresh = vi.fn();
    renderThreats({ onRefresh });
    await userEvent.click(screen.getByRole("button", { name: /refresh findings/i }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("calls onToggleSse when SSE checkbox toggled", async () => {
    const onToggleSse = vi.fn();
    renderThreats({ onToggleSse });
    await userEvent.click(screen.getByRole("checkbox"));
    expect(onToggleSse).toHaveBeenCalledWith(true);
  });

  it("renders multiple findings", () => {
    const f2: SentinelFinding = { ...FINDING, id: "f2", title: "Second finding", severity: "critical" };
    renderThreats({ findings: [FINDING, f2] });
    expect(screen.getByText("Mock plugin detected")).toBeInTheDocument();
    expect(screen.getByText("Second finding")).toBeInTheDocument();
    expect(screen.getByText(/CRITICAL/)).toBeInTheDocument();
  });
});
