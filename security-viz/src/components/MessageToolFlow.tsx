import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { publicAsset } from "../lib/publicAsset";
import { normalizeUserChatDisplay } from "../lib/userChatDisplay";
import { sendScenarioThroughDevServer } from "../gateway/scenarioSend";
import { type GwFrame } from "../gateway/protocol";
import { apiPath } from "../lib/publicAsset";
import type { ConnState } from "../gateway/useGatewayReadonly";
import type { TimelineEntry } from "../gateway/normalizeEvent";
import type { NavAction } from "../App";
import { useFindings, type SentinelFinding } from "../sentinel/useFindings";

type MessageToolFlowProps = {
  entries: TimelineEntry[];
  connState: ConnState;
  wsUrl: string;
  token: string;
  sessionKey: string;
  /** Python dev server 스트리밍으로 받은 GwFrame을 타임라인에 주입한다. */
  injectFrame?: (frame: GwFrame) => void;
  /** 채팅 탭에서 전송이 성공했을 때(시나리오 S1 전용 배지 맥락 해제 등) */
  onChatSent?: () => void;
  /** 탭/모니터링 네비게이션 콜백 */
  onNavigate?: (action: NavAction) => void;
  /** connect()가 호출된 시각(ms). 이 시점 이전 이벤트는 히스토리 재전송분으로 숨긴다. */
  connectedAt?: number | null;
  /** 바뀌면 누적된 findings 상태를 초기화 (Connect 재연결 등) */
  clearKey?: number;
};

function blockedCategory(ruleId: string): string {
  const id = ruleId.toLowerCase();
  if (id === "whitelist-violation" || id.includes("plugin") || id.includes("supply")) return "악성 플러그인 탐지";
  if (id === "md-signature-block" || id.includes("injection") || id.includes("readme") || id.includes("md-") || id.includes("vigil") || id.includes("prompt")) return "악성 MD 탐지";
  if (id.includes("rate") || id.includes("abuse") || id.includes("loop") || id.includes("exhaustion")) return "API Abuse 탐지";
  return "보안 위협 탐지";
}

function BlockedBubble({ finding, onNavigate }: { finding: SentinelFinding; onNavigate?: (a: NavAction) => void }) {
  const catLabel = blockedCategory(finding.ruleId);
  return (
    <div className="kakao-blocked-notif">
      <div className="kakao-blocked-icon">🚫</div>
      <div className="kakao-blocked-body">
        <div className="kakao-blocked-header">
          <span className="kakao-blocked-title">보안 위협 탐지 및 차단됨</span>
          <span className="kakao-blocked-cat">{catLabel}</span>
        </div>
        <div className="kakao-blocked-msg">{finding.title}</div>
        {onNavigate && (
          <button
            type="button"
            className="kakao-blocked-btn"
            onClick={() => onNavigate({ tab: "monitoring", highlightFindingId: finding.id })}
          >
            Monitoring 탭에서 확인 →
          </button>
        )}
      </div>
    </div>
  );
}

export type ToolLine = {
  id: string;
  name: string;
  meta: string;
  argsFull: string;
  /** 도구 실행 결과(대시보드의 Tool output에 해당) */
  outputFull: string;
  /** 동일 호출의 갱신 프레임 병합용(있으면 id, 없으면 이름만) */
  mergeKey: string;
};

type ChatTurn = {
  id: string;
  at: number;
  userText: string;
  /** source metadata badge (origin/clientId) */
  userMeta?: string;
  /** assistant 등 답변 텍스트(스트리밍 시 길이가 이어지면 마지막 청크만 갱신) */
  assistantChunks: string[];
  tools: ToolLine[];
};

function payloadOf(e: TimelineEntry): Record<string, unknown> | undefined {
  const r = e.raw;
  if (!r || typeof r !== "object") return undefined;
  const p = (r as { payload?: unknown }).payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) return undefined;
  return p as Record<string, unknown>;
}

/** OpenClaw often nests body under `message` (object), not top-level `text` / `role`. */
function nestedMessageObj(p: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!p) return undefined;
  const m = p.message;
  if (m && typeof m === "object" && !Array.isArray(m)) return m as Record<string, unknown>;
  return undefined;
}

