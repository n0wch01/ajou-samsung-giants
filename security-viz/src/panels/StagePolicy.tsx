import { useCallback, useState } from "react";

// ── tools.catalog 파싱 ────────────────────────────────────────────────────

type ToolEntry = {
  name: string;
  description: string;
  source: string;
  parameters: Record<string, unknown> | null;
};

function extractToolsList(data: unknown): ToolEntry[] {
  const candidates: unknown[] = [];

  function walk(x: unknown, depth: number) {
    if (depth < 0 || !x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      const looksLikeTools = x.length > 0 && x.every(
        (el) => el && typeof el === "object" && typeof (el as Record<string, unknown>).name === "string"
      );
      if (looksLikeTools) { candidates.push(x); return; }
      x.forEach((el) => walk(el, depth - 1));
    } else {
      const o = x as Record<string, unknown>;
      for (const key of ["tools", "catalog", "items", "result", "payload", "data"]) {
        if (key in o) walk(o[key], depth - 1);
      }
      if (typeof o.name === "string" && o.name) candidates.push([o]);
    }
  }
  walk(data, 6);

  const best = candidates.sort((a, b) =>
    (Array.isArray(b) ? b.length : 1) - (Array.isArray(a) ? a.length : 1)
  )[0];

  if (!Array.isArray(best)) return [];
  return (best as unknown[]).map((el) => {
    const o = (el ?? {}) as Record<string, unknown>;
    const name = String(o.name ?? o.toolName ?? o.id ?? "");
    const description = String(o.description ?? o.desc ?? o.summary ?? "");
    const source = String(o.source ?? o.plugin ?? o.provider ?? o.origin ?? "");
    const params = o.parameters ?? o.params ?? o.inputSchema ?? o.schema ?? null;
    return {
      name,
      description,
      source,
      parameters: params && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : null,
    };
  }).filter((t) => t.name);
}

function parameterNames(params: Record<string, unknown> | null): string[] {
  if (!params) return [];
  const props = (params as { properties?: Record<string, unknown> }).properties;
  if (props && typeof props === "object") return Object.keys(props);
  return Object.keys(params).filter((k) => k !== "type" && k !== "additionalProperties");
}

