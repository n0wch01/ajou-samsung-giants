import { useEffect, useState, useMemo } from "react";
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

function useBridgeHealth(): "checking" | "ok" | "down" {
  const [status, setStatus] = useState<"checking" | "ok" | "down">("checking");

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch("http://localhost:8000/health", { signal: AbortSignal.timeout(2000) });
        if (!cancelled) setStatus(res.ok ? "ok" : "down");
      } catch {
        if (!cancelled) setStatus("down");
      }
    }
    void check();
    const id = window.setInterval(() => void check(), 4000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  return status;
}

export function StageS2DataLeakage() {
  const [chatFindings, setChatFindings] = useState<Finding[]>([]);
  const bridgeStatus = useBridgeHealth();

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
      {bridgeStatus === "down" && (
        <div style={styles.bridgeWarning}>
          bridge.py가 실행되지 않고 있습니다.{" "}
          <code style={{ background: "rgba(0,0,0,0.3)", padding: "2px 6px", borderRadius: 4 }}>
            python bridge.py
          </code>
          를 먼저 실행하세요.
        </div>
      )}
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
    minHeight: 500,
    gap: 12,
    padding: 16,
  },
  bridgeWarning: {
    background: "rgba(255, 160, 0, 0.12)",
    border: "1px solid rgba(255, 160, 0, 0.4)",
    borderRadius: 6,
    padding: "8px 12px",
    fontSize: "0.85rem",
    color: "#ffa000",
  },
  mid: { flex: 1, minHeight: 220, overflow: "hidden" },
  bottom: { flex: 1, minHeight: 160, overflow: "hidden" },
};
