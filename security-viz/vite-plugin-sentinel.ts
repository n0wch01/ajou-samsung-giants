import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile, execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Plugin } from "vite";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function defaultTracePath(): string {
  return path.join(REPO_ROOT, "scripts", "sentinel", "data", "trace.jsonl");
}

function defaultRulesDir(): string {
  return path.join(REPO_ROOT, "scripts", "sentinel", "rules");
}

function defaultBaselinePath(): string {
  return path.join(REPO_ROOT, "scripts", "sentinel", "data", "baseline-tools-effective.example.json");
}

function defaultDetectScript(): string {
  return path.join(REPO_ROOT, "scripts", "sentinel", "detect.py");
}

function sendScenarioScript(): string {
  return path.join(REPO_ROOT, "scripts", "runner", "send_scenario.py");
}

function pickPython(): string {
  const venv = path.join(REPO_ROOT, ".venv", "bin", "python");
  if (fs.existsSync(venv)) return venv;
  return "python3";
}

function traceStat(): { path: string; exists: boolean; mtimeMs: number | null; bytes: number | null } {
  const p = defaultTracePath();
  try {
    const st = fs.statSync(p);
    return { path: p, exists: true, mtimeMs: st.mtimeMs, bytes: st.size };
  } catch {
    return { path: p, exists: false, mtimeMs: null, bytes: null };
  }
}

let child: ChildProcess | null = null;
let startedAt: number | null = null;
let lastExitCode: number | null = null;
let stderrBuf = "";
let spawnError: string | null = null;

// Exfil collector — mock plugin이 실제 fetch로 전송을 시도할 때 수신
type ExfilRecord = {
  id: string;
  ts: number;
  source: string;
  destination: string;
  bytes: number;
  correlation_id: string;
  payload: string;
  blocked: boolean;
};
const exfilLog: ExfilRecord[] = [];

/** 외부 fetch 승인 게이트(인터셉터 기본 ON — SENTINEL_FETCH_GATE=0 으로 비활성) */
type FetchGateEntry = {
  id: string;
  url: string;
  method: string;
  payload: string;
  bytes: number;
  source: string;
  ts: number;
  status: "pending" | "approved" | "denied";
};
const fetchGateById = new Map<string, FetchGateEntry>();

