import { describe, expect, it, vi } from 'vitest'

import { appendLogEntry, createWebConsoleController } from './webConsole'

function createDeps(overrides: Partial<Parameters<typeof createWebConsoleController>[0]> = {}) {
  let micDeviceEnabled = false
  return {
    getMicDeviceEnabled: () => micDeviceEnabled,
    setMicDeviceEnabled: (enabled: boolean) => {
      micDeviceEnabled = enabled
    },
    askPermission: vi.fn().mockResolvedValue(undefined),
    startStream: vi.fn().mockResolvedValue(undefined),
    stopRealtimeVoice: vi.fn().mockResolvedValue(undefined),
    now: () => 1_700_000_000_000,
    logLimit: 3,
    ...overrides,
  }
}

describe('appendLogEntry', () => {
  it('keeps entries under the log limit', () => {
    expect(appendLogEntry([], { level: 'info', message: 'a', at: 1 }, 3)).toEqual([
      { level: 'info', message: 'a', at: 1 },
    ])
  })

  it('drops the oldest entries when the ring buffer overflows', () => {
    const logs = [
      { level: 'info' as const, message: 'a', at: 1 },
      { level: 'info' as const, message: 'b', at: 2 },
      { level: 'info' as const, message: 'c', at: 3 },
    ]

    expect(appendLogEntry(logs, { level: 'error', message: 'd', at: 4 }, 3)).toEqual([
      { level: 'info', message: 'b', at: 2 },
      { level: 'info', message: 'c', at: 3 },
      { level: 'error', message: 'd', at: 4 },
    ])
  })
})

describe('createWebConsoleController', () => {
  it('appends trimmed text into the conversation feed and logs', () => {
    const controller = createWebConsoleController(createDeps())
    controller.textInput.value = '  hello  '
    controller.sendText()

    expect(controller.textInput.value).toBe('')
    expect(controller.feed.value).toEqual([
      { role: 'user', text: 'hello', at: 1_700_000_000_000 },
    ])
    expect(controller.logs.value.map(item => item.message)).toContain('text: hello')
  })

  it('ignores blank text submissions', () => {
    const controller = createWebConsoleController(createDeps())
    controller.textInput.value = '   '
    controller.sendText()

    expect(controller.feed.value).toEqual([])
    expect(controller.logs.value).toEqual([])
  })

  it('turns the microphone on through permission and stream ports', async () => {
    const deps = createDeps({ logLimit: 20 })
    const controller = createWebConsoleController(deps)

    await controller.toggleMic()

    expect(deps.askPermission).toHaveBeenCalledTimes(1)
    expect(deps.startStream).toHaveBeenCalledTimes(1)
    expect(deps.getMicDeviceEnabled()).toBe(true)
    expect(controller.micEnabled.value).toBe(true)
    expect(controller.voicePhase.value).toBe('listening')
    expect(controller.logs.value.map(item => item.message)).toEqual([
      'voice phase: idle → connecting',
      'microphone: requesting permission',
      'voice phase: connecting → listening',
      'microphone: on',
    ])
  })

  it('turns the microphone off and stops realtime voice', async () => {
    const deps = createDeps()
    deps.setMicDeviceEnabled(true)
    const controller = createWebConsoleController(deps)
    controller.micEnabled.value = true
    controller.voicePhase.value = 'listening'

    await controller.toggleMic()

    expect(deps.stopRealtimeVoice).toHaveBeenCalledTimes(1)
    expect(deps.getMicDeviceEnabled()).toBe(false)
    expect(controller.micEnabled.value).toBe(false)
    expect(controller.voicePhase.value).toBe('idle')
    expect(controller.logs.value.map(item => item.message)).toContain('microphone: off')
  })

  it('records microphone failures and forces the error phase', async () => {
    const deps = createDeps({
      askPermission: vi.fn().mockRejectedValue(new Error('permission denied')),
    })
    const controller = createWebConsoleController(deps)

    await controller.toggleMic()

    expect(controller.errorText.value).toBe('permission denied')
    expect(controller.micEnabled.value).toBe(false)
    expect(controller.voicePhase.value).toBe('error')
    expect(controller.logs.value.some(item => item.level === 'error' && item.message === 'permission denied')).toBe(true)
  })

  it('records Doubao user and assistant turns into the feed', () => {
    const controller = createWebConsoleController(createDeps())
    controller.micEnabled.value = true
    controller.voicePhase.value = 'listening'

    controller.voiceCallbacks.onUserTranscript('hel')
    expect(controller.partialTranscript.value).toBe('hel')

    controller.voiceCallbacks.onUserTurn({ turnId: 't1', text: 'hello' })
    controller.voiceCallbacks.onAssistantText('hi there')

    expect(controller.partialTranscript.value).toBe('')
    expect(controller.feed.value).toEqual([
      { role: 'user', text: 'hello', at: 1_700_000_000_000 },
      { role: 'assistant', text: 'hi there', at: 1_700_000_000_000 },
    ])
    expect(controller.voicePhase.value).toBe('speaking')
  })

  it('disables the microphone when Doubao reports an error', () => {
    const deps = createDeps()
    deps.setMicDeviceEnabled(true)
    const controller = createWebConsoleController(deps)
    controller.micEnabled.value = true

    controller.voiceCallbacks.onError('doubao down')

    expect(deps.getMicDeviceEnabled()).toBe(false)
    expect(controller.micEnabled.value).toBe(false)
    expect(controller.voicePhase.value).toBe('error')
    expect(controller.errorText.value).toBe('doubao down')
  })

  it('returns to listening on interrupt while the mic stays on', () => {
    const controller = createWebConsoleController(createDeps())
    controller.micEnabled.value = true
    controller.voicePhase.value = 'speaking'

    controller.onInterrupt()

    expect(controller.voicePhase.value).toBe('listening')
    expect(controller.logs.value.map(item => item.message)).toContain('interrupt')
  })
})
