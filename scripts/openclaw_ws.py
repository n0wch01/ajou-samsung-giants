"""
OpenClaw gateway WebSocket client (protocol v3 framing used by security-viz).

Frames: {type:"req"|"res"|"event", ...} — see security-viz/src/gateway/protocol.ts
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine

import websockets
from websockets.client import WebSocketClientProtocol


def new_req_id() -> str:
    return str(uuid.uuid4())


def build_connect_frame(
    *,
    token: str,
    client_id: str = "gateway-client",
    client_mode: str = "backend",
    version: str = "0.1.0",
    platform: str | None = None,
    role: str = "operator",
    scopes: list[str] | None = None,
) -> tuple[str, dict[str, Any]]:
    """OpenClaw v3 connect params; client.id / client.mode must match gateway enums."""
    rid = new_req_id()
    plat = platform if platform else sys.platform
    frame: dict[str, Any] = {
        "type": "req",
        "id": rid,
        "method": "connect",
        "params": {
            "minProtocol": 3,
            "maxProtocol": 3,
            "client": {
                "id": client_id,
                "version": version,
                "platform": plat,
                "mode": client_mode,
            },
            "role": role,
            "scopes": scopes or ["operator.read"],
            "caps": [],
            "commands": [],
            "permissions": {},
            "auth": {"token": token},
            "locale": "en-US",
            "userAgent": f"{client_id}/{version}",
        },
    }
    return rid, frame


async def _recv_connect_challenge_nonce(ws: WebSocketClientProtocol, *, timeout_s: float = 15.0) -> str | None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.05, min(2.0, remaining)))
        except asyncio.TimeoutError:
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(msg, dict):
            continue
        if msg.get("type") != "event" or msg.get("event") != "connect.challenge":
            continue
        payload = msg.get("payload")
        if isinstance(payload, dict):
            n = payload.get("nonce")
            if isinstance(n, str) and n.strip():
                return n.strip()
    return None


def is_hello_ok(payload: Any) -> bool:
    return isinstance(payload, dict) and payload.get("type") == "hello-ok"


@dataclass
class GwSession:
    ws: WebSocketClientProtocol
    _pending: dict[str, asyncio.Future[dict[str, Any]]] = field(default_factory=dict)
    _reader_task: asyncio.Task[None] | None = None
    _event_handlers: list[Callable[[dict[str, Any]], Coroutine[Any, Any, None]]] = field(
        default_factory=list
    )

    @classmethod
    async def connect(
        cls,
        ws_url: str,
        *,
        token: str,
        client_id: str = "gateway-client",
        client_mode: str = "backend",
        scopes: list[str] | None = None,
        open_timeout_s: float = 30.0,
    ) -> GwSession:
        ws = await websockets.connect(ws_url, max_size=None, open_timeout=open_timeout_s)
        nonce = await _recv_connect_challenge_nonce(ws, timeout_s=15.0)
        if not nonce:
            await ws.close()
            raise RuntimeError(
                "Timed out waiting for connect.challenge from gateway "
                "(check OPENCLAW_GATEWAY_WS_URL and gateway version)."
            )
        self = cls(ws=ws)
        self._reader_task = asyncio.create_task(self._reader_loop())
        connect_id, connect_frame = build_connect_frame(
            token=token, client_id=client_id, client_mode=client_mode, scopes=scopes
        )
        connect_fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[connect_id] = connect_fut
        try:
            await self.ws.send(json.dumps(connect_frame))
            res = await asyncio.wait_for(connect_fut, timeout=60.0)
        finally:
            self._pending.pop(connect_id, None)
        if not res.get("ok"):
            err = res.get("error") or {}
            msg = err.get("message") or err.get("code") or json.dumps(err)
            await self.close()
            raise RuntimeError(f"connect failed: {msg}")
        if not is_hello_ok(res.get("payload")):
            await self.close()
            raise RuntimeError(f"connect unexpected payload: {res.get('payload')!r}")
        return self

    def on_event(self, fn: Callable[[dict[str, Any]], Coroutine[Any, Any, None]]) -> None:
        self._event_handlers.append(fn)

    async def close(self) -> None:
        if self._reader_task:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass
            self._reader_task = None
        await self.ws.close()

    async def _reader_loop(self) -> None:
        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(msg, dict):
                    continue
                t = msg.get("type")
                if t == "res":
                    rid = msg.get("id")
                    if isinstance(rid, str) and rid in self._pending:
                        fut = self._pending.pop(rid)
                        if not fut.done():
                            fut.set_result(msg)
                    continue
                if t == "event":
                    for h in list(self._event_handlers):
                        try:
                            await h(msg)
                        except Exception:
                            # Observability client must not die on handler errors
                            pass
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        finally:
            err = ConnectionError("gateway WebSocket closed")
            for _rid, fut in list(self._pending.items()):
                if not fut.done():
                    fut.set_exception(err)
            self._pending.clear()

    async def rpc(self, method: str, params: dict[str, Any] | None = None, *, timeout_s: float = 60.0):
        rid = new_req_id()
        frame: dict[str, Any] = {"type": "req", "id": rid, "method": method, "params": params or {}}
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            await self.ws.send(json.dumps(frame))
            return await asyncio.wait_for(fut, timeout=timeout_s)
        finally:
            self._pending.pop(rid, None)


def parse_scopes_env(raw: str | None, default: list[str]) -> list[str]:
    if not raw or not raw.strip():
        return default
    return [s.strip() for s in raw.split(",") if s.strip()]


def wall_time_ms() -> int:
    """Wall-clock ms for JSONL timestamps (not monotonic)."""
    return int(time.time() * 1000)
