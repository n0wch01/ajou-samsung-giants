import { useState, useMemo } from "react";
// @ts-expect-error — JSX component, no types
import ChatPanel from "../components/ChatPanel";
// @ts-expect-error — JSX component, no types
import FindingsList from "../components/FindingsList";
// @ts-expect-error — JSX component, no types
import ScenarioHeader from "../components/ScenarioHeader";

type Finding = {
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  label: string;
  snippet: string;
  ts?: number;
  eventType?: string;
  source?: string;
};

export function StageS2DataLeakage() {
  const [chatFindings, setChatFindings] = useState<Finding[]>([]);

  const allFindings = useMemo(
    () => chatFindings.map((f) => ({ ...f, source: "chat" })),
    [chatFindings],
  );

  const handleChatFindings = (findings: Finding[]) => {
    const ts = Date.now() / 1000;
    setChatFindings((prev) => [
      ...prev,
      ...findings.map((f) => ({ ...f, ts, eventType: "chat.response" })),
    ]);
  };

  return (
    <div style={styles.root}>
      <ScenarioHeader findingCount={allFindings.length} />
      <div style={styles.mid}>
        <ChatPanel onFindings={handleChatFindings} />
      </div>
      <div style={styles.bottom}>
        <FindingsList findings={allFindings} events={[]} />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    gap: 12,
    padding: 16,
    overflow: "hidden",
  },
  mid: { flex: 1, overflow: "hidden" },
  bottom: { flex: 1, overflow: "hidden" },
};
