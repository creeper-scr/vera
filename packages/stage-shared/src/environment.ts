export enum StageEnvironment {
  Web = 'web',
  Capacitor = 'capacitor',
  /** @deprecated Electron desktop removed; kept for shared UI call-site compatibility. */
  Tamagotchi = 'tamagotchi',
}

/**
 * Build-time dev flag, replaced by Vite as a literal `true`/`false` so the
 * unused branch is tree-shaken in production bundles.
 */
export const IS_DEV: boolean = import.meta.env.DEV

export function isStageWeb(): boolean {
  return !import.meta.env.RUNTIME_ENVIRONMENT || import.meta.env.RUNTIME_ENVIRONMENT === 'browser'
}

export function isStageCapacitor(): boolean {
  return import.meta.env.RUNTIME_ENVIRONMENT === 'capacitor'
}

/**
 * Always false after Electron desktop removal.
 */
export function isStageTamagotchi(): boolean {
  return false
}

export function isUrlMode(mode: 'file' | 'server'): boolean {
  if (!import.meta.env.URL_MODE) {
    return mode === 'server'
  }

  return import.meta.env.URL_MODE === mode
}