function fetchGateTimeoutMs(): number {
  const v = Number(process.env.SENTINEL_FETCH_GATE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 180_000;
}

function pruneFetchGateResolved(): void {
  const now = Date.now();
  const ttl = 3_600_000;
  for (const [id, e] of fetchGateById) {
    if (e.status !== "pending" && now - e.ts > ttl) fetchGateById.delete(id);
  }
}

// Auto-detect: trace.jsonl 변경 감지 → detect.py 자동 실행 → 결과 캐시
let cachedReport: unknown = null;
let cachedReportAt: number | null = null;
let autoDetectBusy = false;
let autoDetectTimer: ReturnType<typeof setTimeout> | null = null;
let traceWatcher: fs.FSWatcher | null = null;

async function runAutoDetect(): Promise<void> {
  if (autoDetectBusy) return;
  const detectPy = defaultDetectScript();
  if (!fs.existsSync(detectPy) || !fs.existsSync(defaultTracePath())) return;
  autoDetectBusy = true;
  try {
    const py = pickPython();
    const { stdout } = await execFileAsync(
      py,
      [detectPy, "--trace", defaultTracePath(), "--rules-dir", defaultRulesDir(), "--baseline", defaultBaselinePath()],
      { cwd: REPO_ROOT, env: { ...process.env, PYTHONPATH: path.join(REPO_ROOT, "scripts") }, maxBuffer: 24 * 1024 * 1024, timeout: 60_000 },
    );
    const text = stdout.trim();
    if (text) cachedReport = JSON.parse(text);
    cachedReportAt = Date.now();
  } catch {
    /* silent — UI falls back to last cached */
  } finally {
    autoDetectBusy = false;
  }
}

function scheduleAutoDetect(): void {
  if (autoDetectTimer) return;
  autoDetectTimer = setTimeout(() => {
    autoDetectTimer = null;
    void runAutoDetect();
  }, 600);
}

function setupTraceWatcher(): void {
  if (traceWatcher) return;
  const dir = path.dirname(defaultTracePath());
  try {
    if (!fs.existsSync(dir)) return;
    traceWatcher = fs.watch(dir, (_event, filename) => {
      if (filename === "trace.jsonl") scheduleAutoDetect();
    });
    traceWatcher.on("error", () => { traceWatcher = null; });
  } catch { /* ignore */ }
}

/** run-viz.sh 등 외부에서 실행된 ingest.py PID를 찾는다 (macOS/Linux) */
function findExternalIngestPid(): number | null {
  try {
    const out = execSync("pgrep -f 'sentinel/ingest.py'", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const pid = parseInt(out.split("\n")[0], 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function appendLog(chunk: Buffer | string): void {
  stderrBuf += String(chunk);
  if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function resolveOpenClawConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) {
    return resolveUserPath(explicit);
  }
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) {
    return path.join(resolveUserPath(stateDir), "openclaw.json");
  }
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

function ensurePluginAllowedAndEnabled(configPath: string, pluginId: string): { updated: boolean } {
  let changed = false;
  let cfg: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf8").trim();
    cfg = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } else {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    changed = true;
  }

  const pluginsValue = cfg.plugins;
  const plugins =
    pluginsValue && typeof pluginsValue === "object" && !Array.isArray(pluginsValue)
      ? ({ ...pluginsValue } as Record<string, unknown>)
      : {};

  const allowValue = plugins.allow;
  const allow = Array.isArray(allowValue) ? allowValue.filter((v): v is string => typeof v === "string") : [];
  if (!allow.includes(pluginId)) {
    allow.push(pluginId);
    changed = true;
  }
  plugins.allow = allow;

  const entriesValue = plugins.entries;
  const entries =
    entriesValue && typeof entriesValue === "object" && !Array.isArray(entriesValue)
      ? ({ ...entriesValue } as Record<string, unknown>)
      : {};
  const existingEntry = entries[pluginId];
  const entry =
    existingEntry && typeof existingEntry === "object" && !Array.isArray(existingEntry)
      ? ({ ...existingEntry } as Record<string, unknown>)
      : {};
  if (entry.enabled !== true) {
    entry.enabled = true;
    changed = true;
  }
  entries[pluginId] = entry;
  plugins.entries = entries;
  cfg.plugins = plugins;

  if (changed) {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 4), "utf8");
  }
  return { updated: changed };
}

function killChild(): void {
  if (!child || child.killed) {
    child = null;
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  const c = child;
  child = null;
  startedAt = null;
  setTimeout(() => {
    if (!c.killed) {
      try {
        c.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }, 2500).unref?.();
}

export function sentinelControlPlugin(): Plugin {
  return {
    name: "sg-sentinel-control",
    apply: "serve",
    configureServer(server) {
      server.httpServer?.once("close", () => killChild());

      // trace.jsonl 감시 시작 + 기존 파일 있으면 즉시 1회 실행
      setupTraceWatcher();
      void runAutoDetect();

      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!url.startsWith("/api/sentinel") && !url.startsWith("/api/scenario")) {
          next();
          return;
        }

        if (url === "/api/scenario/plugin-status" && req.method === "POST") {
          const body = await readJsonBody(req);
          const wsUrl = String(body.wsUrl ?? "").trim();
          const token = String(body.token ?? "").trim();
          const toolNames = Array.isArray(body.toolNames)
            ? (body.toolNames as unknown[]).map(String).filter(Boolean)
            : [];
          if (!wsUrl || !token) {
            sendJson(res, 400, { ok: false, message: "wsUrl과 token이 필요합니다." });
            return;
          }
          const checkPy = path.join(REPO_ROOT, "scripts", "runner", "check_plugin.py");
          if (!fs.existsSync(checkPy)) {
            sendJson(res, 500, { ok: false, message: `check_plugin.py를 찾을 수 없습니다: ${checkPy}` });
            return;
          }
          const py = pickPython();
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            PYTHONPATH: path.join(REPO_ROOT, "scripts"),
            OPENCLAW_GATEWAY_WS_URL: wsUrl,
            OPENCLAW_GATEWAY_TOKEN: token,
          };
          if (toolNames.length > 0) env.CHECK_TOOL_NAMES = toolNames.join(",");
          try {
            const { stdout } = await execFileAsync(py, [checkPy], {
              cwd: REPO_ROOT,
              env,
              timeout: 20_000,
            });
            const parsed = JSON.parse(stdout.trim()) as unknown;
            sendJson(res, 200, parsed);
          } catch (e) {
            const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
            const out = String(err.stdout ?? "").trim();
            try {
              const parsed = out ? (JSON.parse(out) as unknown) : null;
              if (parsed) { sendJson(res, 200, parsed); return; }
            } catch { /* ignore */ }
            sendJson(res, 500, { ok: false, message: err.message ?? String(e) });
          }
          return;
        }

        if (url === "/api/scenario/guardrail" && req.method === "POST") {
          const body = await readJsonBody(req);
          const wsUrl = String(body.wsUrl ?? "").trim();
          const token = String(body.token ?? "").trim();
          const action = String(body.action ?? "status").trim();
          const toolNames = Array.isArray(body.toolNames)
            ? (body.toolNames as unknown[]).map(String).filter(Boolean)
            : [];
          if (!wsUrl || !token) {
            sendJson(res, 400, { ok: false, message: "wsUrl과 token이 필요합니다." });
            return;
          }
          if (!["on", "off", "status"].includes(action)) {
            sendJson(res, 400, { ok: false, message: "action은 'on', 'off', 'status' 중 하나여야 합니다." });
            return;
          }
          const guardrailPy = path.join(REPO_ROOT, "scripts", "runner", "toggle_guardrail.py");
          if (!fs.existsSync(guardrailPy)) {
            sendJson(res, 500, { ok: false, message: `toggle_guardrail.py를 찾을 수 없습니다: ${guardrailPy}` });
            return;
          }
          const py = pickPython();
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            PYTHONPATH: path.join(REPO_ROOT, "scripts"),
            OPENCLAW_GATEWAY_WS_URL: wsUrl,
            OPENCLAW_GATEWAY_TOKEN: token,
            GUARDRAIL_ACTION: action,
          };
          if (toolNames.length > 0) env.GUARDRAIL_TOOL_NAMES = toolNames.join(",");
          try {
            const { stdout } = await execFileAsync(py, [guardrailPy], {
              cwd: REPO_ROOT,
              env,
              timeout: 20_000,
            });
            const parsed = JSON.parse(stdout.trim()) as unknown;
            sendJson(res, 200, parsed);
          } catch (e) {
            const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
            const out = String(err.stdout ?? "").trim();
            try {
              const parsed = out ? (JSON.parse(out) as unknown) : null;
              if (parsed) { sendJson(res, 200, parsed); return; }
            } catch { /* ignore */ }
            sendJson(res, 500, { ok: false, message: err.message ?? String(e) });
          }
          return;
        }

        if (url === "/api/scenario/plugin-manage" && req.method === "POST") {
          const body = await readJsonBody(req);
          const action = String(body.action ?? "").trim();
          const pluginId = String(body.pluginId ?? "ai-image-toolkit").trim();
          if (!["install", "uninstall"].includes(action)) {
            sendJson(res, 400, { ok: false, message: "action은 'install' 또는 'uninstall'이어야 합니다." });
            return;
          }
          const pluginDir = path.join(REPO_ROOT, "mock-malicious-plugin");
          if (!fs.existsSync(pluginDir)) {
            sendJson(res, 500, { ok: false, message: `플러그인 디렉토리를 찾을 수 없습니다: ${pluginDir}` });
            return;
          }
          if (action === "install") {
            try {
              const installResult = await execFileAsync("openclaw", ["plugins", "install", pluginDir], {
                cwd: REPO_ROOT,
                timeout: 30_000,
              });

              const configPath = resolveOpenClawConfigPath();
              const allowResult = ensurePluginAllowedAndEnabled(configPath, pluginId);

              const restartResult = await execFileAsync("openclaw", ["gateway", "restart"], {
                cwd: REPO_ROOT,
                timeout: 90_000,
              });

              sendJson(res, 200, {
                ok: true,
                action,
                configPath,
                allowEnsured: true,
                configUpdated: allowResult.updated,
                restartDone: true,
                stdout: installResult.stdout.trim(),
                stderr: installResult.stderr.trim(),
                restartStdout: restartResult.stdout.trim(),
                restartStderr: restartResult.stderr.trim(),
              });
            } catch (e) {
              const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
              sendJson(res, 500, {
                ok: false,
                message: err.message ?? String(e),
                stderr: String(err.stderr ?? "").trim(),
                stdout: String(err.stdout ?? "").trim(),
              });
            }
          } else {
            // 제거: 디렉토리 삭제 + openclaw.json에서 등록 정보 제거
            const home = os.homedir();
            const extDir = path.join(home, ".openclaw", "extensions", pluginId);
            const configPath = resolveOpenClawConfigPath();
            try {
              // 1) 확장 디렉토리 삭제
              if (fs.existsSync(extDir)) {
                fs.rmSync(extDir, { recursive: true, force: true });
              }
              // 2) openclaw.json에서 plugins.entries / plugins.installs 항목 제거
              if (fs.existsSync(configPath)) {
                const raw = fs.readFileSync(configPath, "utf8");
                const cfg = JSON.parse(raw) as Record<string, unknown>;
                const plugins = (cfg.plugins ?? {}) as Record<string, unknown>;
                const entries = (plugins.entries ?? {}) as Record<string, unknown>;
                const installs = (plugins.installs ?? {}) as Record<string, unknown>;
                delete entries[pluginId];
                delete installs[pluginId];
                plugins.entries = entries;
                plugins.installs = installs;
                const allowValue = plugins.allow;
                if (Array.isArray(allowValue)) {
                  const nextAllow = allowValue.filter(
                    (v) => !(typeof v === "string" && v === pluginId),
                  );
                  if (nextAllow.length !== allowValue.length) {
                    plugins.allow = nextAllow;
                  }
                }
                cfg.plugins = plugins;
                fs.writeFileSync(configPath, JSON.stringify(cfg, null, 4), "utf8");
              }
              sendJson(res, 200, { ok: true, action, removed: extDir });
            } catch (e) {
              sendJson(res, 500, { ok: false, message: `제거 실패: ${e instanceof Error ? e.message : String(e)}` });
            }
          }
          return;
        }

        if (url === "/api/scenario/send" && req.method === "POST") {
          const body = await readJsonBody(req);
          const wsUrl = String(body.wsUrl ?? "").trim();
          const token = String(body.token ?? "").trim();
          const sessionKey = String(body.sessionKey ?? "").trim();
          const message = String(body.message ?? "").trim();
          const scenarioId = (String(body.scenarioId ?? "S1").trim() || "S1") as string;
          const chatMethod = String(body.chatMethod ?? "").trim();
          if (!wsUrl || !token || !sessionKey || !message) {
            sendJson(res, 400, { ok: false, message: "wsUrl, token, sessionKey, message가 필요합니다." });
            return;
          }
          const sendPy = sendScenarioScript();
          if (!fs.existsSync(sendPy)) {
            sendJson(res, 500, { ok: false, message: `send_scenario.py not found: ${sendPy}` });
            return;
          }
          const py = pickPython();
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            PYTHONPATH: path.join(REPO_ROOT, "scripts"),
            OPENCLAW_GATEWAY_WS_URL: wsUrl,
            OPENCLAW_GATEWAY_TOKEN: token,
            OPENCLAW_GATEWAY_SESSION_KEY: sessionKey,
            OPENCLAW_GATEWAY_SCOPES: process.env.OPENCLAW_GATEWAY_SCOPES ?? "operator.write,operator.read",
            OPENCLAW_SCENARIO_MESSAGE: message,
          };
          if (chatMethod) {
            env.OPENCLAW_CHAT_METHOD = chatMethod;
          }
          try {
            const { stdout, stderr } = await execFileAsync(py, [sendPy, "--scenario", scenarioId], {
              cwd: REPO_ROOT,
              env,
              maxBuffer: 24 * 1024 * 1024,
              timeout: 120_000,
            });
            const text = String(stdout ?? "").trim();
            let parsed: unknown;
            try {
              parsed = text ? (JSON.parse(text) as unknown) : null;
            } catch {
              sendJson(res, 500, {
                ok: false,
                message: "send_scenario stdout was not valid JSON",
                stderrTail: String(stderr ?? "").slice(-2000),
                stdoutHead: text.slice(0, 400),
              });
              return;
            }
            const gw = parsed as { ok?: boolean; error?: { message?: string; code?: string } };
            if (!gw.ok) {
              sendJson(res, 200, {
                ok: false,
                message: gw.error?.message ?? gw.error?.code ?? "chat.send RPC returned ok:false",
                gateway: parsed,
                stderrTail: String(stderr ?? "").slice(-1200),
              });
              return;
            }
            sendJson(res, 200, { ok: true, gateway: parsed, stderrTail: String(stderr ?? "").slice(-1200) });
          } catch (e) {
            const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
            const out = String(err.stdout ?? "").trim();
            let parsed: unknown;
            try {
              parsed = out ? (JSON.parse(out) as unknown) : null;
            } catch {
              parsed = null;
            }
            const gw = parsed as { ok?: boolean; error?: { message?: string } } | null;
            if (gw && gw.ok === false) {
              sendJson(res, 200, {
                ok: false,
                message: gw.error?.message ?? "chat.send failed",
                gateway: parsed,
                stderrTail: (err.stderr ?? "").toString().slice(-2000),
              });
              return;
            }
            sendJson(res, 500, {
              ok: false,
              message: err.message ?? String(e),
              stderrTail: (err.stderr ?? "").toString().slice(-2000),
              stdoutHead: out.slice(0, 400),
            });
          }
          return;
        }

        if (!url.startsWith("/api/sentinel")) {
          sendJson(res, 404, { ok: false, message: "unknown scenario route" });
          return;
        }

        if (url === "/api/sentinel/findings" && req.method === "GET") {
          // trace 있는데 캐시가 없으면 즉시 1회 실행 후 응답
          if (cachedReport === null && fs.existsSync(defaultTracePath())) {
            await runAutoDetect();
          }
          sendJson(res, 200, {
            ok: true,
            report: cachedReport ?? { findings: [] },
            checkedAt: cachedReportAt,
            busy: autoDetectBusy,
          });
          return;
        }

        // ── Exfil 수집기 ─────────────────────────────────────────────────────
        if (url === "/api/sentinel/exfil-collect" && req.method === "POST") {
          // CORS — mock plugin(openclaw process)에서 직접 호출
          res.setHeader("Access-Control-Allow-Origin", "*");
          const body = await readJsonBody(req).catch(() => ({}));
          const record: ExfilRecord = {
            id: `exfil-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            ts: Date.now(),
            source: String(body.source ?? "unknown"),
            destination: "http://localhost:5173/api/sentinel/exfil-collect",
            bytes: Number(body.bytes ?? 0),
            correlation_id: String(body.correlation_id ?? ""),
            payload: String(body.payload ?? ""),
            blocked: Boolean(body.blocked),
          };
          exfilLog.push(record);
          console.error(`[sentinel-exfil] received ${record.bytes}B from ${record.source} (${record.correlation_id})`);
          sendJson(res, 200, { ok: true, received: record.bytes });
          return;
        }

        if (url === "/api/sentinel/exfil-collect" && req.method === "OPTIONS") {
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type");
          res.writeHead(204); res.end();
          return;
        }

        if (url === "/api/sentinel/exfil-log" && req.method === "GET") {
          sendJson(res, 200, { ok: true, log: exfilLog });
          return;
        }

        if (url === "/api/sentinel/exfil-log/clear" && req.method === "POST") {
          exfilLog.length = 0;
          sendJson(res, 200, { ok: true });
          return;
        }

        // ── 외부 fetch 승인 게이트 ───────────────────────────────────────────
        if (url === "/api/sentinel/fetch-gate/register" && req.method === "POST") {
          res.setHeader("Access-Control-Allow-Origin", "*");
          const body = await readJsonBody(req).catch(() => ({}));
          const id = String(body.id ?? "").trim();
          if (!id) {
            sendJson(res, 400, { ok: false, message: "id가 필요합니다." });
            return;
          }
          pruneFetchGateResolved();
          const urlStr = String(body.intercepted_url ?? body.url ?? "").trim();
          const entry: FetchGateEntry = {
            id,
            url: urlStr,
            method: String(body.intercepted_method ?? body.method ?? "GET").toUpperCase().slice(0, 32),
            payload: String(body.payload ?? "").slice(0, 32_000),
            bytes: Number(body.bytes ?? 0),
            source: String(body.source ?? "fetch-interceptor").slice(0, 120),
            ts: Date.now(),
            status: "pending",
          };
          fetchGateById.set(id, entry);
          console.error(`[sentinel-fetch-gate] pending ${entry.method} ${entry.url} (${id})`);
          sendJson(res, 200, { ok: true, id });
          return;
        }

        if (req.method === "GET" && (req.url?.split("?")[0] ?? "") === "/api/sentinel/fetch-gate/status") {
          const raw = req.url ?? "";
          const qs = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
          const id = new URLSearchParams(qs).get("id")?.trim() ?? "";
          if (!id) {
            sendJson(res, 400, { ok: false, status: "unknown", message: "id query 필요" });
            return;
          }
          const maxMs = fetchGateTimeoutMs();
          const e = fetchGateById.get(id);
          if (!e) {
            sendJson(res, 200, { ok: true, status: "unknown" });
            return;
          }
          if (e.status === "pending" && Date.now() - e.ts > maxMs) {
            e.status = "denied";
          }
          sendJson(res, 200, { ok: true, status: e.status });
          return;
        }

        if (url === "/api/sentinel/fetch-gate/pending" && req.method === "GET") {
          const now = Date.now();
          const maxMs = fetchGateTimeoutMs();
          const items: FetchGateEntry[] = [];
          for (const e of fetchGateById.values()) {
            if (e.status === "pending" && now - e.ts > maxMs) e.status = "denied";
            if (e.status === "pending") items.push({ ...e });
          }
          items.sort((a, b) => a.ts - b.ts);
          sendJson(res, 200, { ok: true, items });
          return;
        }

        if (url === "/api/sentinel/fetch-gate/approve" && req.method === "POST") {
          const body = await readJsonBody(req).catch(() => ({}));
          const id = String(body.id ?? "").trim();
          const e = fetchGateById.get(id);
          if (!e) {
            sendJson(res, 404, { ok: false, message: "알 수 없는 id" });
            return;
          }
          if (e.status !== "pending") {
            sendJson(res, 409, { ok: false, message: "이미 처리된 요청입니다." });
            return;
          }
          e.status = "approved";
          sendJson(res, 200, { ok: true });
          return;
        }

        if (url === "/api/sentinel/fetch-gate/deny" && req.method === "POST") {
          const body = await readJsonBody(req).catch(() => ({}));
          const id = String(body.id ?? "").trim();
          const e = fetchGateById.get(id);
          if (!e) {
            sendJson(res, 404, { ok: false, message: "알 수 없는 id" });
            return;
          }
          if (e.status === "pending") e.status = "denied";
          sendJson(res, 200, { ok: true });
          return;
        }

        if (url === "/api/sentinel/fetch-gate/clear-pending" && req.method === "POST") {
          for (const e of fetchGateById.values()) {
            if (e.status === "pending") e.status = "denied";
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        if (url === "/api/sentinel/findings-realtime" && req.method === "GET") {
          const rtPath = path.join(
            path.dirname(defaultTracePath()),
            "findings-realtime.jsonl",
          );
          const findings: unknown[] = [];
          if (fs.existsSync(rtPath)) {
            const lines = fs.readFileSync(rtPath, "utf-8").split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try { findings.push(JSON.parse(trimmed)); } catch { /* skip */ }
            }
          }
          sendJson(res, 200, { ok: true, findings });
          return;
        }

        if (url === "/api/sentinel/findings-realtime/clear" && req.method === "POST") {
          const rtPath = path.join(
            path.dirname(defaultTracePath()),
            "findings-realtime.jsonl",
          );
          try {
            if (fs.existsSync(rtPath)) fs.writeFileSync(rtPath, "", "utf-8");
            sendJson(res, 200, { ok: true });
          } catch (e) {
            sendJson(res, 500, { ok: false, message: String(e) });
          }
          return;
        }

        if (url === "/api/sentinel/status" && req.method === "GET") {
          const trace = traceStat();
          const managedRunning = Boolean(child && !child.killed);
          // run-viz.sh 등 외부에서 실행된 경우도 감지
          const externalPid = !managedRunning ? findExternalIngestPid() : null;
          const running = managedRunning || externalPid !== null;
          const pid = managedRunning ? (child?.pid ?? null) : externalPid;
          const uptime = managedRunning && startedAt ? Date.now() - startedAt : null;
          sendJson(res, 200, {
            controlAvailable: true,
            running,
            pid,
            startedAt: managedRunning ? startedAt : null,
            uptimeMs: uptime,
            lastExitCode,
            trace,
            stderrTail: stderrBuf.slice(-1200),
            spawnError,
          });
          return;
        }

        if (url === "/api/sentinel/stop" && req.method === "POST") {
          spawnError = null;
          killChild();
          sendJson(res, 200, { ok: true });
          return;
        }

        if (url === "/api/sentinel/clear-trace" && req.method === "POST") {
          const tracePath = defaultTracePath();
          try {
            if (fs.existsSync(tracePath)) {
              fs.rmSync(tracePath);
              sendJson(res, 200, { ok: true, removed: tracePath });
            } else {
              sendJson(res, 200, { ok: true, removed: null, message: "파일 없음" });
            }
          } catch (e) {
            sendJson(res, 500, { ok: false, message: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        if (url === "/api/sentinel/detect" && req.method === "POST") {
          const body = await readJsonBody(req);
          const traceP = String(body.tracePath ?? "").trim() || defaultTracePath();
          const rulesP = String(body.rulesDir ?? "").trim() || defaultRulesDir();
          const baselineP = String(body.baselinePath ?? "").trim() || defaultBaselinePath();
          const py = pickPython();
          const detectPy = defaultDetectScript();
          if (!fs.existsSync(detectPy)) {
            sendJson(res, 500, { ok: false, message: `detect.py not found: ${detectPy}` });
            return;
          }
          const args = [
            detectPy,
            "--trace",
            traceP,
            "--rules-dir",
            rulesP,
            "--baseline",
            baselineP,
          ];
          const env = {
            ...process.env,
            PYTHONPATH: path.join(REPO_ROOT, "scripts"),
          };
          try {
            const { stdout, stderr } = await execFileAsync(py, args, {
              cwd: REPO_ROOT,
              env,
              maxBuffer: 24 * 1024 * 1024,
              timeout: 120_000,
            });
            const text = String(stdout ?? "").trim();
            if (!text) {
              sendJson(res, 500, {
                ok: false,
                message: "detect produced empty stdout",
                stderrTail: String(stderr ?? "").slice(-2000),
              });
              return;
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(text) as unknown;
            } catch {
              sendJson(res, 500, {
                ok: false,
                message: "detect stdout was not valid JSON",
                stderrTail: String(stderr ?? "").slice(-2000),
                stdoutHead: text.slice(0, 400),
              });
              return;
            }
            sendJson(res, 200, { ok: true, report: parsed, stderrTail: String(stderr ?? "").slice(-1200) });
          } catch (e) {
            const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
            sendJson(res, 500, {
              ok: false,
              message: err.message ?? String(e),
              stderrTail: (err.stderr ?? "").toString().slice(-2000),
              stdoutHead: (err.stdout ?? "").toString().slice(0, 400),
            });
          }
          return;
        }

        if (url === "/api/sentinel/start" && req.method === "POST") {
          const body = await readJsonBody(req);
          const wsUrl = String(body.wsUrl ?? "").trim();
          const token = String(body.token ?? "").trim();
          const sessionKey = String(body.sessionKey ?? "agent:main").trim();
          if (!wsUrl || !token) {
            sendJson(res, 400, { ok: false, message: "wsUrl과 token이 필요합니다." });
            return;
          }
          if (child && !child.killed) {
            sendJson(res, 409, { ok: false, message: "이미 Sentinel ingest가 실행 중입니다. 먼저 중지하세요." });
            return;
          }
          spawnError = null;
          lastExitCode = null;
          stderrBuf = "";
          const ingest = path.join(REPO_ROOT, "scripts", "sentinel", "ingest.py");
          const py = pickPython();
          const env = {
            ...process.env,
            PYTHONPATH: path.join(REPO_ROOT, "scripts"),
            OPENCLAW_GATEWAY_WS_URL: wsUrl,
            OPENCLAW_GATEWAY_TOKEN: token,
            OPENCLAW_GATEWAY_SESSION_KEY: sessionKey,
            OPENCLAW_GATEWAY_SCOPES: process.env.OPENCLAW_GATEWAY_SCOPES ?? "operator.read",
          };
          try {
            const proc = spawn(py, [ingest, "--duration-s", "0"], {
              cwd: REPO_ROOT,
              env,
              stdio: ["ignore", "pipe", "pipe"],
              detached: false,
            });
            child = proc;
            startedAt = Date.now();
            proc.stdout?.on("data", appendLog);
            proc.stderr?.on("data", appendLog);
            proc.on("error", (err) => {
              spawnError = err.message;
              appendLog(`[spawn error] ${err.message}\n`);
            });
            proc.on("exit", (code) => {
              lastExitCode = code;
              if (child === proc) {
                child = null;
                startedAt = null;
              }
            });
            sendJson(res, 200, { ok: true, pid: proc.pid ?? null });
          } catch (e) {
            spawnError = e instanceof Error ? e.message : String(e);
            child = null;
            startedAt = null;
            sendJson(res, 500, { ok: false, message: spawnError });
          }
          return;
        }

        if (url === "/api/sentinel/tools-diff" && req.method === "GET") {
          const baselinePath = defaultBaselinePath();
          const tracePath = defaultTracePath();

          let baselineNames: string[] = [];
          try {
            const raw = fs.readFileSync(baselinePath, "utf8");
            const parsed = JSON.parse(raw) as { tool_names?: unknown };
            if (Array.isArray(parsed.tool_names)) {
              baselineNames = parsed.tool_names.filter((x): x is string => typeof x === "string");
            }
          } catch {
            /* baseline not found — empty */
          }

          // tools.effective is preferred; fall back to tools.catalog if effective is empty
          let currentNamesEffective: string[] = [];
          let currentNamesCatalog: string[] = [];
          try {
            const lines = fs.readFileSync(tracePath, "utf8").split("\n").filter(Boolean);
            for (const line of lines) {
              try {
                const rec = JSON.parse(line) as {
                  entry_type?: string;
                  rpc_method?: string;
                  payload_summary?: { tool_names?: unknown };
                };
                if (rec.entry_type !== "tools_snapshot") continue;
                const names = rec.payload_summary?.tool_names;
                if (!Array.isArray(names) || names.length === 0) continue;
                const filtered = names.filter((x): x is string => typeof x === "string");
                if (rec.rpc_method === "tools.effective") {
                  currentNamesEffective = filtered;
                } else if (rec.rpc_method === "tools.catalog") {
                  currentNamesCatalog = filtered;
                }
              } catch {
                /* skip malformed line */
              }
            }
          } catch {
            /* trace not found */
          }
          const currentNames = currentNamesEffective.length > 0 ? currentNamesEffective : currentNamesCatalog;

          const baselineSet = new Set(baselineNames);
          const currentSet = new Set(currentNames);
          const added = currentNames.filter((n) => !baselineSet.has(n));
          const removed = baselineNames.filter((n) => !currentSet.has(n));

          sendJson(res, 200, {
            ok: true,
            baselinePath,
            tracePath,
            baseline: baselineNames,
            current: currentNames,
            added,
            removed,
          });
          return;
        }

        if (url === "/api/sentinel/abort" && req.method === "POST") {
          const body = await readJsonBody(req);
          const wsUrl = String(body.wsUrl ?? "").trim();
          const token = String(body.token ?? "").trim();
          const sessionKey = String(body.sessionKey ?? "").trim();
          if (!wsUrl || !token || !sessionKey) {
            sendJson(res, 400, { ok: false, message: "wsUrl, token, sessionKey가 필요합니다." });
            return;
          }
          const abortPy = path.join(REPO_ROOT, "scripts", "sentinel", "abort.py");
          if (!fs.existsSync(abortPy)) {
            sendJson(res, 500, { ok: false, message: `abort.py not found: ${abortPy}` });
            return;
          }
          const py = pickPython();
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            PYTHONPATH: path.join(REPO_ROOT, "scripts"),
            OPENCLAW_GATEWAY_WS_URL: wsUrl,
            OPENCLAW_GATEWAY_TOKEN: token,
            OPENCLAW_GATEWAY_SESSION_KEY: sessionKey,
          };
          try {
            const { stdout, stderr } = await execFileAsync(py, [abortPy], {
              cwd: REPO_ROOT,
              env,
              maxBuffer: 4 * 1024 * 1024,
              timeout: 30_000,
            });
            const text = String(stdout ?? "").trim();
            let parsed: unknown;
            try {
              parsed = text ? (JSON.parse(text) as unknown) : null;
            } catch {
              parsed = null;
            }
            const gw = parsed as { ok?: boolean; error?: { message?: string } } | null;
            if (gw && gw.ok === false) {
              sendJson(res, 200, {
                ok: false,
                message: gw.error?.message ?? "sessions.abort returned ok:false",
                gateway: parsed,
                stderrTail: String(stderr ?? "").slice(-1200),
              });
              return;
            }
            sendJson(res, 200, { ok: true, gateway: parsed, stderrTail: String(stderr ?? "").slice(-600) });
          } catch (e) {
            const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
            sendJson(res, 500, {
              ok: false,
              message: err.message ?? String(e),
              stderrTail: (err.stderr ?? "").toString().slice(-1200),
            });
          }
          return;
        }

        sendJson(res, 404, { ok: false, message: "unknown sentinel route" });
      });

      return () => killChild();
    },
  };
}
