import { useCallback, useEffect, useRef, useState } from "react";
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
  let root = data;
  if (root && typeof root === "object" && !Array.isArray(root)) {
    const o = root as Record<string, unknown>;
    if (!Array.isArray(o.groups) && o.payload && typeof o.payload === "object" && !Array.isArray(o.payload)) {
      const inner = o.payload as Record<string, unknown>;
      if (Array.isArray(inner.groups)) root = o.payload;
    }
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return [];
  const o = root as Record<string, unknown>;
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

function ToolsCatalogView({
  data,
  highlightToolId,
  wsUrl,
  token,
}: {
  data: unknown;
  highlightToolId?: string | null;
  wsUrl?: string;
  token?: string;
}) {
  const [search, setSearch] = useState("");
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteMsg, setDeleteMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (highlightToolId) {
      const match = groups.find(
        (g) => g.id === highlightToolId || g.pluginId === highlightToolId ||
          g.tools.some((t) => t.id === highlightToolId)
      );
      if (match) {
        setOpenGroup(match.id);
        setTimeout(() => {
          highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 100);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightToolId]);

  const handleDelete = useCallback(async (group: CatalogGroup) => {
    const pluginId = group.pluginId ?? group.id;
    setDeletingId(group.id);
    setDeleteMsg(null);
    try {
      const ws = (wsUrl ?? "").trim();
      const tok = (token ?? "").trim();
      const url = apiPath(`/api/policy/plugin-delete?wsUrl=${encodeURIComponent(ws)}&token=${encodeURIComponent(tok)}&pluginId=${encodeURIComponent(pluginId)}`);
      const res = await fetch(url, { method: "POST" });
      const j = (await res.json()) as { ok?: boolean; message?: string };
      setDeleteMsg({ id: group.id, ok: !!j.ok, text: j.message ?? (j.ok ? "삭제 완료" : "삭제 실패") });
    } catch (e) {
      setDeleteMsg({ id: group.id, ok: false, text: e instanceof Error ? e.message : "삭제 중 오류" });
    } finally {
      setDeletingId(null);
    }
  }, [wsUrl, token]);

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
          placeholder="도구 이름 또는 설명으로 검색…"
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
          const isHighlighted = highlightToolId !== null && highlightToolId !== undefined &&
            (g.id === highlightToolId || g.pluginId === highlightToolId ||
              g.tools.some((t) => t.id === highlightToolId));
          const isDeleting = deletingId === g.id;
          const msg = deleteMsg?.id === g.id ? deleteMsg : null;

          return (
            <div
              key={g.id}
              ref={isHighlighted ? highlightRef : undefined}
              className={`policy-tool-card${isPlugin ? " policy-tool-card-plugin" : ""}${isHighlighted ? " policy-tool-card-highlight" : ""}`}
            >
              <div className="policy-tool-card-header-row">
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
                {isPlugin && (
                  <button
                    type="button"
                    className="policy-plugin-delete-btn"
                    disabled={isDeleting}
                    onClick={() => void handleDelete(g)}
                  >
                    {isDeleting ? "삭제 중…" : "삭제"}
                  </button>
                )}
              </div>
              {msg && (
                <p className={`policy-plugin-msg${msg.ok ? " policy-plugin-msg-ok" : " policy-plugin-msg-err"}`}>
                  {msg.text}
                </p>
              )}
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
  let root: unknown = data;
  if (root && typeof root === "object" && !Array.isArray(root)) {
    const o = root as Record<string, unknown>;
    if (o.type === "res" && o.payload !== undefined && typeof o.payload === "object" && !Array.isArray(o.payload)) {
      root = o.payload;
    }
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return <pre className="policy-raw-pre" style={{ marginTop: 8 }}>{JSON.stringify(data, null, 2)}</pre>;
  }
  const rows = flattenConfig(root);
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

// ── tools.effective diff 타입 ─────────────────────────────────────────────

type DiffResult = {
  baseline: string[];
  current: string[];
  added: string[];
  removed: string[];
  baselinePath: string;
  tracePath: string;
};

// ── API Abuse 정책 (Rate Limit 설정) ─────────────────────────────────────

type RateLimitPolicy = {
  maxCalls: number;
  windowSec: number;
};

function loadRateLimit(): RateLimitPolicy {
  try {
    const raw = localStorage.getItem("sg.policy.rateLimit");
    if (raw) return JSON.parse(raw) as RateLimitPolicy;
  } catch { /* ignore */ }
  return { maxCalls: 10, windowSec: 30 };
}

function RateLimitSection({ highlightSection }: { highlightSection?: string | null }) {
  const [policy, setPolicy] = useState<RateLimitPolicy>(loadRateLimit);
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlightSection === "rateLimit" && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
      ref.current.classList.add("policy-rl-highlight");
      const t = setTimeout(() => ref.current?.classList.remove("policy-rl-highlight"), 2000);
      return () => clearTimeout(t);
    }
  }, [highlightSection]);

  const save = () => {
    localStorage.setItem("sg.policy.rateLimit", JSON.stringify(policy));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div ref={ref} className="pl-check-card policy-rl-card" id="policy-rate-limit">
      <div className="pl-check-card-header">
        <div className="pl-check-info">
          <span className="pl-check-title">API Abuse 탐지 정책</span>
          <code className="pl-check-method">rate-limit</code>
          <span className="pl-check-desc">도구 호출 횟수 초과 시 탐지합니다.</span>
        </div>
      </div>
      <div className="policy-rl-body">
        <div className="policy-rl-row">
          <label className="policy-rl-label">최대 호출 횟수</label>
          <input
            type="number"
            min={1}
            max={1000}
            className="policy-rl-input"
            value={policy.maxCalls}
            onChange={(e) => setPolicy((p) => ({ ...p, maxCalls: Number(e.target.value) }))}
          />
          <span className="policy-rl-unit">회</span>
        </div>
        <div className="policy-rl-row">
          <label className="policy-rl-label">시간 범위</label>
          <input
            type="number"
            min={1}
            max={3600}
            className="policy-rl-input"
            value={policy.windowSec}
            onChange={(e) => setPolicy((p) => ({ ...p, windowSec: Number(e.target.value) }))}
          />
          <span className="policy-rl-unit">초 내</span>
        </div>
        <div className="policy-rl-actions">
          <button type="button" className="sc-btn-primary" onClick={save}>
            저장
          </button>
          {saved && <span className="policy-rl-saved">✓ 저장되었습니다</span>}
        </div>
        <p className="policy-rl-hint">
          현재 설정: {policy.windowSec}초 내 동일 도구 {policy.maxCalls}회 초과 시 탐지
        </p>
      </div>
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
  configBusy: boolean;
  catalogBusy: boolean;
  highlightToolId?: string | null;
  highlightSection?: string | null;
  wsUrl?: string;
  token?: string;
};

export function StagePolicy(props: StagePolicyProps) {
  const cfg = props.configPayload;
  const catalog = props.catalogPayload;
  const cfgErr = props.configError;
  const catErr = props.catalogError;
  const cfgBusy = props.configBusy;
  const catBusy = props.catalogBusy;

  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const [cfgExpanded, setCfgExpanded] = useState(false);
  const [catExpanded, setCatExpanded] = useState(false);
  const [diffExpanded, setDiffExpanded] = useState(false);

  useEffect(() => {
    if (props.highlightSection === "catalog") {
      setCatExpanded(true);
    }
  }, [props.highlightSection]);

  const loadDiff = useCallback(async () => {
    setDiffLoading(true);
    setDiffError(null);
    try {
      const params = new URLSearchParams();
      if (props.wsUrl) params.set("wsUrl", props.wsUrl);
      if (props.token) params.set("token", props.token);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const res = await fetch(apiPath(`/api/sentinel/tools-diff${qs}`));
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as DiffResult & { ok?: boolean };
      setDiff(data);
    } catch (e) {
      setDiffError(e instanceof Error ? e.message : String(e));
      setDiff(null);
    } finally {
      setDiffLoading(false);
    }
  }, [props.wsUrl, props.token]);

  const configLoaded = cfg !== undefined && !cfgErr;
  const catalogLoaded = catalog !== undefined && !catErr;
  const toolCount = catalogLoaded ? extractGroups(catalog).reduce((s, g) => s + g.tools.length, 0) : null;
  const dangerCount = diff ? diff.added.length + diff.removed.length : null;

  const policyStatus = configLoaded ? "정상" : "미확인";
  const policyStatusClass = configLoaded ? "pl-val-ok" : "pl-val-muted";
  const dangerClass = dangerCount !== null && dangerCount > 0 ? "pl-val-danger" : dangerCount === 0 ? "pl-val-ok" : "pl-val-muted";

  const cfgStatus = cfgBusy ? "확인 중..." : cfgErr ? "오류" : cfg !== undefined ? "완료" : "미확인";
  const cfgChipClass = cfgBusy ? "pl-chip-checking" : cfgErr ? "pl-chip-danger" : cfg !== undefined ? "pl-chip-ok" : "pl-chip-muted";

  const catStatus = catBusy ? "확인 중..." : catErr ? "오류" : catalog !== undefined ? "완료" : "미확인";
  const catChipClass = catBusy ? "pl-chip-checking" : catErr ? "pl-chip-danger" : catalog !== undefined ? "pl-chip-ok" : "pl-chip-muted";

  const diffStatus = diffError ? "오류" : diffLoading ? "비교 중..." : diff !== null ? "완료" : "대기 중";
  const diffChipClass = diffError ? "pl-chip-danger" : diffLoading ? "pl-chip-checking" : diff !== null ? "pl-chip-ok" : "pl-chip-waiting";

  const anyResult = configLoaded || catalogLoaded || diff !== null || cfgErr || catErr || diffError;

  return (
    <div className="sc-page">

      {/* ── 페이지 헤더 ── */}
      <div className="sc-page-header">
        <div className="sc-page-title-wrap">
          <h2 className="sc-page-title">Policy</h2>
          <p className="sc-page-desc">보안 정책 설정과 도구 목록을 검사하고 API Abuse 탐지 기준을 관리합니다.</p>
        </div>
        <div className="sc-status-bar">
          <div className="sc-status-item">
            <span className="sc-status-label">정책 상태</span>
            <span className={`sc-status-value ${policyStatusClass}`}>{policyStatus}</span>
          </div>
          <div className="sc-status-divider" />
          <div className="sc-status-item">
            <span className="sc-status-label">등록 도구</span>
            <span className="sc-status-value">{toolCount !== null ? toolCount : "—"}</span>
          </div>
          <div className="sc-status-divider" />
          <div className="sc-status-item">
            <span className="sc-status-label">위험 변경</span>
            <span className={`sc-status-value ${dangerClass}`}>
              {dangerCount !== null ? dangerCount : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* ── API Abuse 탐지 정책 ── */}
      <RateLimitSection highlightSection={props.highlightSection} />

      {/* ── 검사 항목 ── */}
      <h3 className="pl-section-title">검사 항목</h3>
      <div className="pl-check-list">

        {/* 카드 1: 정책 설정 검사 */}
        <div className="pl-check-card">
          <div className="pl-check-card-header">
            <span className="pl-check-num">01</span>
            <div className="pl-check-info">
              <span className="pl-check-title">정책 설정 검사</span>
              <code className="pl-check-method">config.get</code>
              <span className="pl-check-desc">현재 OpenClaw의 보안 설정을 불러옵니다.</span>
            </div>
            <span className={`pl-chip ${cfgChipClass}`}>{cfgStatus}</span>
            <button
              type="button"
              className="sc-btn-primary"
              disabled={cfgBusy}
              onClick={props.onRefreshConfig}
            >
              {cfgBusy ? "확인 중…" : "정책 설정 확인"}
            </button>
          </div>
          {cfgErr && <p className="pl-check-error">{cfgErr}</p>}
          {cfg !== undefined && !cfgErr && (
            <div className="pl-check-detail">
              <button
                type="button"
                className="pl-detail-toggle"
                onClick={() => setCfgExpanded((v) => !v)}
              >
                {cfgExpanded ? "▲ 상세 접기" : "▼ 상세 보기"}
              </button>
              {cfgExpanded && <ConfigView data={cfg} />}
            </div>
          )}
        </div>

        {/* 카드 2: 도구 목록 검사 */}
        <div className="pl-check-card">
          <div className="pl-check-card-header">
            <span className="pl-check-num">02</span>
            <div className="pl-check-info">
              <span className="pl-check-title">도구 목록 검사</span>
              <code className="pl-check-method">tools.catalog</code>
              <span className="pl-check-desc">현재 등록된 도구 목록을 확인합니다. 플러그인 도구는 삭제할 수 있습니다.</span>
            </div>
            <span className={`pl-chip ${catChipClass}`}>{catStatus}</span>
            <button
              type="button"
              className="sc-btn-primary"
              disabled={catBusy}
              onClick={props.onRefreshCatalog}
            >
              {catBusy ? "확인 중…" : "도구 목록 확인"}
            </button>
          </div>
          {catErr && <p className="pl-check-error">{catErr}</p>}
          {catalog !== undefined && !catErr && (
            <div className="pl-check-detail">
              <button
                type="button"
                className="pl-detail-toggle"
                onClick={() => setCatExpanded((v) => !v)}
              >
                {catExpanded ? "▲ 상세 접기" : "▼ 상세 보기"}
              </button>
              {catExpanded && (
                <ToolsCatalogView
                  data={catalog}
                  highlightToolId={props.highlightToolId}
                  wsUrl={props.wsUrl}
                  token={props.token}
                />
              )}
            </div>
          )}
        </div>

        {/* 카드 3: 기준 도구 목록 비교 */}
        <div className="pl-check-card">
          <div className="pl-check-card-header">
            <span className="pl-check-num">03</span>
            <div className="pl-check-info">
              <span className="pl-check-title">기준 도구 목록 비교</span>
              <code className="pl-check-method">tools.effective baseline diff</code>
              <span className="pl-check-desc">현재 도구 목록과 기준 상태를 비교합니다.</span>
            </div>
            <span className={`pl-chip ${diffChipClass}`}>{diffStatus}</span>
            <button
              type="button"
              className="sc-btn-primary"
              disabled={diffLoading}
              onClick={() => void loadDiff()}
            >
              변경 사항 검사
            </button>
          </div>
          {diffError && <p className="pl-check-error">{diffError}</p>}
          {diff !== null && (
            <div className="pl-check-detail">
              <button
                type="button"
                className="pl-detail-toggle"
                onClick={() => setDiffExpanded((v) => !v)}
              >
                {diffExpanded ? "▲ 결과 접기" : "▼ 결과 보기"}
              </button>
              {diffExpanded && (
                <div className="pl-diff-result">
                  <p className="pl-diff-summary">
                    baseline {diff.baseline.length}개 / current {diff.current.length}개
                  </p>
                  {diff.added.length === 0 && diff.removed.length === 0 ? (
                    <p className="pl-diff-clean">차이 없음 — 현재 tools.effective가 베이스라인과 일치합니다.</p>
                  ) : null}
                  {diff.added.length > 0 && (
                    <div className="pl-diff-section">
                      <span className="pl-diff-label pl-diff-added">추가된 도구 ({diff.added.length})</span>
                      <div className="diff-chip-row">
                        {diff.added.map((n) => (
                          <code key={n} className="diff-chip diff-chip-added">{n}</code>
                        ))}
                      </div>
                    </div>
                  )}
                  {diff.removed.length > 0 && (
                    <div className="pl-diff-section">
                      <span className="pl-diff-label pl-diff-removed">제거된 도구 ({diff.removed.length})</span>
                      <div className="diff-chip-row">
                        {diff.removed.map((n) => (
                          <code key={n} className="diff-chip diff-chip-removed">{n}</code>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>


      </div>

      {/* ── 검사 결과 ── */}
      <h3 className="pl-section-title" style={{ marginTop: 24 }}>검사 결과</h3>
      {!anyResult ? (
        <div className="pl-results-empty">
          <span className="pl-results-empty-icon">◎</span>
          <p>아직 실행된 검사가 없습니다.</p>
        </div>
      ) : (
        <div className="pl-results-content">
          {configLoaded && (
            <div className="pl-result-row pl-result-ok">
              <span className="pl-result-icon">✓</span>
              <span>정책 설정 로드 완료</span>
            </div>
          )}
          {cfgErr && (
            <div className="pl-result-row pl-result-danger">
              <span className="pl-result-icon">✗</span>
              <span>정책 설정 오류 — {cfgErr}</span>
            </div>
          )}
          {catalogLoaded && toolCount !== null && (
            <div className="pl-result-row pl-result-ok">
              <span className="pl-result-icon">✓</span>
              <span>도구 목록 로드 완료 — {toolCount}개 도구 등록됨</span>
            </div>
          )}
          {catErr && (
            <div className="pl-result-row pl-result-danger">
              <span className="pl-result-icon">✗</span>
              <span>도구 목록 오류 — {catErr}</span>
            </div>
          )}
          {diff !== null && diff.added.length === 0 && diff.removed.length === 0 && (
            <div className="pl-result-row pl-result-ok">
              <span className="pl-result-icon">✓</span>
              <span>베이스라인 일치 — 위험 변경 없음</span>
            </div>
          )}
          {diff !== null && (diff.added.length > 0 || diff.removed.length > 0) && (
            <div className="pl-result-row pl-result-danger">
              <span className="pl-result-icon">!</span>
              <span>위험 변경 감지 — {diff.added.length}개 추가, {diff.removed.length}개 제거</span>
            </div>
          )}
          {diffError && (
            <div className="pl-result-row pl-result-warn">
              <span className="pl-result-icon">!</span>
              <span>비교 오류 — {diffError}</span>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