function messageText(p: Record<string, unknown> | undefined): string {
  if (!p) return "";
  for (const key of ["text", "content"] as const) {
    const v = p[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  const topMsg = p.message;
  if (typeof topMsg === "string" && topMsg.trim()) return topMsg;
  const inner = nestedMessageObj(p);
  if (inner) {
    for (const key of ["text", "content", "body"] as const) {
      const v = inner[key];
      if (typeof v === "string" && v.trim()) return v;
    }
    const parts = inner.parts ?? inner.content;
    if (Array.isArray(parts)) {
      const chunks: string[] = [];
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const po = part as Record<string, unknown>;
        const t = po.text ?? po.content;
        if (typeof t === "string") chunks.push(t);
      }
      const joined = chunks.join("").trim();
      if (joined) return joined.slice(0, 8000);
    }
  }
  return "";
}

function parseSenderMetadataFromText(raw: string): Record<string, unknown> | null {
  const m = raw.match(
    /^Sender\s*\(untrusted metadata\):\s*(?:\n\s*)?(?:```(?:json)?\s*\n)?([\s\S]*?)(?:\n```)?\s*(?:\n|$)/i,
  );
  if (!m) return null;
  const body = (m[1] ?? "").trim();
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function userSourceBadge(
  p: Record<string, unknown> | undefined,
  rawMessageText: string,
): string | undefined {
  const inner = nestedMessageObj(p);
  const senderCandidates: Array<Record<string, unknown> | undefined> = [
    (p?.sender && typeof p.sender === "object" && !Array.isArray(p.sender)) ? (p.sender as Record<string, unknown>) : undefined,
    (inner?.sender && typeof inner.sender === "object" && !Array.isArray(inner.sender)) ? (inner.sender as Record<string, unknown>) : undefined,
    parseSenderMetadataFromText(rawMessageText) ?? undefined,
  ];
  const topCandidates = [p, inner, ...senderCandidates].filter(Boolean) as Record<string, unknown>[];

  const pick = (...vals: unknown[]): string => {
    for (const v of vals) {
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };

  let origin = "";
  let clientId = "";
  for (const o of topCandidates) {
    if (!origin) {
      origin = pick(
        o.origin,
        o.source,
        o.senderOrigin,
        o.sender_origin,
      );
    }
    if (!clientId) {
      clientId = pick(
        o.clientId,
        o.client_id,
        o.senderClientId,
        o.sender_client_id,
        o.id,
      );
    }
    if (origin && clientId) break;
  }

  const parts = [origin, clientId].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function toolArgsFull(p: Record<string, unknown> | undefined): string {
  if (!p) return "";
  const args = p.args ?? p.arguments ?? p.input;
  if (args === undefined) return "";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function extractContentArray(v: unknown): string {
  if (!Array.isArray(v)) return "";
  const chunks: string[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.text === "string" && o.text.trim()) chunks.push(o.text.trim());
    else if (typeof o.content === "string" && o.content.trim()) chunks.push(o.content.trim());
  }
  return chunks.join("\n").trim();
}

const SKIP_TEXT_RE = /^NO(?:_REPLY)?\s*$/;

function pickToolOutput(o: Record<string, unknown> | undefined): string {
  if (!o) return "";
  const keys = [
    "output",
    "result",
    "results",
    "toolResult",
    "tool_result",
    "toolOutput",
    "response",
    "value",
    "data",
    "body",
    "stdout",
    "stderr",
    "message",
    "content",
  ] as const;
  for (const k of keys) {
    const v = o[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 12_000);
    if (Array.isArray(v)) {
      const extracted = extractContentArray(v);
      if (extracted) return extracted.slice(0, 12_000);
    }
    try {
      const s = JSON.stringify(v, null, 2);
      if (s && s !== "{}" && s !== "[]") return s.slice(0, 12_000);
    } catch {
      /* ignore */
    }
  }
  return "";
}

function toolOutputFull(p: Record<string, unknown> | undefined): string {
  if (!p) return "";
  const top = pickToolOutput(p);
  if (top) return top;
  const inner = nestedMessageObj(p);
  return pickToolOutput(inner) || "";
}

function toolMergeKey(p: Record<string, unknown> | undefined, name: string): string {
  if (!p) return name;
  const id =
    (typeof p.toolCallId === "string" && p.toolCallId) ||
    (typeof p.tool_use_id === "string" && p.tool_use_id) ||
    (typeof p.callId === "string" && p.callId) ||
    (typeof p.invocationId === "string" && p.invocationId) ||
    (typeof p.id === "string" && p.id && !String(p.id).startsWith("tl-") ? p.id : "");
  return id ? `${name}#${id}` : name;
}

function roleOf(p: Record<string, unknown> | undefined, kind: TimelineEntry["kind"]): string {
  if (!p) return kind === "chat" ? "chat" : "";
  if (typeof p.role === "string" && p.role.trim()) return p.role.trim();
  const inner = nestedMessageObj(p);
  if (inner && typeof inner.role === "string" && inner.role.trim()) return inner.role.trim();
  const k = p.kind;
  if (typeof k === "string") {
    const lower = k.toLowerCase();
    if (["user", "assistant", "system", "tool", "human"].includes(lower)) return lower;
  }
  if (inner) {
    const ik = inner.kind;
    if (typeof ik === "string") {
      const lower = ik.toLowerCase();
      if (["user", "assistant", "system", "tool", "human"].includes(lower)) return lower;
    }
  }
  return "";
}

function isUserRole(role: string): boolean {
  const r = role.toLowerCase();
  return r === "user" || r === "human";
}

/** 사용자 말풍선이 아닌 본문(assistant·모델·역할 미표기 스트림 등) */
function shouldCaptureAssistantText(role: string): boolean {
  const r = role.toLowerCase();
  if (isUserRole(r)) return false;
  if (r === "tool") return false;
  if (r === "system") return false;
  return true;
}

/** 마지막 비어있지 않은 줄 — 두 응답의 마지막 줄이 같으면 같은 응답으로 판단 */
function lastMeaningfulLine(s: string): string {
  const lines = s.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l) return l;
  }
  return s.trim();
}

function isSameResponse(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  // 마지막 줄이 같고 10자 이상이면 같은 응답
  const la = lastMeaningfulLine(a);
  const lb = lastMeaningfulLine(b);
  if (la.length >= 10 && la === lb) return true;
  return false;
}

function pushAssistantChunk(chunks: string[], raw: string): void {
  const t = raw.trim();
  if (!t) return;
  for (let i = 0; i < chunks.length; i++) {
    if (isSameResponse(chunks[i], t)) {
      // 같은 응답이면 더 긴 쪽 유지
      if (t.length > chunks[i].length) chunks[i] = t;
      return;
    }
  }
  chunks.push(t);
}

function firstNonEmptyString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function isGenericToolName(name: string): boolean {
  const s = name.trim().toLowerCase();
  return !s || s === "tool" || s === "unknown";
}

function readNestedToolName(o: Record<string, unknown>): string {
  const inv = o.invocation;
  if (inv && typeof inv === "object" && !Array.isArray(inv)) {
    const r = inv as Record<string, unknown>;
    const t = firstNonEmptyString(r.toolName, r.tool, r.name);
    if (t) return t;
  }
  const call = o.call;
  if (call && typeof call === "object" && !Array.isArray(call)) {
    const r = call as Record<string, unknown>;
    const t = firstNonEmptyString(r.name, r.tool, r.toolName);
    if (t) return t;
  }
  const tool = o.tool;
  if (typeof tool === "string" && tool.trim()) return tool.trim();
  if (tool && typeof tool === "object" && !Array.isArray(tool)) {
    const r = tool as Record<string, unknown>;
    const t = firstNonEmptyString(r.name, r.toolName, r.tool);
    if (t) return t;
  }
  return "";
}

/** 게이트웨이가 role/tool 프레임에만 실을 때 실제 도구명(exec, web_fetch 등) 추정 */
function deepGuessToolDisplayName(p: Record<string, unknown> | undefined): string {
  if (!p) return "";
  const chain: Record<string, unknown>[] = [p];
  const inner = nestedMessageObj(p);
  if (inner) chain.push(inner);
  for (const o of chain) {
    const d = o.delta;
    if (d && typeof d === "object" && !Array.isArray(d)) chain.push(d as Record<string, unknown>);
  }
  for (const o of chain) {
    const t =
      readNestedToolName(o) ||
      firstNonEmptyString(o.toolName, o.canonicalTool) ||
      (typeof o.tool === "string" ? o.tool : "") ||
      firstNonEmptyString(o.name);
    if (t && !isGenericToolName(t)) return t;
  }
  return "";
}

function toolNameFromEntry(e: TimelineEntry, p: Record<string, unknown> | undefined): string {
  const call = p?.call;
  const callName =
    call && typeof call === "object" && !Array.isArray(call) && typeof (call as { name?: string }).name === "string"
      ? (call as { name: string }).name
      : "";
  return (
    e.title ||
    (typeof p?.name === "string" && p.name) ||
    (typeof p?.tool === "string" && p.tool) ||
    (typeof p?.toolName === "string" && p.toolName) ||
    callName ||
    "tool"
  );
}

function resolveToolDisplayName(e: TimelineEntry, p: Record<string, unknown> | undefined): string {
  const raw = toolNameFromEntry(e, p);
  if (!isGenericToolName(raw)) return raw;
  const guessed = deepGuessToolDisplayName(p);
  return guessed || raw;
}

const TOOL_PART_TYPES = new Set([
  "tool_use",
  "tool_call",
  "toolcall",
  "function_call",
  "toolinvocation",
  "toolinvocationdelta",
  "tool_invocation",
  "mcp_tool_call",
]);

const TOOL_RESULT_PART_TYPES = new Set([
  "tool_result",
  "toolresult",
  "function_call_result",
  "tool_output",
  "tooloutput",
]);

function stringifyArgs(args: unknown): string {
  if (args === undefined) return "";
  try {
    if (typeof args === "string") {
      const t = args.trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          return JSON.stringify(JSON.parse(args), null, 2);
        } catch {
          return args;
        }
      }
      return args;
    }
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/** `agent` 등 중첩 페이로드 어디에든 있을 수 있는 tool_calls 배열 방문 */
function forEachNestedToolCallArray(root: unknown, depth: number, onArray: (arr: unknown[]) => void): void {
  if (depth < 0 || root === null || root === undefined) return;
  if (Array.isArray(root)) {
    for (const el of root) forEachNestedToolCallArray(el, depth - 1, onArray);
    return;
  }
  if (typeof root !== "object") return;
  const o = root as Record<string, unknown>;
  const a = o.tool_calls ?? o.toolCalls;
  if (Array.isArray(a) && a.length > 0) onArray(a);
  for (const v of Object.values(o)) forEachNestedToolCallArray(v, depth - 1, onArray);
}

/** parts / content 배열을 트리 전체에서 수집 (메시지·델타·에이전트 이벤트 공통) */
function forEachNestedParts(root: unknown, depth: number, onPart: (part: Record<string, unknown>) => void): void {
  if (depth < 0 || root === null || root === undefined) return;
  if (Array.isArray(root)) {
    for (const el of root) forEachNestedParts(el, depth - 1, onPart);
    return;
  }
  if (typeof root !== "object") return;
  const o = root as Record<string, unknown>;
  const raw = o.parts ?? o.content;
  if (Array.isArray(raw)) {
    for (const part of raw) {
      if (part && typeof part === "object" && !Array.isArray(part)) {
        onPart(part as Record<string, unknown>);
      }
    }
  }
  for (const v of Object.values(o)) forEachNestedParts(v, depth - 1, onPart);
}

function hasEmbeddedToolSignals(p: Record<string, unknown> | undefined): boolean {
  if (!p) return false;
  let hit = false;
  forEachNestedToolCallArray(p, 14, () => {
    hit = true;
  });
  if (hit) return true;
  forEachNestedParts(p, 14, (po) => {
    const typ = typeof po.type === "string" ? po.type.toLowerCase() : "";
    if (TOOL_PART_TYPES.has(typ) || TOOL_RESULT_PART_TYPES.has(typ)) hit = true;
  });
  return hit;
}

/** 같은 프레임 안에서 tool_result → tool_use 이름 매칭 */
function collectToolCallIdsToNames(p: Record<string, unknown> | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!p) return m;
  forEachNestedParts(p, 14, (po) => {
    const typ = typeof po.type === "string" ? po.type.toLowerCase() : "";
    if (!TOOL_PART_TYPES.has(typ)) return;
    const name =
      (typeof po.name === "string" && po.name) ||
      (typeof po.tool === "string" && po.tool) ||
      (typeof po.toolName === "string" && po.toolName) ||
      "";
    const id =
      (typeof po.id === "string" && po.id) ||
      (typeof po.tool_call_id === "string" && po.tool_call_id) ||
      (typeof po.toolCallId === "string" && po.toolCallId) ||
      "";
    if (id && name) m.set(id, name);
  });
  forEachNestedToolCallArray(p, 14, (tcalls) => {
    for (const tc of tcalls) {
      if (!tc || typeof tc !== "object") continue;
      const o = tc as Record<string, unknown>;
      const fn = o.function;
      let name = (typeof o.name === "string" && o.name) || "";
      if (fn && typeof fn === "object" && !Array.isArray(fn)) {
        const f = fn as Record<string, unknown>;
        if (typeof f.name === "string" && f.name) name = f.name;
      }
      const id =
        (typeof o.id === "string" && o.id) ||
        (typeof o.tool_call_id === "string" && o.tool_call_id) ||
        (typeof o.toolCallId === "string" && o.toolCallId) ||
        "";
      if (id && name) m.set(id, name);
    }
  });
  return m;
}

function embeddedToolLines(e: TimelineEntry, p: Record<string, unknown> | undefined): ToolLine[] {
  if (!p) return [];
  const idToName = collectToolCallIdsToNames(p);
  const lines: ToolLine[] = [];
  let n = 0;
  const seen = new Set<string>();
  const push = (name: string, args: unknown, meta: string, output: string, mergeKey: string) => {
    const sig = `${mergeKey}\0${stringifyArgs(args).slice(0, 200)}\0${output.slice(0, 120)}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    n += 1;
    lines.push({
      id: `${e.id}-emb-${n}`,
      name: name || "tool",
      meta,
      argsFull: stringifyArgs(args),
      outputFull: output,
      mergeKey,
    });
  };

  forEachNestedToolCallArray(p, 14, (tcalls) => {
    for (const tc of tcalls) {
      if (!tc || typeof tc !== "object") continue;
      const o = tc as Record<string, unknown>;
      const fn = o.function;
      let name = (typeof o.name === "string" && o.name) || "";
      let args: unknown = o.arguments ?? o.args ?? o.input;
      if (fn && typeof fn === "object" && !Array.isArray(fn)) {
        const f = fn as Record<string, unknown>;
        if (typeof f.name === "string" && f.name) name = f.name;
        args = f.arguments ?? args;
      }
      const mk =
        (typeof o.id === "string" && o.id) ||
        (typeof o.tool_call_id === "string" && o.tool_call_id) ||
        (typeof o.toolCallId === "string" && o.toolCallId) ||
        name;
      const out = pickToolOutput(o);
      if (name || args !== undefined || out) push(name, args, "", out, `${name || "tool"}#${mk}`);
    }
  });

  forEachNestedParts(p, 14, (po) => {
    const typ = typeof po.type === "string" ? po.type.toLowerCase() : "";
    if (TOOL_RESULT_PART_TYPES.has(typ)) {
      const link =
        (typeof po.tool_use_id === "string" && po.tool_use_id) ||
        (typeof po.toolCallId === "string" && po.toolCallId) ||
        (typeof po.id === "string" && po.id) ||
        "";
      const toolName =
        (link && idToName.get(link)) ||
        (typeof po.name === "string" && po.name) ||
        (typeof po.toolName === "string" && po.toolName) ||
        "tool";
      const out =
        pickToolOutput(po) ||
        (typeof po.content === "string" ? po.content : stringifyArgs(po.content)) ||
        "";
      const mk = link ? `${toolName}#${link}` : `${toolName}#result-${n}`;
      push(toolName, undefined, "output", out, mk);
      return;
    }
    if (!TOOL_PART_TYPES.has(typ)) return;
    const name =
      (typeof po.name === "string" && po.name) ||
      (typeof po.tool === "string" && po.tool) ||
      (typeof po.toolName === "string" && po.toolName) ||
      "";
    const args = po.input ?? po.arguments ?? po.args ?? po.parameters;
    const meta = typ === "tool_use" || typ === "toolcall" ? "" : typ;
    const out = pickToolOutput(po);
    const mk =
      (typeof po.id === "string" && po.id) ||
      (typeof po.tool_call_id === "string" && po.tool_call_id) ||
      (typeof po.toolCallId === "string" && po.toolCallId) ||
      name;
    push(name, args, meta, out, `${name || "tool"}#${mk}`);
  });

  return lines;
}

