import { useCallback, useState } from "react";
import { apiPath } from "../lib/publicAsset";

// ── tools.catalog 파싱 ────────────────────────────────────────────────────

type CatalogTool = {
  id: string;
  label: string;
  description: string;
  source: string;
  pluginId?: string;
};

type CatalogGroup = {
  id: string;
  label: string;
  source: string;
  pluginId?: string;
  tools: CatalogTool[];
};

function extractGroups(data: unknown): CatalogGroup[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const o = data as Record<string, unknown>;
  const groups = o.groups;
  if (!Array.isArray(groups)) return [];
  return groups
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
    .map((g) => ({
      id: String(g.id ?? ""),
      label: String(g.label ?? g.id ?? ""),
      source: String(g.source ?? ""),
      pluginId: g.pluginId ? String(g.pluginId) : undefined,
      tools: Array.isArray(g.tools)
        ? (g.tools as Record<string, unknown>[]).map((t) => ({
            id: String(t.id ?? ""),
            label: String(t.label ?? t.id ?? ""),
            description: String(t.description ?? ""),
            source: String(t.source ?? g.source ?? ""),
            pluginId: t.pluginId ? String(t.pluginId) : undefined,
          })).filter((t) => t.id)
        : [],
    }))
    .filter((g) => g.id);
}

function ToolsCatalogView({ data }: { data: unknown }) {
  const [search, setSearch] = useState("");
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const groups = extractGroups(data);
  const q = search.toLowerCase();

  const filteredGroups = groups
    .map((g) => ({
      ...g,
      tools: q
        ? g.tools.filter((t) => t.id.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || g.label.toLowerCase().includes(q))
        : g.tools,
    }))
    .filter((g) => g.tools.length > 0);

  const totalTools = groups.reduce((s, g) => s + g.tools.length, 0);

  if (groups.length === 0) {
    return <p className="muted" style={{ marginTop: 8, fontSize: "0.82rem" }}>도구 그룹을 찾을 수 없습니다.</p>;
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div className="policy-catalog-header">
        <span className="muted" style={{ fontSize: "0.78rem" }}>
          {groups.length}개 그룹 · 총 {totalTools}개 도구
        </span>
        <input
          className="policy-search"
          placeholder="도구 이름 또는 설명 검색…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="policy-tool-list">
        {filteredGroups.length === 0 && (
          <p className="muted" style={{ fontSize: "0.82rem", padding: "8px 0" }}>검색 결과 없음</p>
        )}
        {filteredGroups.map((g) => {
          const isOpen = openGroup === g.id;
          const isPlugin = g.source === "plugin";
          return (
            <div key={g.id} className={`policy-tool-card${isPlugin ? " policy-tool-card-plugin" : ""}`}>
              <button
                type="button"
                className="policy-tool-card-header"
                onClick={() => setOpenGroup(isOpen ? null : g.id)}
              >
                <span className="policy-tool-name">{g.label}</span>
                <span className={`policy-tool-source${isPlugin ? " policy-tool-source-plugin" : ""}`}>
                  {isPlugin ? `플러그인: ${g.pluginId ?? g.label}` : g.source}
                </span>
                <span className="policy-tool-source" style={{ marginLeft: "auto" }}>
                  {g.tools.length}개
                </span>
                <span className="policy-tool-chev">{isOpen ? "▲" : "▼"}</span>
              </button>
              {isOpen && (
                <div className="policy-group-tools">
                  {g.tools.map((t) => (
                    <div key={t.id} className="policy-group-tool-row">
                      <code className="policy-group-tool-id">{t.id}</code>
                      {t.description && (
                        <span className="policy-group-tool-desc">{t.description}</span>
                      )}
                    </div>
                  ))}
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

type FlatRow = { path: string; value: unknown };

function flattenConfig(obj: unknown, prefix = ""): FlatRow[] {
  if (obj === null || obj === undefined) return [{ path: prefix, value: obj }];
  if (typeof obj !== "object" || Array.isArray(obj)) return [{ path: prefix, value: obj }];
  const rows: FlatRow[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0) {
      rows.push(...flattenConfig(v, p));
    } else {
      rows.push({ path: p, value: v });
    }
  }
  return rows;
}

function ConfigValueCell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="cfg-null">null</span>;
  if (value === true) return <span className="cfg-bool cfg-bool-true">true</span>;
  if (value === false) return <span className="cfg-bool cfg-bool-false">false</span>;
  if (typeof value === "number") return <span className="cfg-number">{value}</span>;
  if (typeof value === "string") {
    const masked = value.length > 60 ? `${value.slice(0, 60)}…` : value;
    return <span className="cfg-string" title={value}>{masked}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="cfg-muted">[]</span>;
    return (
      <span className="cfg-array-inline">
        {value.map((v, i) => (
          <span key={i}>
            <ConfigValueCell value={v} />
            {i < value.length - 1 ? <span className="cfg-muted">, </span> : null}
          </span>
        ))}
      </span>
    );
  }
  return <span className="cfg-muted">{JSON.stringify(value)}</span>;
}

function ConfigView({ data }: { data: unknown }) {
  const [filter, setFilter] = useState("");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return <pre className="policy-raw-pre" style={{ marginTop: 8 }}>{JSON.stringify(data, null, 2)}</pre>;
  }
  const rows = flattenConfig(data);
  const q = filter.toLowerCase();
  const visible = q ? rows.filter((r) => r.path.toLowerCase().includes(q)) : rows;

  return (
    <div style={{ marginTop: 8 }}>
      <input
        className="policy-search"
        placeholder="키 경로 검색…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ marginBottom: 8 }}
      />
      <table className="cfg-table">
        <thead>
          <tr>
            <th className="cfg-th">키</th>
            <th className="cfg-th">값</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => (
            <tr key={row.path} className="cfg-tr">
              <td className="cfg-td-key"><code>{row.path}</code></td>
              <td className="cfg-td-val"><ConfigValueCell value={row.value} /></td>
            </tr>
          ))}
          {visible.length === 0 && (
            <tr><td colSpan={2} className="cfg-td-empty">검색 결과 없음</td></tr>
          )}
        </tbody>
      </table>
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
      const res = await fetch(apiPath("/api/sentinel/tools-diff"));
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
  configError: string | null;
  catalogError: string | null;
  onRefreshConfig: () => void;
  onRefreshCatalog: () => void;
  busy: boolean;
};

export function StagePolicy(props: StagePolicyProps) {
  const cfg = props.configPayload;
  const catalog = props.catalogPayload;
  const cfgErr = props.configError;
  const catErr = props.catalogError;

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
        {cfgErr
          ? <p className="policy-fetch-error">오류: {cfgErr}</p>
          : cfg === undefined
            ? <p className="muted" style={{ marginTop: 8, fontSize: "0.82rem" }}>연결 후 새로고침을 클릭하세요.</p>
            : <ConfigView data={cfg} />}
      </details>

      <details className="policy-section">
        <summary className="policy-section-summary">
          tools.catalog
          {catalog !== undefined
            ? <span className="policy-section-badge ok">
                {extractGroups(catalog).reduce((s, g) => s + g.tools.length, 0)}개 도구
              </span>
            : <span className="policy-section-badge empty">없음</span>}
        </summary>
        {catErr
          ? <p className="policy-fetch-error">오류: {catErr}</p>
          : catalog === undefined
            ? <p className="muted" style={{ marginTop: 8, fontSize: "0.82rem" }}>연결 후 새로고침을 클릭하세요.</p>
            : <ToolsCatalogView data={catalog} />}
      </details>

      <ToolsDiffSection />
    </div>
  );
}
