/**
 * Sentinel fetch interceptor — CommonJS (--require 호환)
 *
 * NODE_OPTIONS="--require /path/to/this.cjs" openclaw start
 * 으로 로드하면 openclaw 프로세스의 모든 fetch 호출을 가로챔.
 *
 * 환경 변수:
 *   SENTINEL_COLLECTOR_URL  — 수집기 엔드포인트 (기본: http://localhost:5173/api/sentinel/exfil-collect)
 *   SENTINEL_BLOCK_EXFIL    — "1" 이면 외부 요청 즉시 차단 (localhost 제외). 승인 게이트보다 우선.
 *   SENTINEL_FETCH_GATE     — 미설정이면 기본 ON: 외부 fetch는 Vite 대시보드 승인 후 전송.
 *                             즉시 전송(구동)만 하려면 "0" | "false" | "off" | "no".
 *   SENTINEL_FETCH_GATE_TIMEOUT_MS — 승인 대기 최대(ms). 기본 180000
 */

"use strict";

const COLLECTOR_URL =
  process.env.SENTINEL_COLLECTOR_URL ||
  "http://localhost:5173/api/sentinel/exfil-collect";

function gateBaseOrigin() {
  try {
    return new URL(COLLECTOR_URL).origin;
  } catch {
    return "http://localhost:5173";
  }
}

function truthyEnv(name) {
  const v = String(process.env[name] ?? "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** 승인 게이트: 변수 미설정·빈 문자열이면 ON. 끄려면 0/false/off/no */
function fetchGateEnabled() {
  const raw = process.env.SENTINEL_FETCH_GATE;
  if (raw === undefined || raw === null) return true;
  const v = String(raw).trim().toLowerCase();
  if (!v) return true;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return truthyEnv("SENTINEL_FETCH_GATE");
}

const FETCH_GATE_TIMEOUT_MS = (() => {
  const n = Number(process.env.SENTINEL_FETCH_GATE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 180000;
})();

const POLL_MS = 400;

// localhost / 127.0.0.1 는 인터셉트 대상에서 제외 (수집기 재귀 방지 + 내부 통신 보호)
function isInternal(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "::1" ||
      u.hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

function sendToCollector(record) {
  _originalFetch(COLLECTOR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  }).catch(() => {});
}

if (typeof globalThis.fetch !== "function") {
  console.error("[sentinel-intercept] globalThis.fetch 없음 — Node.js 18+ 필요");
  // eslint-disable-next-line no-useless-return
  return;
}

const _originalFetch = globalThis.fetch.bind(globalThis);

/**
 * @param {string} id
 * @param {{ url: string; method: string; payload: string; bytes: number; source: string }} meta
 */
async function gateRegisterAndWait(id, meta) {
  const origin = gateBaseOrigin();
  const registerUrl = `${origin}/api/sentinel/fetch-gate/register`;
  const reg = await _originalFetch(registerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      source: meta.source,
      intercepted_url: meta.url,
      intercepted_method: meta.method,
      payload: meta.payload,
      bytes: meta.bytes,
    }),
  });
  if (!reg.ok) {
    const t = await reg.text().catch(() => "");
    throw new Error(`[Sentinel] fetch-gate 등록 실패 HTTP ${reg.status} ${t.slice(0, 200)}`);
  }

  const deadline = Date.now() + FETCH_GATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const stUrl = `${origin}/api/sentinel/fetch-gate/status?id=${encodeURIComponent(id)}`;
    const st = await _originalFetch(stUrl, { method: "GET" });
    let j = {};
    try {
      j = await st.json();
    } catch {
      j = {};
    }
    const status = typeof j.status === "string" ? j.status : "unknown";
    if (status === "approved") return;
    if (status === "denied") {
      const err = new Error(`[Sentinel] 외부 fetch 거부됨: ${meta.method} ${meta.url}`);
      err.name = "SentinelDeniedError";
      throw err;
    }
    if (status === "unknown") {
      const err = new Error(`[Sentinel] fetch-gate 세션 유실(서버 재시작 등): ${id}`);
      err.name = "SentinelGateLostError";
      throw err;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const err = new Error(`[Sentinel] fetch-gate 승인 시간 초과: ${meta.method} ${meta.url}`);
  err.name = "SentinelGateTimeoutError";
  throw err;
}

globalThis.fetch = async function sentinelFetch(input, init) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : typeof input === "object" && input !== null
          ? String(input.url ?? input)
          : String(input);

  if (isInternal(url)) {
    return _originalFetch(input, init);
  }

  const method = (init?.method ?? "GET").toUpperCase();
  const rawBody = init?.body;
  const bodyStr =
    rawBody == null
      ? ""
      : typeof rawBody === "string"
        ? rawBody.slice(0, 8000)
        : rawBody instanceof ArrayBuffer || ArrayBuffer.isView(rawBody)
          ? `<binary ${rawBody.byteLength ?? "?"}B>`
          : String(rawBody).slice(0, 8000);

  const blockAll = process.env.SENTINEL_BLOCK_EXFIL === "1";
  const useGate = fetchGateEnabled();

  if (blockAll) {
    sendToCollector({
      source: "fetch-interceptor",
      intercepted_url: url,
      intercepted_method: method,
      bytes: bodyStr.length,
      payload: bodyStr,
      blocked: true,
      correlation_id: `intercept-${Date.now()}`,
    });
    const err = new Error(`[Sentinel] fetch 차단: ${method} ${url}`);
    err.name = "SentinelBlockedError";
    throw err;
  }

  if (useGate) {
    const id =
      "gate-" +
      (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`);
    await gateRegisterAndWait(id, {
      url,
      method,
      payload: bodyStr,
      bytes: bodyStr.length,
      source: "fetch-interceptor",
    });
    sendToCollector({
      source: "fetch-interceptor",
      intercepted_url: url,
      intercepted_method: method,
      bytes: bodyStr.length,
      payload: bodyStr,
      blocked: false,
      correlation_id: id,
    });
    return _originalFetch(input, init);
  }

  sendToCollector({
    source: "fetch-interceptor",
    intercepted_url: url,
    intercepted_method: method,
    bytes: bodyStr.length,
    payload: bodyStr,
    blocked: false,
    correlation_id: `intercept-${Date.now()}`,
  });

  return _originalFetch(input, init);
};

const gateNote = fetchGateEnabled()
  ? "승인 게이트 ON (기본) — 외부 fetch는 대시보드 승인 후 전송"
  : "승인 게이트 OFF — SENTINEL_FETCH_GATE=0 등으로 비활성화됨";
console.error(`[sentinel-intercept] fetch 인터셉터 (${gateNote}, collector: ${COLLECTOR_URL})`);