function ToolsCatalogView({ data }: { data: unknown }) {
  const [search, setSearch] = useState("");
  const [openTool, setOpenTool] = useState<string | null>(null);
  const tools = extractToolsList(data);
  const q = search.toLowerCase();
  const filtered = q
    ? tools.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
    : tools;

  if (tools.length === 0) {
    return <p className="muted" style={{ marginTop: 8, fontSize: "0.82rem" }}>도구 목록을 파싱할 수 없습니다. 원본 JSON을 확인하세요.</p>;
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div className="policy-catalog-header">
        <span className="muted" style={{ fontSize: "0.78rem" }}>총 {tools.length}개</span>
        <input
          className="policy-search"
          placeholder="도구 이름 또는 설명 검색…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="policy-tool-list">
        {filtered.length === 0 && (
          <p className="muted" style={{ fontSize: "0.82rem", padding: "8px 0" }}>검색 결과 없음</p>
        )}
        {filtered.map((t) => {
          const open = openTool === t.name;
          const params = parameterNames(t.parameters);
          return (
            <div key={t.name} className="policy-tool-card">
              <button
                type="button"
                className="policy-tool-card-header"
                onClick={() => setOpenTool(open ? null : t.name)}
              >
                <span className="policy-tool-name">{t.name}</span>
                {t.source ? <span className="policy-tool-source">{t.source}</span> : null}
                <span className="policy-tool-chev">{open ? "▲" : "▼"}</span>
              </button>
              {t.description && (
                <p className="policy-tool-desc">{t.description}</p>
              )}
              {open && (
                <div className="policy-tool-detail">
                  {params.length > 0 ? (
                    <div>
                      <span className="policy-detail-label">파라미터</span>
                      <div className="policy-param-chips">
                        {params.map((p) => <code key={p} className="policy-param-chip">{p}</code>)}
                      </div>
                    </div>
                  ) : (
                    <span className="muted" style={{ fontSize: "0.75rem" }}>파라미터 없음</span>
                  )}
                  {t.parameters && (
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ fontSize: "0.72rem", color: "var(--muted)", cursor: "pointer" }}>
                        raw schema
                      </summary>
                      <pre className="policy-raw-pre">{JSON.stringify(t.parameters, null, 2)}</pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── config.get 렌더링 ─────────────────────────────────────────────────────

function ConfigValueView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);

  if (value === null) return <span className="cfg-null">null</span>;
  if (value === true) return <span className="cfg-bool">true</span>;
  if (value === false) return <span className="cfg-bool">false</span>;
  if (typeof value === "number") return <span className="cfg-number">{value}</span>;
  if (typeof value === "string") return <span className="cfg-string">"{value}"</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="cfg-muted">[]</span>;
    if (value.every((v) => typeof v === "string" || typeof v === "number")) {
      return (
        <span className="cfg-array-inline">
          [{value.map((v, i) => (
            <span key={i}>
              {typeof v === "string" ? <span className="cfg-string">"{v}"</span> : <span className="cfg-number">{v}</span>}
              {i < value.length - 1 ? <span className="cfg-muted">, </span> : null}
            </span>
          ))}]
        </span>
      );
    }
    return (
      <div style={{ marginLeft: 12 }}>
        <button type="button" className="cfg-toggle" onClick={() => setOpen(!open)}>
          {open ? "▼" : "▶"} [{value.length}]
        </button>
        {open && value.map((v, i) => (
          <div key={i} className="cfg-array-item">
            <span className="cfg-muted">[{i}]</span>
            <ConfigValueView value={v} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="cfg-muted">{"{}"}</span>;
    return (
      <div style={{ marginLeft: depth > 0 ? 12 : 0 }}>
        {depth > 0 && (
          <button type="button" className="cfg-toggle" onClick={() => setOpen(!open)}>
            {open ? "▼" : "▶"} {"{…}"}
          </button>
        )}
        {open && entries.map(([k, v]) => (
          <div key={k} className="cfg-row">
            <span className="cfg-key">{k}</span>
            <span className="cfg-sep">:</span>
            <ConfigValueView value={v} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  return <span>{String(value)}</span>;
}

function ConfigView({ data }: { data: unknown }) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return <pre className="policy-raw-pre" style={{ marginTop: 8 }}>{JSON.stringify(data, null, 2)}</pre>;
  }
  const entries = Object.entries(data as Record<string, unknown>);
  return (
    <div className="cfg-root" style={{ marginTop: 8 }}>
      {entries.map(([k, v]) => (
        <div key={k} className="cfg-section">
          <div className="cfg-section-key">{k}</div>
          <div className="cfg-section-val">
            <ConfigValueView value={v} depth={1} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── tools.effective diff ──────────────────────────────────────────────────

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
      <div className="row" style={{ marginBottom: 8 }}>
        <button type="button" disabled={loading} onClick={() => void load()}>
          {loading ? "비교 중..." : "베이스라인 diff 실행"}
        </button>
      </div>
      {error ? <p className="muted" style={{ color: "var(--warn)" }}>{error}</p> : null}
      {diff ? (
        <div className="stack" style={{ gap: 10 }}>
          <p className="muted" style={{ fontSize: "0.75rem" }}>
            baseline {diff.baseline.length}개 / current {diff.current.length}개
          </p>
          {diff.added.length === 0 && diff.removed.length === 0 ? (
            <p className="muted">차이 없음 — 현재 tools.effective가 베이스라인과 일치합니다.</p>
          ) : null}
          {diff.added.length > 0 ? (
            <div>
              <strong style={{ color: "var(--warn)" }}>추가된 도구 ({diff.added.length})</strong>
              <div className="diff-chip-row">
                {diff.added.map((n) => (
                  <code key={n} className="diff-chip diff-chip-added">{n}</code>
                ))}
              </div>
            </div>
          ) : null}
          {diff.removed.length > 0 ? (
            <div>
              <strong style={{ color: "var(--muted)" }}>제거된 도구 ({diff.removed.length})</strong>
              <div className="diff-chip-row">
                {diff.removed.map((n) => (
                  <code key={n} className="diff-chip diff-chip-removed">{n}</code>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────

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
      <div className="row" style={{ marginBottom: 10 }}>
        <button type="button" disabled={props.busy} onClick={props.onRefreshConfig}>
          config.get 새로고침
        </button>
        <button type="button" disabled={props.busy} onClick={props.onRefreshCatalog}>
          tools.catalog 새로고침
        </button>
      </div>

      <details className="policy-section" open>
        <summary className="policy-section-summary">
          config.get
          {cfg !== undefined
            ? <span className="policy-section-badge ok">로드됨</span>
            : <span className="policy-section-badge empty">없음</span>}
        </summary>
        {cfg === undefined
          ? <p className="muted" style={{ marginTop: 8, fontSize: "0.82rem" }}>연결 후 새로고침을 클릭하세요.</p>
          : <ConfigView data={cfg} />}
      </details>

      <details className="policy-section">
        <summary className="policy-section-summary">
          tools.catalog
          {catalog !== undefined
            ? <span className="policy-section-badge ok">
                {extractToolsList(catalog).length}개 도구
              </span>
            : <span className="policy-section-badge empty">없음</span>}
        </summary>
        {catalog === undefined
          ? <p className="muted" style={{ marginTop: 8, fontSize: "0.82rem" }}>연결 후 새로고침을 클릭하세요.</p>
          : <ToolsCatalogView data={catalog} />}
      </details>

      <ToolsDiffSection />
    </div>
  );
}
