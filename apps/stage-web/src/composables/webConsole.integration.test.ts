import { describe, expect, it, vi } from 'vitest'

import { createWebConsoleController } from './webConsole'

/**
 * Integration: mic ports + Doubao callbacks + feed/logs share one controller.
 * No Pinia / network — only the console orchestration boundary.
 */
describe('web console integration', () => {
  it('runs mic on → Doubao turns → mic off with a coherent feed and log trail', async () => {
    let micDeviceEnabled = false
    let clock = 1_000
    const askPermission = vi.fn(async () => {
      clock += 1
    })
    const startStream = vi.fn(async () => {
      clock += 1
    })
    const stopRealtimeVoice = vi.fn(async () => {
      clock += 1
    })

    const controller = createWebConsoleController({
      getMicDeviceEnabled: () => micDeviceEnabled,
      setMicDeviceEnabled: (enabled) => {
        micDeviceEnabled = enabled
      },
      askPermission,
      startStream,
      stopRealtimeVoice,
      now: () => clock,
      logLimit: 50,
    })

    controller.onMountedReady()
    expect(controller.logs.value.at(-1)?.message).toBe('console ready')
    expect(controller.voicePhase.value).toBe('idle')

    await controller.toggleMic()
    expect(askPermission).toHaveBeenCalledTimes(1)
    expect(startStream).toHaveBeenCalledTimes(1)
    expect(micDeviceEnabled).toBe(true)
    expect(controller.micEnabled.value).toBe(true)
    expect(controller.voicePhase.value).toBe('listening')

    controller.voiceCallbacks.onUserTranscript('go')
    expect(controller.partialTranscript.value).toBe('go')

    controller.voiceCallbacks.onUserTurn({ turnId: 'turn-1', text: 'go left' })
    controller.voiceCallbacks.onAssistantText('moving left')
    controller.onInterrupt()

    expect(controller.feed.value).toEqual([
      { role: 'user', text: 'go left', at: expect.any(Number) },
      { role: 'assistant', text: 'moving left', at: expect.any(Number) },
    ])
    expect(controller.partialTranscript.value).toBe('')
    expect(controller.voicePhase.value).toBe('listening')

    controller.textInput.value = 'typed note'
    controller.sendText()
    expect(controller.feed.value.at(-1)).toEqual({
      role: 'user',
      text: 'typed note',
      at: expect.any(Number),
    })

    await controller.toggleMic()
    expect(stopRealtimeVoice).toHaveBeenCalledTimes(1)
    expect(micDeviceEnabled).toBe(false)
    expect(controller.micEnabled.value).toBe(false)
    expect(controller.voicePhase.value).toBe('idle')

    const messages = controller.logs.value.map(item => item.message)
    expect(messages).toContain('microphone: on')
    expect(messages).toContain('user turn: go left')
    expect(messages).toContain('assistant: moving left')
    expect(messages).toContain('interrupt')
    expect(messages).toContain('text: typed note')
    expect(messages).toContain('microphone: off')
  })

  it('keeps dispose idempotent after a Doubao error forced mic off', async () => {
    let micDeviceEnabled = true
    const stopRealtimeVoice = vi.fn().mockResolvedValue(undefined)
    const controller = createWebConsoleController({
      getMicDeviceEnabled: () => micDeviceEnabled,
      setMicDeviceEnabled: (enabled) => {
        micDeviceEnabled = enabled
      },
      askPermission: vi.fn(),
      startStream: vi.fn(),
      stopRealtimeVoice,
      now: () => 42,
    })
    controller.micEnabled.value = true
    controller.voicePhase.value = 'listening'

    controller.voiceCallbacks.onError('upstream closed')
    expect(micDeviceEnabled).toBe(false)
    expect(controller.voicePhase.value).toBe('error')

    await controller.onUnmountedCleanup()
    expect(stopRealtimeVoice).toHaveBeenCalledTimes(1)
    expect(controller.micEnabled.value).toBe(false)
  })
})