/**
 * 시나리오「실행 흐름」·타임라인 보강용: `session.tool`이 result를 빼 둔 경우에도
 * `agent` 스트림·assistant `parts`에 임베드된 tool_result를 수집한다.
 */
export function extractEmbeddedToolLinesForViz(e: TimelineEntry): ToolLine[] {
  const p = payloadOf(e);
  if (!p) return [];
  if (e.kind === "other") {
    return hasEmbeddedToolSignals(p) ? embeddedToolLines(e, p) : [];
  }
  if (e.kind === "session.message" || e.kind === "chat") {
    if (isUserRole(roleOf(p, e.kind))) return [];
    return embeddedToolLines(e, p);
  }
  return [];
}

const USER_MSG_DEDUP_MS = 12_000;

/** 말풍선 옆 상태: 출력이 있으면 비움(본문은 출력 블록), 실행 중만 짧게 */
function pillMetaForToolLine(t: ToolLine): string {
  if (t.outputFull?.trim()) return "";
  const tokens = (t.meta || "")
    .split(" · ")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const noise = new Set(["toolcall", "tool_call", "tooluse", "output", "result"]);
  const rest = tokens.filter((x) => !noise.has(x));
  if (rest.some((x) => x.includes("run"))) return "실행 중";
  if (rest.some((x) => x.includes("pend") || x.includes("wait"))) return "대기";
  return "";
}

