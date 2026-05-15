#!/usr/bin/env python3
"""
Dev-only HTTP server for security-viz: serves Sentinel findings on port 8787.

Endpoints:
  GET /findings          — JSON from data/findings-latest.json (or {"findings":[]})
  GET /findings/stream   — SSE; re-reads file periodically when clients use SSE

No third-party deps (stdlib only). Not for production.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from typing import Any
from urllib.parse import urlparse

SENTINEL_DIR = Path(__file__).resolve().parent


def _findings_file() -> Path:
    return SENTINEL_DIR / "data" / "findings-latest.json"


def _load_body() -> tuple[bytes, str]:
    """Return (body bytes, etag-ish fingerprint)."""
    p = _findings_file()
    if not p.is_file():
        raw = json.dumps({"findings": []}, ensure_ascii=False).encode("utf-8")
        return raw, "empty"
    try:
        text = p.read_text(encoding="utf-8")
        data = json.loads(text)
    except (OSError, json.JSONDecodeError):
        raw = json.dumps({"findings": []}, ensure_ascii=False).encode("utf-8")
        return raw, "invalid"
    if isinstance(data, list):
        payload: dict[str, Any] = {"findings": data}
    elif isinstance(data, dict) and "findings" in data:
        payload = data
    else:
        payload = {"findings": []}
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return raw, str(len(raw)) + ":" + str(hash(text) & 0xFFFFFFFF)


class _Handler(BaseHTTPRequestHandler):
    server_version = "SG-FindingsDev/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path == "/findings":
            body, _ = _load_body()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/findings/stream":
            self._sse_stream()
            return
        if path in ("/", "/health"):
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"ok findings dev server\n")
            return
        self.send_error(404, "Not Found")

    def _sse_stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        last_fp: str | None = None
        try:
            while True:
                body, fp = _load_body()
                if fp != last_fp:
                    last_fp = fp
                    line = "data: " + body.decode("utf-8") + "\n\n"
                    self.wfile.write(line.encode("utf-8"))
                    self.wfile.flush()
                # keepalive comment so proxies do not drop idle connections
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                time.sleep(2.0)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def main() -> int:
    ap = argparse.ArgumentParser(description="Findings JSON + SSE for security-viz dev.")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    args = ap.parse_args()
    httpd = ThreadedHTTPServer((args.host, args.port), _Handler)
    print(
        f"[findings-dev-server] http://{args.host}:{args.port}/findings "
        f"(file: {_findings_file()})",
        file=sys.stderr,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[findings-dev-server] stopped", file=sys.stderr)
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
