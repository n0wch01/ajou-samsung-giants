"""
Sentinel Ingest - OpenClaw 게이트웨이 WebSocket 구독 및 이벤트 수집

게이트웨이에 WS로 연결하여 session.tool / session.message 이벤트를 수신하고
정규화된 JSONL 형식으로 trace 파일에 기록한다.
디바이스 페어링 인증(Ed25519 서명)을 사용하여 operator 스코프를 획득한다.
"""

import asyncio
import base64
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import websockets
from nacl.signing import SigningKey
from nacl.encoding import RawEncoder


def _load_device_identity(openclaw_dir: Path) -> dict:
    """~/.openclaw/identity/에서 디바이스 ID, 키, 토큰을 로드."""
    device_file = openclaw_dir / "identity" / "device.json"
    auth_file = openclaw_dir / "identity" / "device-auth.json"

    with open(device_file) as f:
        device = json.load(f)
    with open(auth_file) as f:
        auth = json.load(f)

    # PEM에서 Ed25519 raw private key (32바이트) 추출
    pem = device["privateKeyPem"]
    pem_body = "".join(
        line for line in pem.strip().splitlines()
        if not line.startswith("-----")
    )
    der_bytes = base64.b64decode(pem_body)
    # Ed25519 PKCS8 DER: 마지막 32바이트가 raw private key
    raw_private_key = der_bytes[-32:]

    # public key도 PEM에서 추출
    pub_pem = device["publicKeyPem"]
    pub_body = "".join(
        line for line in pub_pem.strip().splitlines()
        if not line.startswith("-----")
    )
    pub_der = base64.b64decode(pub_body)
    raw_public_key = pub_der[-32:]

    # operator 토큰
    operator_token = auth.get("tokens", {}).get("operator", {}).get("token")

    return {
        "deviceId": device["deviceId"],
        "publicKey": base64.urlsafe_b64encode(raw_public_key).rstrip(b"=").decode(),
        "signingKey": SigningKey(raw_private_key, encoder=RawEncoder),
        "deviceToken": operator_token,
    }


def _build_auth_payload_v2(
    device_id: str, client_id: str, client_mode: str,
    role: str, scopes: list[str], signed_at_ms: int,
    token: str, nonce: str,
) -> str:
    """v2 디바이스 인증 페이로드 생성 (게이트웨이 buildDeviceAuthPayload와 동일)."""
    return "|".join([
        "v2",
        device_id,
        client_id,
        client_mode,
        role,
        ",".join(scopes),
        str(signed_at_ms),
        token or "",
        nonce,
    ])


def _sign_payload(signing_key: SigningKey, payload: str) -> str:
    """페이로드에 Ed25519 서명하고 base64url로 인코딩."""
    signed = signing_key.sign(payload.encode(), encoder=RawEncoder)
    return base64.urlsafe_b64encode(signed.signature).rstrip(b"=").decode()


