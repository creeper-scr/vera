import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'

import { createWebConsoleController } from './webConsole'

/**
 * Browser E2E for the web console surface: mount a thin harness that mirrors
 * `pages/index.vue` bindings, drive mic/send via DOM, assert feed + logs.
 */
function mountWebConsoleHarness() {
  let micDeviceEnabled = false
  const askPermission = vi.fn().mockResolvedValue(undefined)
  const startStream = vi.fn().mockResolvedValue(undefined)
  const stopRealtimeVoice = vi.fn().mockResolvedValue(undefined)

  const controller = createWebConsoleController({
    getMicDeviceEnabled: () => micDeviceEnabled,
    setMicDeviceEnabled: (enabled) => {
      micDeviceEnabled = enabled
    },
    askPermission,
    startStream,
    stopRealtimeVoice,
    now: () => 1_700_000_000_000,
  })

  const Harness = defineComponent({
    name: 'WebConsoleBrowserHarness',
    setup() {
      controller.onMountedReady()
      return () => h('div', { 'data-testid': 'web-console' }, [
        h('div', { 'data-testid': 'web-console-voice-phase' }, `voice ${controller.voicePhase.value}`),
        h('button', {
          'type': 'button',
          'data-testid': 'web-console-mic',
          'onClick': () => {
            void controller.toggleMic()
          },
        }, controller.micEnabled.value ? 'Mic On' : 'Mic Off'),
        h('button', {
          'type': 'button',
          'data-testid': 'web-console-interrupt',
          'onClick': () => controller.onInterrupt(),
        }, 'Interrupt'),
        controller.partialTranscript.value
          ? h('p', { 'data-testid': 'web-console-partial' }, `partial: ${controller.partialTranscript.value}`)
          : null,
        h('section', { 'data-testid': 'web-console-conversation' }, [
          controller.feed.value.length === 0
            ? h('p', { 'data-testid': 'web-console-conversation-empty' }, 'No conversation yet.')
            : controller.feed.value.map((item, index) => h('div', {
                'key': `${item.at}-${index}`,
                'data-testid': 'web-console-feed-item',
              }, `${item.role} ${item.text}`)),
        ]),
        h('section', { 'data-testid': 'web-console-logs' }, controller.logs.value.map((item, index) => h('div', {
          'key': `${item.at}-${index}`,
          'data-testid': 'web-console-log-item',
        }, item.message))),
        h('form', {
          'data-testid': 'web-console-text-form',
          'onSubmit': (event: Event) => {
            event.preventDefault()
            controller.sendText()
          },
        }, [
          h('input', {
            'data-testid': 'web-console-text-input',
            'value': controller.textInput.value,
            'onInput': (event: Event) => {
              controller.textInput.value = (event.target as HTMLInputElement).value
            },
          }),
          h('button', { 'type': 'submit', 'data-testid': 'web-console-send' }, 'Send'),
        ]),
        controller.errorText.value
          ? h('p', { 'data-testid': 'web-console-error' }, controller.errorText.value)
          : null,
      ])
    },
  })

  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(Harness)
  app.mount(host)

  return {
    app,
    host,
    controller,
    askPermission,
    startStream,
    stopRealtimeVoice,
    async cleanup() {
      await controller.onUnmountedCleanup()
      app.unmount()
      host.remove()
    },
  }
}

describe('web console browser e2e', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders empty conversation and ready log on mount', async () => {
    const harness = mountWebConsoleHarness()
    await nextTick()

    expect(harness.host.querySelector('[data-testid="web-console"]')).toBeTruthy()
    expect(harness.host.querySelector('[data-testid="web-console-conversation-empty"]')?.textContent).toBe('No conversation yet.')
    expect(harness.host.querySelector('[data-testid="web-console-voice-phase"]')?.textContent).toBe('voice idle')
    expect(harness.controller.logs.value.some(item => item.message === 'console ready')).toBe(true)

    await harness.cleanup()
  })

  it('toggles the microphone from the DOM and shows Doubao feed items', async () => {
    const harness = mountWebConsoleHarness()
    await nextTick()

    const micButton = harness.host.querySelector<HTMLButtonElement>('[data-testid="web-console-mic"]')
    expect(micButton).toBeTruthy()
    micButton?.click()
    await vi.waitFor(() => {
      expect(harness.host.querySelector('[data-testid="web-console-mic"]')?.textContent).toBe('Mic On')
    })

    expect(harness.askPermission).toHaveBeenCalledTimes(1)
    expect(harness.startStream).toHaveBeenCalledTimes(1)
    expect(harness.host.querySelector('[data-testid="web-console-voice-phase"]')?.textContent).toBe('voice listening')

    harness.controller.voiceCallbacks.onUserTranscript('hi')
    await vi.waitFor(() => {
      expect(harness.host.querySelector('[data-testid="web-console-partial"]')?.textContent).toBe('partial: hi')
    })

    harness.controller.voiceCallbacks.onUserTurn({ turnId: 't1', text: 'hi vera' })
    harness.controller.voiceCallbacks.onAssistantText('hello')
    await vi.waitFor(() => {
      const feedItems = [...harness.host.querySelectorAll('[data-testid="web-console-feed-item"]')]
        .map(node => node.textContent?.trim())
      expect(feedItems).toEqual(['user hi vera', 'assistant hello'])
    })

    const logText = [...harness.host.querySelectorAll('[data-testid="web-console-log-item"]')]
      .map(node => node.textContent ?? '')
      .join('\n')
    expect(logText).toContain('microphone: on')
    expect(logText).toContain('user turn: hi vera')
    expect(logText).toContain('assistant: hello')

    await harness.cleanup()
  })

  it('submits debug text into the conversation feed from the form', async () => {
    const harness = mountWebConsoleHarness()
    await nextTick()

    const input = harness.host.querySelector<HTMLInputElement>('[data-testid="web-console-text-input"]')
    expect(input).toBeTruthy()
    if (!input)
      throw new Error('missing text input')

    input.value = 'typed from browser'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    harness.host.querySelector<HTMLFormElement>('[data-testid="web-console-text-form"]')?.requestSubmit()
    await vi.waitFor(() => {
      expect(harness.host.querySelector('[data-testid="web-console-feed-item"]')?.textContent?.trim()).toBe('user typed from browser')
    })
    expect(harness.controller.logs.value.map(item => item.message)).toContain('text: typed from browser')

    await harness.cleanup()
  })
})
