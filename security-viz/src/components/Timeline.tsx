import type { TimelineEntry } from "../gateway/normalizeEvent";

export type TimelineProps = {
  entries: TimelineEntry[];
  activeId: string | null;
  onSelect: (id: string) => void;
};

const STAGE_FOR_KIND: Record<TimelineEntry["kind"], number> = {
  "session.message": 1,
  chat: 1,
  "session.tool": 3,
  approval: 2,
  other: 1,
};

export function suggestedStage(e: TimelineEntry): number {
  return STAGE_FOR_KIND[e.kind] ?? 1;
}

export function Timeline(props: TimelineProps) {
  const recent = [...props.entries].slice(-80).reverse();
  return (
    <div>
      <h2 style={{ fontSize: "0.85rem", margin: "0 0 8px", color: "var(--muted)" }}>Timeline</h2>
      <ul className="timeline-list">
        {recent.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              className={`timeline-btn ${props.activeId === e.id ? "active" : ""}`}
              onClick={() => props.onSelect(e.id)}
            >
              <div className="t-meta">
                {new Date(e.at).toLocaleTimeString()} · {e.kind} · stage {suggestedStage(e)}
              </div>
              <div className="t-title">{e.title}</div>
              {e.subtitle ? <div className="t-meta">{e.subtitle.slice(0, 120)}</div> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
