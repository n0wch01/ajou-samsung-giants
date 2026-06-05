import { useState } from "react";
import { ChatDocs } from "./docs/ChatDocs";
import { MonitoringDocs } from "./docs/MonitoringDocs";
import { PolicyDocs } from "./docs/PolicyDocs";
import { ScenarioDocs } from "./docs/ScenarioDocs";

/** Docs 탭 내부 하위 영역 — 메인 탭(Chat/Monitoring/Policy/Test Scenario)과 1:1 대응. */
type DocsSection = "chat" | "monitoring" | "policy" | "scenario";

const DOCS_SECTIONS: { id: DocsSection; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "monitoring", label: "Monitoring" },
  { id: "policy", label: "Policy" },
  { id: "scenario", label: "Test Scenario" },
];

export function StageDocs() {
  const [section, setSection] = useState<DocsSection>("chat");

  return (
    <div className="docs">
      <nav className="docs-sidebar" role="tablist" aria-label="문서 영역" aria-orientation="vertical">
        {DOCS_SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={section === s.id}
            className={section === s.id ? "docs-navitem active" : "docs-navitem"}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div className="docs-content">
        {DOCS_SECTIONS.map((s) => (
          <section
            key={s.id}
            role="tabpanel"
            hidden={section !== s.id}
            className="docs-section"
          >
            <h2 className="docs-section-title">{s.label} 튜토리얼</h2>
            {s.id === "chat" ? (
              <ChatDocs />
            ) : s.id === "monitoring" ? (
              <MonitoringDocs />
            ) : s.id === "policy" ? (
              <PolicyDocs />
            ) : (
              <ScenarioDocs />
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
