/**
 * Legacy Electron window shape. Kept as a no-op type guard after Electron removal
 * so shared UI call sites continue to typecheck until they are cleaned up.
 */
export interface ElectronWindow<CustomApi = unknown> {
  electron?: unknown
  platform?: NodeJS.Platform
  api?: CustomApi
}

/**
 * Always false after Electron desktop removal.
 */
export function isElectronWindow<CustomApi = unknown>(_window: Window): _window is (Window & ElectronWindow<CustomApi>) {
  return false
}
