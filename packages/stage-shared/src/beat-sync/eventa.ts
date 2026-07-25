import type { InvocableEventContext } from '@moeru/eventa'
import type { AnalyserBeatEvent, AnalyserWorkletParameters } from '@nekopaw/tempora'

import type { BeatSyncDetectorState } from './types'

import { createContext as createWebContext, defineInvokeEventa } from '@moeru/eventa'

/**
 * Invoke: toggle beat-sync capture.
 */
export const beatSyncToggleInvokeEventa = defineInvokeEventa<void, boolean>('eventa:invoke:beat-sync:toggle')
/**
 * Invoke: read beat-sync detector state.
 */
export const beatSyncGetStateInvokeEventa = defineInvokeEventa<BeatSyncDetectorState>('eventa:invoke:beat-sync:get-state')
/**
 * Invoke: update analyser worklet parameters.
 */
export const beatSyncUpdateParametersInvokeEventa = defineInvokeEventa<void, Partial<AnalyserWorkletParameters>>('eventa:event:beat-sync:update-parameters')
/**
 * Invoke: read input analyser frequency byte data.
 */
export const beatSyncGetInputByteFrequencyDataInvokeEventa = defineInvokeEventa<Uint8Array<ArrayBuffer>>('eventa:invoke:beat-sync:get-input-byte-frequency-data')

/**
 * Event: beat-sync active-state changed.
 */
export const beatSyncStateChangedInvokeEventa = defineInvokeEventa<void, BeatSyncDetectorState>('eventa:event:beat-sync:state-changed')
/**
 * Event: beat signal emitted.
 */
export const beatSyncBeatSignaledInvokeEventa = defineInvokeEventa<void, AnalyserBeatEvent>('eventa:event:beat-sync:beat-signaled')

/**
 * Create a browser eventa context for beat-sync helpers.
 */
export function createContext(): InvocableEventContext<any, { raw?: any }> {
  return createWebContext()
}
