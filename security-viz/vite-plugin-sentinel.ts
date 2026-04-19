import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function defaultTracePath(): string {
  return path.join(REPO_ROOT, "scripts", "sentinel", "data", "trace.jsonl");
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

      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!url.startsWith("/api/sentinel")) {
          next();
          return;
        }

        if (url === "/api/sentinel/status" && req.method === "GET") {
          const trace = traceStat();
          const running = Boolean(child && !child.killed);
          sendJson(res, 200, {
            controlAvailable: true,
            running,
            pid: running && child?.pid ? child.pid : null,
            startedAt,
            uptimeMs: running && startedAt ? Date.now() - startedAt : null,
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

        sendJson(res, 404, { ok: false, message: "unknown sentinel route" });
      });

      return () => killChild();
    },
  };
}
