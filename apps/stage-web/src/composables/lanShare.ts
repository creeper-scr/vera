import type { ChatSessionsExport } from '@proj-vera/stage-ui/types/chat-session'

/** Response shape from `GET /lan/info`. */
export interface LanShareInfo {
  port: number
  ips: string[]
  https?: boolean
  hasExport: boolean
  updatedAt: number | null
  mobilePaths: string[]
  exportPaths: string[]
  doubaoRelayPort: number
  doubaoWsPath?: string
}

/**
 * Publishes a chat-sessions export to the Vite LAN middleware.
 */
export async function publishLanChatExport(payload: ChatSessionsExport): Promise<{
  ok: boolean
  updatedAt: number
  bytes: number
}> {
  const response = await fetch('/lan/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error || `publish failed (${response.status})`)
  }
  return await response.json() as { ok: boolean, updatedAt: number, bytes: number }
}

/**
 * Reads LAN URLs / QR targets from the Vite middleware.
 */
export async function fetchLanShareInfo(): Promise<LanShareInfo> {
  const response = await fetch('/lan/info', { cache: 'no-store' })
  if (!response.ok)
    throw new Error(`lan info failed (${response.status})`)
  return await response.json() as LanShareInfo
}

/**
 * Builds a QR image URL for a LAN mobile page (no local QR dependency).
 */
export function lanQrImageUrl(mobileUrl: string, size = 220): string {
  const params = new URLSearchParams({
    size: `${size}x${size}`,
    data: mobileUrl,
  })
  return `https://api.qrserver.com/v1/create-qr-code/?${params.toString()}`
}
