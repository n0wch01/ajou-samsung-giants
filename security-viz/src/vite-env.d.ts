/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SENTINEL_SSE?: string;
  /** Set by run-viz.sh from OPENCLAW_GATEWAY_WS_URL (no secrets). */
  readonly VITE_SG_GATEWAY_WS_URL?: string;
  /** Set by run-viz.sh from OPENCLAW_GATEWAY_SESSION_KEY (no secrets). */
  readonly VITE_SG_SESSION_KEY?: string;
  /** 기본 chat.send. 팀 게이트웨이 RPC 이름이 다르면 설정 */
  readonly VITE_SG_CHAT_METHOD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
