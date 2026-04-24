import { useCallback, useState } from "react";

type DiffResult = {
  baseline: string[];
  current: string[];
  added: string[];
  removed: string[];
  baselinePath: string;
  tracePath: string;
};

function ToolsDiffSection() {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sentinel/tools-diff");
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as DiffResult & { ok?: boolean };
      setDiff(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDiff(null);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div style={{ marginTop: 20 }}>
      <h3>tools.effective — 베이스라인 diff</h3>
      <p className="muted" style={{ fontSize: "0.82rem" }}>
        <code>trace.jsonl</code>의 마지막 <code>tools.effective</code> 스냅샷과 베이스라인 JSON을 비교합니다.
        Sentinel ingest를 먼저 실행한 뒤 클릭하세요.
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <button type="button" disabled={loading} onClick={() => void load()}>
          {loading ? "비교 중..." : "베이스라인 diff 실행"}
        </button>
      </div>
      {error ? <p className="muted" style={{ color: "var(--warn)" }}>{error}</p> : null}
      {diff ? (
        <div className="stack" style={{ gap: 10 }}>
          <p className="muted" style={{ fontSize: "0.75rem" }}>
            baseline: <code>{diff.baselinePath}</code><br />
            trace: <code>{diff.tracePath}</code><br />
            baseline {diff.baseline.length}개 / current {diff.current.length}개
          </p>
          {diff.added.length === 0 && diff.removed.length === 0 ? (
            <p className="muted">차이 없음 — 현재 tools.effective가 베이스라인과 일치합니다.</p>
          ) : null}
          {diff.added.length > 0 ? (
            <div>
              <strong style={{ color: "var(--warn)" }}>추가된 도구 ({diff.added.length})</strong>
              <ul style={{ margin: "6px 0 0 16px", padding: 0, fontSize: "0.82rem" }}>
                {diff.added.map((n) => <li key={n} style={{ color: "var(--warn)" }}>{n}</li>)}
              </ul>
            </div>
          ) : null}
          {diff.removed.length > 0 ? (
            <div>
              <strong style={{ color: "var(--muted)" }}>제거된 도구 ({diff.removed.length})</strong>
              <ul style={{ margin: "6px 0 0 16px", padding: 0, fontSize: "0.82rem", color: "var(--muted)" }}>
                {diff.removed.map((n) => <li key={n}>{n}</li>)}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export type StagePolicyProps = {
  configPayload: unknown | undefined;
  catalogPayload: unknown | undefined;
  onRefreshConfig: () => void;
  onRefreshCatalog: () => void;
  busy: boolean;
};

export function StagePolicy(props: StagePolicyProps) {
  const cfg = props.configPayload;
  const catalog = props.catalogPayload;
  return (
    <div className="panel">
      <h2>정책 검사</h2>
      <p className="muted">
        읽기 전용 <code>config.get</code>과 <code>tools.catalog</code>로 현재 상태를 확인합니다.
        플러그인 설치 전후로 스냅샷을 비교해 tools.effective diff를 확인하세요.
      </p>
      <div className="row" style={{ marginBottom: 10 }}>
        <button type="button" disabled={props.busy} onClick={props.onRefreshConfig}>
          config.get 새로고침
        </button>
        <button type="button" disabled={props.busy} onClick={props.onRefreshCatalog}>
          tools.catalog 새로고침
        </button>
      </div>
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", fontSize: "0.82rem", fontWeight: 600, color: "var(--muted)" }}>
          config.get (최신){cfg !== undefined ? " ▸ 클릭해서 펼치기" : " — 스냅샷 없음"}
        </summary>
        <pre className="tool-card" style={{ marginTop: 6 }}>
          {cfg === undefined ? "스냅샷 없음. 연결 후 새로고침을 클릭하세요." : JSON.stringify(cfg, null, 2).slice(0, 12000)}
        </pre>
      </details>
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", fontSize: "0.82rem", fontWeight: 600, color: "var(--muted)" }}>
          tools.catalog (최신){catalog !== undefined ? " ▸ 클릭해서 펼치기" : " — 스냅샷 없음"}
        </summary>
        <pre className="tool-card" style={{ marginTop: 6 }}>
          {catalog === undefined
            ? "스냅샷 없음. 연결 후 새로고침을 클릭하세요."
            : JSON.stringify(catalog, null, 2).slice(0, 12000)}
        </pre>
      </details>
      <ToolsDiffSection />
    </div>
  );
}