/** 한 번의 호출로 보이게: 직전 실제 도구 행에 `tool`·running 스텝 흡수, 동일 id 중복 행 병합 */
function finalizeToolRows(lines: ToolLine[]): ToolLine[] {
  const out: ToolLine[] = [];
  for (const raw of lines) {
    const cur: ToolLine = {
      ...raw,
      meta: pillMetaForToolLine(raw),
    };

    const last = out[out.length - 1];
    if (last && !isGenericToolName(last.name) && isGenericToolName(cur.name)) {
      if ((cur.outputFull?.length ?? 0) > (last.outputFull?.length ?? 0)) last.outputFull = cur.outputFull;
      if (cur.argsFull?.trim() && !last.argsFull?.trim()) last.argsFull = cur.argsFull;
      last.id = cur.id;
      last.meta = pillMetaForToolLine(last);
      continue;
    }

    const tail = mergeKeyTail(cur.mergeKey);
    if (last && tail && tail === mergeKeyTail(last.mergeKey) && last.name === cur.name) {
      if ((cur.outputFull?.length ?? 0) > (last.outputFull?.length ?? 0)) last.outputFull = cur.outputFull;
      if (cur.argsFull?.trim() && !last.argsFull?.trim()) last.argsFull = cur.argsFull;
      last.id = cur.id;
      last.meta = pillMetaForToolLine(last);
      continue;
    }

    out.push(cur);
  }
  return out;
}

