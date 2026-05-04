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
  const venvUnix = path.join(REPO_ROOT, ".venv", "bin", "python");
  const venvWin = path.join(REPO_ROOT, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(venvUnix)) return venvUnix;
  if (fs.existsSync(venvWin)) return venvWin;
  if (process.platform === "win32") return "python";
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
      { cwd: REPO_ROOT, env: { ...process.env, PYTHONPATH: path.join(REPO_ROOT, "scripts"), PYTHONUTF8: "1" }, maxBuffer: 24 * 1024 * 1024, timeout: 60_000 },
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
            PYTHONUTF8: "1",
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
            PYTHONUTF8: "1",
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
          // S2 실행 전 README를 원본에서 WSL workspace로 복원 (이전 실행에서 모델이 파일을 수정했을 수 있음)
          if (scenarioId === "S2") {
            const srcReadme = path.join(REPO_ROOT, "mock-targets", "readme_s2.md");
            if (fs.existsSync(srcReadme)) {
              try {
                const content = fs.readFileSync(srcReadme, "utf8");
                const wslDest = path.join(
                  os.homedir().replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/mnt/$1").toLowerCase(),
                  ".openclaw", "workspace", "mock-targets", "readme_s2.md"
                );
                const srcWsl = srcReadme.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/mnt/$1").toLowerCase();
                await execFileAsync("wsl", ["bash", "-c", `mkdir -p "$(dirname '${wslDest}')" && cp '${srcWsl}' '${wslDest}'`], { timeout: 10_000 }).catch(() => {});
              } catch { /* silent */ }
            }
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
            PYTHONUTF8: "1",
            OPENCLAW_GATEWAY_WS_URL: wsUrl,
            OPENCLAW_GATEWAY_TOKEN: token,
            OPENCLAW_GATEWAY_SESSION_KEY: sessionKey,
            OPENCLAW_GATEWAY_SCOPES: process.env.OPENCLAW_GATEWAY_SCOPES ?? "operator.admin,operator.write,operator.read",
            OPENCLAW_SCENARIO_MESSAGE: message,
            // S1은 hallucination 방지용 리셋 필요, S2는 S1 tool-calling context를 활용
            OPENCLAW_RESET_SESSION_FIRST: scenarioId === "S1" ? "1" : "0",
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

        // S3 Guardrail toggle: 플래그 파일 존재 = guardrail OFF (Direct 모드).
        // ingest._maybe_auto_abort 가 abort 직전에 이 파일을 검사한다.
        if (url === "/api/sentinel/s3-guardrail" && (req.method === "GET" || req.method === "POST")) {
          const flagPath = path.join(path.dirname(defaultTracePath()), "s3-guardrail-disabled.flag");
          try {
            if (req.method === "POST") {
              const body = await readJsonBody(req);
              const desired = body.enabled;
              if (typeof desired !== "boolean") {
                sendJson(res, 400, { ok: false, message: "body.enabled must be boolean" });
                return;
              }
              if (desired) {
                // Guardrail ON = flag 제거
                if (fs.existsSync(flagPath)) fs.rmSync(flagPath);
              } else {
                // Guardrail OFF = flag 생성
                fs.writeFileSync(
                  flagPath,
                  `# S3 Guardrail disabled at ${new Date().toISOString()}\n` +
                    `# Removing this file (or POST { enabled: true }) re-enables auto-abort.\n`,
                );
              }
            }
            const enabled = !fs.existsSync(flagPath);
            sendJson(res, 200, { ok: true, enabled, flagPath });
          } catch (e) {
            sendJson(res, 500, { ok: false, message: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // S3 verdict: trace.jsonl 의 auto_abort meta + cachedReport 의 s3-* finding을 묶어
        // PASS / BLOCKED / FAIL 중 하나로 판정. 시나리오 흐름 패널의 verdict 뱃지 데이터.
        if (url === "/api/sentinel/s3-verdict" && req.method === "GET") {
          const tp = defaultTracePath();
          // trace.jsonl 의 마지막 auto_abort meta entry 찾기 (역순 스캔)
          let abortPhase: string | null = null;
          let abortOk: boolean | null = null;
          let abortReason: string | null = null;
          let abortAtMs: number | null = null;
          try {
            if (fs.existsSync(tp)) {
              const lines = fs.readFileSync(tp, "utf8").split("\n").filter(Boolean);
              for (let i = lines.length - 1; i >= 0; i--) {
                try {
                  const obj = JSON.parse(lines[i]) as Record<string, unknown>;
                  const aa = obj["auto_abort"];
                  if (aa && typeof aa === "object" && !Array.isArray(aa)) {
                    const a = aa as Record<string, unknown>;
                    abortPhase = typeof a["phase"] === "string" ? (a["phase"] as string) : null;
                    abortOk = typeof a["ok"] === "boolean" ? (a["ok"] as boolean) : null;
                    abortReason = typeof a["reason"] === "string" ? (a["reason"] as string) : null;
                    abortAtMs = typeof obj["ts_ms"] === "number" ? (obj["ts_ms"] as number) : null;
                    break;
                  }
                } catch {
                  /* parse error — skip line */
                }
              }
            }
          } catch {
            /* ignore */
          }

          // S3 finding (severity high+) 가 cachedReport 에 있는지
          const s3HighFindings: Array<{ ruleId: string; severity: string; title?: string }> = [];
          const reportObj =
            cachedReport && typeof cachedReport === "object"
              ? (cachedReport as Record<string, unknown>)
              : {};
          const rawFindings = reportObj["findings"];
          const findings = Array.isArray(rawFindings)
            ? (rawFindings as Array<Record<string, unknown>>)
            : [];
          for (const f of findings) {
            const ruleId = typeof f["ruleId"] === "string" ? (f["ruleId"] as string) : "";
            const severity = typeof f["severity"] === "string" ? (f["severity"] as string) : "";
            if (!ruleId.startsWith("s3-")) continue;
            const rank = severity === "critical" ? 4 : severity === "high" ? 3 : 0;
            if (rank >= 3) {
              s3HighFindings.push({
                ruleId,
                severity,
                title: typeof f["title"] === "string" ? (f["title"] as string) : undefined,
              });
            }
          }

          // verdict 산출
          let verdict: "pass" | "blocked" | "fail" | "pending";
          if (s3HighFindings.length === 0) {
            verdict = "pass"; // 또는 시나리오 미실행 → pending. 별도 상위 조건으로 처리.
          } else if (abortPhase === "result" && abortOk === true) {
            verdict = "blocked";
          } else {
            // finding 발화는 됐는데 abort가 result(ok=true)가 아님 → FAIL
            verdict = "fail";
          }

          sendJson(res, 200, {
            ok: true,
            verdict,
            s3HighFindings,
            autoAbort: {
              phase: abortPhase,
              ok: abortOk,
              reason: abortReason,
              atMs: abortAtMs,
            },
          });
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
            PYTHONUTF8: "1",
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
            PYTHONUTF8: "1",
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
            PYTHONUTF8: "1",
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