class EventIngest:
    """게이트웨이 WS 이벤트를 수집하여 콜백으로 전달하고 JSONL로 저장."""

    def __init__(self, ws_url: str, auth_token: str, trace_dir: Path,
                 openclaw_dir: Path = None):
        self.ws_url = ws_url
        self.auth_token = auth_token
        self.trace_dir = trace_dir
        self.trace_dir.mkdir(parents=True, exist_ok=True)
        self.openclaw_dir = openclaw_dir or Path.home() / ".openclaw"

        self.ws = None
        self.session_key = None
        self.connected = False
        self._event_callbacks = []
        self._req_id = 0
        self._pending_responses = {}
        self._event_buffer = []

    def on_event(self, callback):
        """이벤트 수신 콜백 등록. callback(normalized_event) 형태."""
        self._event_callbacks.append(callback)

    def _next_req_id(self) -> str:
        self._req_id += 1
        return f"sentinel-{self._req_id}"

    async def _send_req(self, method: str, params: dict = None) -> dict:
        """RPC 요청을 보내고 응답을 대기. 중간에 오는 이벤트는 버퍼에 보관."""
        req_id = self._next_req_id()
        msg = {"type": "req", "id": req_id, "method": method, "params": params or {}}
        await self.ws.send(json.dumps(msg))

        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(self.ws.recv(), timeout=5)
            except asyncio.TimeoutError:
                continue
            data = json.loads(raw)

            if data.get("type") == "res" and data.get("id") == req_id:
                return data

            if data.get("type") == "res":
                rid = data.get("id")
                if rid in self._pending_responses:
                    self._pending_responses.pop(rid).set_result(data)
                continue

            if data.get("type") == "event":
                self._event_buffer.append(data)

        raise TimeoutError(f"RPC '{method}' 응답 타임아웃")

    def _normalize_event(self, raw: dict) -> dict | None:
        """게이트웨이 이벤트를 정규화된 형식으로 변환."""
        event_type = raw.get("event", "")
        payload = raw.get("payload", {})

        if event_type == "session.tool":
            return {
                "kind": "tool_call",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "session_key": payload.get("sessionKey", self.session_key),
                "tool": payload.get("name", payload.get("tool", "unknown")),
                "phase": payload.get("phase", "unknown"),
                "args": payload.get("input", payload.get("args", {})),
                "is_error": payload.get("isError", False),
                "raw_event": event_type,
            }
        elif event_type == "session.message":
            return {
                "kind": "message",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "session_key": payload.get("sessionKey", self.session_key),
                "role": payload.get("role", "unknown"),
                "content_preview": str(payload.get("text", payload.get("content", "")))[:200],
                "raw_event": event_type,
            }
        elif event_type == "sessions.changed":
            return {
                "kind": "session_changed",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "raw_event": event_type,
            }
        return None

    def _append_trace(self, event: dict):
        """이벤트를 JSONL trace 파일에 기록."""
        trace_file = self.trace_dir / f"trace-{datetime.now().strftime('%Y%m%d')}.jsonl"
        with open(trace_file, "a") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")

    async def connect(self):
        """게이트웨이에 디바이스 페어링 인증으로 WS 연결."""
        # 디바이스 identity 로드
        device_info = _load_device_identity(self.openclaw_dir)
        print(f"[ingest] 디바이스 ID: {device_info['deviceId'][:16]}...")

        self.ws = await websockets.connect(self.ws_url)

        # 1) connect.challenge 수신
        challenge_raw = await asyncio.wait_for(self.ws.recv(), timeout=10)
        challenge = json.loads(challenge_raw)
        challenge_payload = challenge.get("payload", {})
        nonce = challenge_payload.get("nonce", "")
        ts = challenge_payload.get("ts", int(time.time() * 1000))
        print(f"[ingest] challenge 수신 (nonce: {nonce[:16]}...)")

        # 2) 인증 파라미터 준비
        client_id = "cli"
        client_mode = "cli"
        role = "operator"
        scopes = [
            "operator.read",
            "operator.write",
            "operator.admin",
            "operator.approvals",
        ]
        signed_at_ms = int(time.time() * 1000)  # 현재 시각 (ms)
        device_token = device_info["deviceToken"] or ""

        # 3) v2 서명 페이로드 생성 및 서명
        # resolveSignatureToken: auth.token ?? auth.deviceToken 순서로 참조
        # deviceToken만 보낼 때는 서명 token에 deviceToken을 사용
        payload = _build_auth_payload_v2(
            device_id=device_info["deviceId"],
            client_id=client_id,
            client_mode=client_mode,
            role=role,
            scopes=scopes,
            signed_at_ms=signed_at_ms,
            token=device_token,
            nonce=nonce,
        )
        signature = _sign_payload(device_info["signingKey"], payload)

        # 4) connect 요청 (디바이스 identity + 서명 + deviceToken)
        connect_req = {
            "type": "req",
            "id": self._next_req_id(),
            "method": "connect",
            "params": {
                "minProtocol": 3,
                "maxProtocol": 3,
                "client": {
                    "id": client_id,
                    "version": "2026.3.13",
                    "platform": "linux",
                    "mode": client_mode,
                },
                "role": role,
                "scopes": scopes,
                "caps": ["tool-events"],
                "commands": [],
                "permissions": {},
                "auth": {
                    "deviceToken": device_token,
                },
                "locale": "ko-KR",
                "userAgent": "sentinel/0.1.0",
                "device": {
                    "id": device_info["deviceId"],
                    "publicKey": device_info["publicKey"],
                    "signature": signature,
                    "signedAt": signed_at_ms,
                    "nonce": nonce,
                },
            },
        }
        await self.ws.send(json.dumps(connect_req))

        # 4) hello-ok 응답 대기
        hello_raw = await asyncio.wait_for(self.ws.recv(), timeout=10)
        hello = json.loads(hello_raw)
        if hello.get("ok"):
            self.connected = True
            auth_info = hello.get("payload", {}).get("auth", {})
            scopes = auth_info.get("scopes", [])
            print(f"[ingest] 게이트웨이 연결 성공 (scopes: {scopes})")
        else:
            raise ConnectionError(f"연결 실패: {hello}")

    async def subscribe_session(self, session_key: str):
        """특정 세션의 이벤트 수신 준비. tool-events cap으로 이벤트를 수신."""
        self.session_key = session_key
        # connect 시 caps: ["tool-events"]를 이미 선언했으므로
        # 게이트웨이가 chat/agent 이벤트를 자동으로 브로드캐스트함
        print(f"[ingest] 세션 모니터링 시작: {session_key}")

    async def listen(self):
        """이벤트 수신 루프."""
        print("[ingest] 이벤트 수신 대기 중...")

        for buffered in self._event_buffer:
            normalized = self._normalize_event(buffered)
            if normalized:
                self._append_trace(normalized)
                for cb in self._event_callbacks:
                    cb(normalized)
        self._event_buffer.clear()

        async for raw_msg in self.ws:
            try:
                data = json.loads(raw_msg)
            except json.JSONDecodeError:
                continue

            if data.get("type") == "res":
                req_id = data.get("id")
                if req_id in self._pending_responses:
                    self._pending_responses.pop(req_id).set_result(data)
                continue

            if data.get("type") == "event":
                normalized = self._normalize_event(data)
                if normalized:
                    self._append_trace(normalized)
                    for cb in self._event_callbacks:
                        cb(normalized)

    async def close(self):
        if self.ws:
            await self.ws.close()
            print("[ingest] WS 연결 종료")