function mergeKeyTail(key: string): string {
  const i = key.indexOf("#");
  return i >= 0 ? key.slice(i + 1) : "";
}

/** 동일 tool_call id·연속 갱신 프레임을 한 줄로 합침 */
function attachToolLine(bucket: ToolLine[], line: ToolLine): void {
  const tail = mergeKeyTail(line.mergeKey);
  if (tail) {
    for (let i = bucket.length - 1; i >= 0; i--) {
      const ex = bucket[i];
      if (mergeKeyTail(ex.mergeKey) !== tail) continue;
      let changed = false;
      if ((line.outputFull?.length ?? 0) > (ex.outputFull?.length ?? 0)) {
        ex.outputFull = line.outputFull;
        changed = true;
      }
      if (line.argsFull?.trim() && !ex.argsFull?.trim()) {
        ex.argsFull = line.argsFull;
        changed = true;
      }
      if (line.meta) {
        const meta = [ex.meta, line.meta].filter(Boolean).join(" · ");
        if (meta && meta !== ex.meta) {
          ex.meta = meta;
          changed = true;
        }
      }
      if (changed) ex.id = line.id;
      return;
    }
  }
  const last = bucket[bucket.length - 1];
  if (last && last.name === line.name) {
    const identical =
      (line.argsFull || "") === (last.argsFull || "") &&
      (line.outputFull || "") === (last.outputFull || "") &&
      (line.meta || "") === (last.meta || "");
    if (identical) return;

    const lo = line.outputFull?.length ?? 0;
    const eo = last.outputFull?.length ?? 0;
    if (lo > eo || (line.argsFull?.trim() && !last.argsFull?.trim()) || (line.meta && line.meta !== last.meta)) {
      if (lo > eo) last.outputFull = line.outputFull;
      if (line.argsFull?.trim() && !last.argsFull?.trim()) last.argsFull = line.argsFull;
      if (line.meta) last.meta = [last.meta, line.meta].filter(Boolean).join(" · ");
      last.id = line.id;
      return;
    }
  }
  bucket.push(line);
}

