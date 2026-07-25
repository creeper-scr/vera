/// <reference types="vite/client" />
/// <reference types="../../vite-env.d.ts" />

interface ImportMetaEnv {
  readonly VITE_APP_TARGET_HUGGINGFACE_SPACE: string
  readonly VITE_VERA_WS_URL?: string
  /** Doubao / Volcengine realtime voice App ID (from `.env.play.local`). */
  readonly VITE_VOLCENGINE_APP_ID?: string
  /** Doubao / Volcengine Access Token (from `.env.play.local`). */
  readonly VITE_VOLCENGINE_ACCESS_KEY?: string
  /** Play-env LLM key (mirrored from `OPENAI_API_KEY` in vite define). */
  readonly VITE_OPENAI_API_KEY?: string
  /** Play-env LLM base URL (mirrored from `OPENAI_API_BASEURL`). */
  readonly VITE_OPENAI_API_BASEURL?: string
  /** Play-env consciousness model (mirrored from `OPENAI_MODEL`). */
  readonly VITE_OPENAI_MODEL?: string
  /** Local Doubao realtime relay (`pnpm dev:play`, no hosted Vera auth). */
  readonly VITE_DOUBAO_REALTIME_WS_URL?: string
}
