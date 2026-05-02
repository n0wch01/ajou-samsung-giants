"""
OpenClaw gateway WebSocket client (protocol v3 framing used by security-viz).

Frames: {type:"req"|"res"|"event", ...} — see security-viz/src/gateway/protocol.ts

Optional device identity (same shape as OpenClaw CLI ``identity/device.json``) lets
``connect`` include a signed ``device`` block so the gateway keeps ``scopes`` (e.g.
``operator.read``) for ``sessions.messages.subscribe``. Paths: env
``OPENCLAW_DEVICE_IDENTITY_PATH``, then ``$OPENCLAW_STATE_DIR/identity/device.json``,
``~/.openclaw/identity/device.json``, ``~/.clawdbot/identity/device.json``.

If the device was paired with fewer scopes than you request (e.g. paired with
``operator.read`` only but ``OPENCLAW_GATEWAY_SCOPES`` includes ``operator.write``),
the gateway emits ``pairing required`` (scope-upgrade) until you approve the upgrade:
run ``openclaw devices list``, then ``openclaw devices approve <requestId>`` or
``openclaw devices approve --latest`` (same token/URL as the gateway).

WebSocket: by default the client does **not** use the system HTTP proxy (``websockets``
defaults to ``proxy=True``, which breaks loopback pairing when ``HTTP_PROXY`` /
``ALL_PROXY`` is set). Set ``OPENCLAW_GATEWAY_WS_USE_SYSTEM_PROXY=1`` to restore
proxy-based connections.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Coroutine

import websockets
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from websockets.client import WebSocketClientProtocol


def new_req_id() -> str:
    return str(uuid.uuid4())


def _ws_connect_use_system_proxy() -> bool:
    v = os.environ.get("OPENCLAW_GATEWAY_WS_USE_SYSTEM_PROXY", "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _normalize_device_metadata_for_auth(value: str | None) -> str:
    """Match OpenClaw ``normalizeDeviceMetadataForAuth`` (ASCII A–Z only to lower)."""
    if not value or not str(value).strip():
        return ""
    s = str(value).strip()
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


def _build_device_auth_payload_v3(
    *,
    device_id: str,
    client_id: str,
    client_mode: str,
    role: str,
    scopes: list[str],
    signed_at_ms: int,
    token: str,
    nonce: str,
    platform: str,
    device_family: str,
) -> str:
    scopes_csv = ",".join(scopes)
    tok = token or ""
    return "|".join(
        [
            "v3",
            device_id,
            client_id,
            client_mode,
            role,
            scopes_csv,
            str(signed_at_ms),
            tok,
            nonce,
            platform,
            device_family,
        ]
    )


def _public_key_raw_b64url_from_pem(public_key_pem: str) -> str:
    pub = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
    if not isinstance(pub, Ed25519PublicKey):
        raise TypeError("device identity public key must be Ed25519")
    raw = pub.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return _b64url(raw)


def _sign_device_payload(private_key_pem: str, payload: str) -> str:
    key = serialization.load_pem_private_key(
        private_key_pem.encode("utf-8"), password=None
    )
    if not isinstance(key, Ed25519PrivateKey):
        raise TypeError("device identity private key must be Ed25519 PKCS8 PEM")
    sig = key.sign(payload.encode("utf-8"))
    return _b64url(sig)


@dataclass(frozen=True)
class _DeviceIdentityFile:
    device_id: str
    public_key_pem: str
    private_key_pem: str


def _load_device_identity_json(path: Path) -> _DeviceIdentityFile | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict) or raw.get("version") != 1:
        return None
    did = raw.get("deviceId")
    pub = raw.get("publicKeyPem")
    prv = raw.get("privateKeyPem")
    if not isinstance(did, str) or not isinstance(pub, str) or not isinstance(prv, str):
        return None
    if not did.strip() or "BEGIN" not in pub or "BEGIN" not in prv:
        return None
    return _DeviceIdentityFile(device_id=did.strip(), public_key_pem=pub, private_key_pem=prv)


def resolve_device_identity_path(explicit: str | None) -> Path | None:
    """First existing identity file among CLI defaults and env overrides."""
    if explicit and str(explicit).strip():
        p = Path(str(explicit).strip()).expanduser()
        if not p.is_file():
            raise RuntimeError(f"device identity file not found: {p}")
        return p
    env_one = os.environ.get("OPENCLAW_DEVICE_IDENTITY_PATH", "").strip()
    if env_one:
        p = Path(env_one).expanduser()
        if not p.is_file():
            raise RuntimeError(f"OPENCLAW_DEVICE_IDENTITY_PATH is set but file not found: {p}")
        return p
    state = os.environ.get("OPENCLAW_STATE_DIR", "").strip()
    if state:
        p = Path(state) / "identity" / "device.json"
        if p.is_file():
            return p
    for p in (
        Path.home() / ".openclaw" / "identity" / "device.json",
        Path.home() / ".clawdbot" / "identity" / "device.json",
    ):
        if p.is_file():
            return p
    return None


def _format_gateway_connect_failure(err: Any) -> str:
    """Human-readable connect error; includes hints for common gateway cases."""
    if not isinstance(err, dict):
        return str(err)
    base = err.get("message") or err.get("code") or json.dumps(err, ensure_ascii=False)
    details = err.get("details")
    reason: str | None = None
    request_id: str | None = None
    if isinstance(details, dict):
        r = details.get("reason")
        if isinstance(r, str) and r.strip():
            reason = r.strip()
        rid = details.get("requestId")
        if isinstance(rid, str) and rid.strip():
            request_id = rid.strip()
    hints: list[str] = []
    if reason == "scope-upgrade":
        hints.append(
            "scope-upgrade: device is paired with fewer scopes than OPENCLAW_GATEWAY_SCOPES. "
            "Approve the pending request: openclaw devices list, then "
            "openclaw devices approve <requestId> (or openclaw devices approve --latest)."
        )
    elif reason == "role-upgrade":
        hints.append(
            "role-upgrade: approve the device pairing request in OpenClaw, or adjust "
            "the connect role to match the paired device."
        )
    elif reason == "metadata-upgrade":
        hints.append(
            "metadata-upgrade: approve the device pairing request in OpenClaw, or align "
            "OPENCLAW_GATEWAY_DEVICE_FAMILY / platform with the paired device record."
        )
    elif reason == "not-paired":
        hints.append(
            "not-paired: approve device pairing in OpenClaw, or fix loopback/proxy "
            "(see OPENCLAW_GATEWAY_WS_USE_SYSTEM_PROXY) for gateway-client/backend."
        )
    parts = [str(base)]
    if hints:
        parts.append(hints[0])
    if request_id:
        parts.append(f"(requestId={request_id})")
    return " ".join(parts)


def build_device_block_for_connect(
    *,
    identity: _DeviceIdentityFile,
    token: str,
    nonce: str,
    client_id: str,
    client_mode: str,
    role: str,
    scopes: list[str],
    platform_raw: str,
    device_family_raw: str | None,
) -> dict[str, Any]:
    plat_n = _normalize_device_metadata_for_auth(platform_raw)
    fam_n = _normalize_device_metadata_for_auth(device_family_raw)
    signed_at_ms = int(time.time() * 1000)
    payload = _build_device_auth_payload_v3(
        device_id=identity.device_id,
        client_id=client_id,
        client_mode=client_mode,
        role=role,
        scopes=scopes,
        signed_at_ms=signed_at_ms,
        token=token,
        nonce=nonce,
        platform=plat_n,
        device_family=fam_n,
    )
    sig = _sign_device_payload(identity.private_key_pem, payload)
    pub_raw = _public_key_raw_b64url_from_pem(identity.public_key_pem)
    return {
        "id": identity.device_id,
        "publicKey": pub_raw,
        "signature": sig,
        "signedAt": signed_at_ms,
        "nonce": nonce,
    }


def build_connect_frame(
    *,
    token: str,
    client_id: str = "gateway-client",
    client_mode: str = "backend",
    version: str = "0.1.0",
    platform: str | None = None,
    role: str = "operator",
    scopes: list[str] | None = None,
    device: dict[str, Any] | None = None,
    device_family: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """OpenClaw v3 connect params; client.id / client.mode must match gateway enums."""
    rid = new_req_id()
    plat = platform if platform else sys.platform
    client: dict[str, Any] = {
        "id": client_id,
        "version": version,
        "platform": plat,
        "mode": client_mode,
    }
    if device_family and str(device_family).strip():
        client["deviceFamily"] = str(device_family).strip()
    params: dict[str, Any] = {
        "minProtocol": 3,
        "maxProtocol": 3,
        "client": client,
        "role": role,
        "scopes": scopes or ["operator.read"],
        "caps": [],
        "commands": [],
        "permissions": {},
        "auth": {"token": token},
        "locale": "en-US",
        "userAgent": f"{client_id}/{version}",
    }
    if device:
        params["device"] = device
    frame: dict[str, Any] = {"type": "req", "id": rid, "method": "connect", "params": params}
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
        device_identity_path: str | None = None,
    ) -> GwSession:
        # Direct connection by default so localhost peers stay loopback (OpenClaw
        # gateway-client/backend pairing skip). System proxy would tunnel and make
        # the server see a non-loopback address → "pairing required".
        connect_kw: dict[str, Any] = {"max_size": None, "open_timeout": open_timeout_s}
        if "proxy" in inspect.signature(websockets.connect).parameters:
            connect_kw["proxy"] = True if _ws_connect_use_system_proxy() else None
        ws = await websockets.connect(ws_url, **connect_kw)
        nonce = await _recv_connect_challenge_nonce(ws, timeout_s=15.0)
        if not nonce:
            await ws.close()
            raise RuntimeError(
                "Timed out waiting for connect.challenge from gateway "
                "(check OPENCLAW_GATEWAY_WS_URL and gateway version)."
            )
        self = cls(ws=ws)
        self._reader_task = asyncio.create_task(self._reader_loop())
        scope_list = list(scopes or ["operator.read"])
        id_path = resolve_device_identity_path(device_identity_path)
        identity = _load_device_identity_json(id_path) if id_path else None
        device_block: dict[str, Any] | None = None
        dev_fam: str | None = None
        if identity:
            plat = sys.platform
            dev_fam = os.environ.get("OPENCLAW_GATEWAY_DEVICE_FAMILY", "").strip() or None
            device_block = build_device_block_for_connect(
                identity=identity,
                token=token,
                nonce=nonce,
                client_id=client_id,
                client_mode=client_mode,
                role="operator",
                scopes=scope_list,
                platform_raw=plat,
                device_family_raw=dev_fam,
            )
        connect_id, connect_frame = build_connect_frame(
            token=token,
            client_id=client_id,
            client_mode=client_mode,
            scopes=scope_list,
            device=device_block,
            device_family=dev_fam,
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
            msg = _format_gateway_connect_failure(err)
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