/** 다음 사용자 메시지 전까지의 도구·assistant 답변을 한 턴으로 묶음 */
function buildChatTurns(entries: TimelineEntry[]): {
  turns: ChatTurn[];
  orphanTools: ToolLine[];
  orphanAssistantChunks: string[];
} {
  const visible = entries.filter((e) => {
    if (e.eventName === "viz.synthetic") return false;
    if (e.kind === "session.message" || e.kind === "session.tool" || e.kind === "chat") return true;
    if (e.kind === "other") {
      const p = payloadOf(e);
      if (hasEmbeddedToolSignals(p)) return true;
      const t = messageText(p) || (typeof e.subtitle === "string" ? e.subtitle : "");
      if (t.trim() && shouldCaptureAssistantText(roleOf(p, e.kind))) return true;
      return false;
    }
    return false;
  });

  const turns: ChatTurn[] = [];
  const orphanTools: ToolLine[] = [];
  const orphanAssistantChunks: string[] = [];
  let current: ChatTurn | null = null;

  const pushTool = (e: TimelineEntry) => {
    const p = payloadOf(e);
    const name = resolveToolDisplayName(e, p);
    const status = typeof p?.status === "string" ? p.status : "";
    const phase = typeof p?.phase === "string" ? p.phase : "";
    const meta = [status, phase].filter(Boolean).join(" · ");
    const line: ToolLine = {
      id: e.id,
      name,
      meta,
      argsFull: toolArgsFull(p) || (typeof e.subtitle === "string" && !toolOutputFull(p) ? e.subtitle : "") || "",
      outputFull: toolOutputFull(p),
      mergeKey: toolMergeKey(p, name),
    };
    if (current) attachToolLine(current.tools, line);
    else attachToolLine(orphanTools, line);
  };

  for (const e of visible) {
    if (e.kind === "session.tool") {
      pushTool(e);
      continue;
    }

    const p = payloadOf(e);
    const role = roleOf(p, e.kind);
    const text = messageText(p) || e.subtitle || "";

    if (e.kind === "chat" || e.kind === "session.message") {
      if (isUserRole(role)) {
        const rawUserText = text.trim();
        const clean = normalizeUserChatDisplay(rawUserText) || "(내용 없음)";
        const meta = userSourceBadge(p, rawUserText);
        /* messages + session 이중 구독 등으로 동일 사용자 프레임이 두 번 올 때 */
        if (
          current &&
          current.userText === clean &&
          (current.userMeta ?? "") === (meta ?? "") &&
          e.at - current.at <= USER_MSG_DEDUP_MS
        ) {
          continue;
        }
        if (current) turns.push(current);
        current = {
          id: e.id,
          at: e.at,
          userText: clean,
          userMeta: meta,
          assistantChunks: [],
          tools: [],
        };
        continue;
      }
      /* assistant 등: 도구 + 답변 텍스트 */
      for (const line of embeddedToolLines(e, p)) {
        if (current) attachToolLine(current.tools, line);
        else attachToolLine(orphanTools, line);
      }
      if (shouldCaptureAssistantText(role) && text.trim() && !SKIP_TEXT_RE.test(text.trim())) {
        if (current) pushAssistantChunk(current.assistantChunks, text);
        else pushAssistantChunk(orphanAssistantChunks, text);
      }
    }

    if (e.kind === "other") {
      for (const line of embeddedToolLines(e, p)) {
        if (current) attachToolLine(current.tools, line);
        else attachToolLine(orphanTools, line);
      }
      const reply = messageText(p) || (typeof e.subtitle === "string" ? e.subtitle : "");
      if (reply.trim() && !SKIP_TEXT_RE.test(reply.trim()) && shouldCaptureAssistantText(roleOf(p, e.kind))) {
        if (current) pushAssistantChunk(current.assistantChunks, reply);
        else pushAssistantChunk(orphanAssistantChunks, reply);
      }
    }
  }
  if (current) turns.push(current);

  function finalizeChunks(chunks: string[]): string[] {
    const out: string[] = [];
    for (const t of chunks) {
      const idx = out.findIndex((r) => isSameResponse(r, t));
      if (idx >= 0) {
        if (t.length > out[idx].length) out[idx] = t;
      } else {
        out.push(t);
      }
    }
    return out;
  }

  return {
    turns: turns.map((t) => ({
      ...t,
      tools: finalizeToolRows(t.tools),
      assistantChunks: finalizeChunks(t.assistantChunks),
    })),
    orphanTools: finalizeToolRows(orphanTools),
    orphanAssistantChunks: finalizeChunks(orphanAssistantChunks),
  };
}


export function MessageToolFlow(props: MessageToolFlowProps) {
  const [openToolId, setOpenToolId] = useState<string | null>(null);
  const liveEntries = useMemo(() => {
    const threshold = props.connectedAt != null ? props.connectedAt - 10_000 : null;
    if (threshold == null) return props.entries;
    return props.entries.filter((e) => e.at >= threshold);
  }, [props.entries, props.connectedAt]);

  const { turns, orphanTools, orphanAssistantChunks } = useMemo(
    () => buildChatTurns(liveEntries),
    [liveEntries],
  );

  // ── Sentinel 실시간 findings → BlockedBubble ──────────────────────────────
  const { findings } = useFindings({ pollMs: 600, useSse: false, clearKey: props.clearKey });
  const seenFindingIdsRef = useRef<Set<string>>(new Set());
  const [blockedNotifs, setBlockedNotifs] = useState<SentinelFinding[]>([]);
  const clearKeyTimeRef = useRef<number>(Date.now());

  useEffect(() => {
    setBlockedNotifs([]);
    seenFindingIdsRef.current = new Set();
    clearKeyTimeRef.current = Date.now();
  }, [props.clearKey]);

  useEffect(() => {
    // 첫 유저 턴 이후 findings만 표시 — ingest 시작 시 생성된 배치 findings 제외
    const firstTurnAt = turns.length > 0 ? turns[0].at : null;
    if (!firstTurnAt) return; // 유저 메시지가 없으면 표시 안 함
    const threshold = Math.max(
      clearKeyTimeRef.current,
      props.connectedAt ?? 0,
      firstTurnAt,
    );
    // ruleId 기준 중복 제거 (같은 규칙이 배치+실시간 두 번 생성되는 경우)
    const seenRuleIds = new Set(
      [...seenFindingIdsRef.current].map((id) => {
        const f = findings.find((x) => x.id === id);
        return f?.ruleId ?? id;
      }),
    );
    const newOnes = findings.filter((f) => {
      if (!f._rt) return false; // 배치 findings 제외, realtime만 BlockedBubble에 표시
      if (seenFindingIdsRef.current.has(f.id)) return false;
      if (seenRuleIds.has(f.ruleId)) return false;
      if (!f.timestamp) return false;
      if (new Date(f.timestamp).getTime() < threshold) return false;
      return true;
    });
    if (newOnes.length === 0) return;
    newOnes.forEach((f) => {
      seenFindingIdsRef.current.add(f.id);
      seenRuleIds.add(f.ruleId);
    });
    setBlockedNotifs((prev) => [...prev, ...newOnes]);
  }, [findings, props.connectedAt, turns]);

  // finding 발생 시각 이후 에이전트 답변은 숨김 (공격 차단 시 에이전트 응답 표시 방지)
  const firstBlockAt = useMemo(() => {
    if (blockedNotifs.length === 0) return null;
    const ts = blockedNotifs[0].timestamp;
    return ts ? new Date(ts).getTime() : null;
  }, [blockedNotifs]);

  // turns + blockedNotifs를 시각순으로 병합, finding 이후 assistant 답변 숨김
  const chatItems = useMemo(() => {
    type TurnItem = { kind: "turn"; at: number; turn: (typeof turns)[number] };
    type FindingItem = { kind: "finding"; at: number; finding: SentinelFinding };
    const items: (TurnItem | FindingItem)[] = [
      ...turns.map((t) => ({ kind: "turn" as const, at: t.at, turn: t })),
      ...blockedNotifs
        .filter((f) => f.timestamp)
        .map((f) => ({ kind: "finding" as const, at: new Date(f.timestamp!).getTime(), finding: f })),
    ];
    items.sort((a, b) => a.at - b.at);
    return items;
  }, [turns, blockedNotifs]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  // 사용자가 위로 스크롤하면 자동 스크롤 잠시 중단
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      userScrolledUp.current = !atBottom;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 새 메시지/이벤트가 오면 바닥으로 스크롤
  useEffect(() => {
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [turns, orphanAssistantChunks]);

  if (props.connState !== "ready") {
    return (
      <section className="kakao-room kakao-room-empty">
        <div className="chat-empty-state">
          <img src={publicAsset("chitoclaw2.png")} alt="chito and openclaw" className="kakao-empty-illust" />
          <h3 className="chat-empty-title">Gateway Not Connected</h3>
          <p className="chat-empty-desc">
            왼쪽 패널에서 WebSocket URL과 토큰을 입력한 뒤<br />
            <strong>Connect</strong>를 눌러 OpenClaw Gateway에 연결하세요.
          </p>
          <div className="chat-empty-steps">
            <div className="chat-empty-step"><span className="chat-empty-step-num">1</span>WebSocket URL 입력</div>
            <div className="chat-empty-step-arrow">→</div>
            <div className="chat-empty-step"><span className="chat-empty-step-num">2</span>세션 키 · 토큰 입력</div>
            <div className="chat-empty-step-arrow">→</div>
            <div className="chat-empty-step"><span className="chat-empty-step-num">3</span>Connect 클릭</div>
          </div>
        </div>
      </section>
    );
  }

  const empty =
    turns.length === 0 && orphanTools.length === 0 && orphanAssistantChunks.length === 0;

  return (
    <section className="kakao-room">
      <div className="kakao-room-title">
        <img src={publicAsset("chito.png")} alt="chito" className="kakao-room-avatar" />
        채팅
      </div>
      <div className="kakao-room-scroll" ref={scrollRef}>
        {empty ? (
          <div className="chat-empty-state chat-empty-state-inline">
            <img src={publicAsset("chito.png")} alt="chito" className="kakao-empty-illust" />
            <h3 className="chat-empty-title">No session activity yet</h3>
            <p className="chat-empty-desc">
              테스트 프롬프트를 입력하면 Agent 응답과<br />보안 이벤트가 이곳에 실시간으로 표시됩니다.
            </p>
            <ul className="chat-empty-list">
              <li><span className="chat-empty-badge badge-blue">Agent</span>Agent Message &amp; Response</li>
              <li><span className="chat-empty-badge badge-purple">Tool</span>Tool Invocation</li>
              <li><span className="chat-empty-badge badge-orange">Policy</span>Policy Violation</li>
              <li><span className="chat-empty-badge badge-red">Alert</span>Sentinel Alert</li>
            </ul>
          </div>
        ) : null}

        {orphanAssistantChunks.length > 0 ? (
          <div className="kakao-orphan">
            <div className="kakao-orphan-label">사용자 메시지 이전 답변</div>
            <div className="kakao-row-assistant">
              <div className="kakao-bubble-assistant kakao-bubble-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {orphanAssistantChunks.join("\n\n")}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        ) : null}

        {orphanTools.length > 0 ? (
          <div className="kakao-orphan">
            <div className="kakao-orphan-label">사용자 메시지 이전에 수집된 도구</div>
            <ToolList
              tools={orphanTools}
              align="left"
              openToolId={openToolId}
              setOpenToolId={setOpenToolId}
            />
          </div>
        ) : null}

        {chatItems.map((item) => {
          if (item.kind === "finding") {
            return (
              <BlockedBubble
                key={`finding-${item.finding.id}`}
                finding={item.finding}
                onNavigate={props.onNavigate}
              />
            );
          }
          const turn = item.turn;
          // 차단 finding이 하나라도 있으면 에이전트 응답 전체 숨김 (사전 텍스트 포함)
          const suppressAssistant = firstBlockAt !== null && turn.assistantChunks.length > 0;
          return (
            <div key={turn.id} className="kakao-turn">
              <time className="kakao-time" dateTime={new Date(turn.at).toISOString()}>
                {new Date(turn.at).toLocaleTimeString()}
              </time>
              <div className="kakao-row-user">
                <div className="kakao-user-stack">
                  {turn.userMeta ? <div className="kakao-user-meta">{turn.userMeta}</div> : null}
                  <div className="kakao-bubble-user">{turn.userText}</div>
                </div>
              </div>
              <div className="kakao-tools-block">
                {turn.tools.length > 0 ? (
                  <>
                    <div className="kakao-tools-caption">이 메시지 이후 호출된 도구</div>
                    <ToolList
                      tools={turn.tools}
                      align="right"
                      openToolId={openToolId}
                      setOpenToolId={setOpenToolId}
                    />
                  </>
                ) : (
                  <div className="kakao-tools-none">연결된 도구 호출 기록 없음</div>
                )}
              </div>
              {turn.assistantChunks.length > 0 && !suppressAssistant ? (
                <div className="kakao-row-assistant kakao-row-assistant-after-tools">
                  <img src={publicAsset("chito.png")} alt="chito" className="kakao-msg-avatar" />
                  <div className="kakao-bubble-assistant kakao-bubble-md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {turn.assistantChunks.join("\n\n")}
                    </ReactMarkdown>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <ChatInput
        wsUrl={props.wsUrl}
        token={props.token}
        sessionKey={props.sessionKey}
        injectFrame={props.injectFrame}
      />
    </section>
  );
}

function ChatInput(props: { wsUrl: string; token: string; sessionKey: string; injectFrame?: (frame: GwFrame) => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(() => setHint(null), 5000);
    return () => window.clearTimeout(t);
  }, [hint]);

  const sendViaGateway = useCallback(async (msg: string) => {
    if (props.injectFrame) {
      // Dev server가 Python(device 서명)으로 구독+전송 후 이벤트를 스트리밍해줌
      setText("");
      inputRef.current?.focus();
      try {
        const res = await fetch(apiPath("/api/scenario/chat-stream"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wsUrl: props.wsUrl,
            token: props.token,
            sessionKey: props.sessionKey,
            message: msg,
          }),
        });
        if (!res.ok || !res.body) {
          const j = await res.json().catch(() => ({})) as { message?: string };
          setHint(j.message ?? `HTTP ${res.status}`);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const frame = JSON.parse(trimmed) as { type?: string; event?: string };
              if (frame.type === "event") props.injectFrame!(frame as import("../gateway/protocol").GwFrame);
            } catch { /* ignore parse errors */ }
          }
        }
      } catch (e) {
        setHint(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    const res = await sendScenarioThroughDevServer({
      wsUrl: props.wsUrl,
      token: props.token,
      sessionKey: props.sessionKey,
      message: msg,
      scenarioId: "chat",
    });
    const isNoReply = !res.ok && res.message != null && SKIP_TEXT_RE.test(res.message.trim());
    if (res.ok || isNoReply) {
      setText("");
      inputRef.current?.focus();
    } else {
      setHint(res.message);
    }
  }, [props.wsUrl, props.token, props.sessionKey, props.injectFrame]);

  const send = useCallback(async () => {
    const msg = text.trim();
    if (!msg || sending) return;
    setSending(true);
    setHint(null);
    try {
      await sendViaGateway(msg);
    } finally {
      setSending(false);
    }
  }, [text, sending, sendViaGateway]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="chat-input-bar">

      {hint ? <p className="chat-input-hint">{hint}</p> : null}
      <div className="chat-input-row">
        <textarea
          ref={inputRef}
          className="chat-input-textarea"
          placeholder="메시지 입력 (Shift+Enter 줄바꿈, Enter 전송)"
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="chat-input-send"
          disabled={sending || !text.trim()}
          onClick={() => void send()}
        >
          {sending ? "⏳" : "전송"}
        </button>
      </div>
    </div>
  );
}

function ToolList(props: {
  tools: ToolLine[];
  align: "left" | "right";
  openToolId: string | null;
  setOpenToolId: (id: string | null) => void;
}) {
  const cls = props.align === "right" ? "kakao-tool-list kakao-tool-list-right" : "kakao-tool-list";
  return (
    <ul className={cls}>
      {props.tools.map((t) => {
        const open = props.openToolId === t.id;
        const expandable = Boolean(t.argsFull?.trim() || t.outputFull?.trim());
        return (
          <li key={t.id} className="kakao-tool-item">
            <button
              type="button"
              className={`kakao-tool-pill ${open ? "kakao-tool-pill-open" : ""}`}
              onClick={() => props.setOpenToolId(open ? null : t.id)}
              disabled={!expandable}
            >
              <span className="kakao-tool-pill-main">
                <span className="kakao-tool-pill-name">{t.name}</span>
                {t.meta ? <span className="kakao-tool-pill-meta"> · {t.meta}</span> : null}
              </span>
              {expandable ? (
                <span className="kakao-tool-pill-chev" aria-hidden>
                  {open ? "▲" : "▼"}
                </span>
              ) : null}
            </button>
            {open && expandable ? (
              <div className="kakao-tool-detail">
                {t.argsFull?.trim() ? (
                  <div className="kakao-tool-detail-block">
                    <div className="kakao-tool-detail-label">입력 / 인자</div>
                    <pre className="kakao-tool-args">{t.argsFull}</pre>
                  </div>
                ) : null}
                {t.outputFull?.trim() ? (
                  <div className="kakao-tool-detail-block">
                    <div className="kakao-tool-detail-label">출력 (Tool output)</div>
                    <pre className="kakao-tool-args kakao-tool-args-output">{t.outputFull}</pre>
                  </div>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
