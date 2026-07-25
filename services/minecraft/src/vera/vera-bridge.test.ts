import { describe, expect, it, vi } from 'vitest'

import { VeraBridge } from './vera-bridge'

function createBridgeHarness() {
  const handlers = new Map<string, (event: any) => void>()
  const client = {
    send: vi.fn(),
    onEvent: vi.fn((type: string, handler: (event: any) => void) => {
      handlers.set(type, handler)
    }),
    offEvent: vi.fn(),
  }
  const eventBus = {
    emit: vi.fn(),
  }
  const bridge = new VeraBridge(client as any, eventBus as any)
  bridge.init()

  return { bridge, eventBus, handlers }
}

describe('veraBridge spark command routing', () => {
  it('routes spark commands as Vera commands instead of chat messages', () => {
    const { bridge, eventBus, handlers } = createBridgeHarness()
    const commandHandler = handlers.get('spark:command')

    expect(commandHandler).toBeDefined()

    commandHandler?.({
      data: {
        commandId: 'spark-1',
        intent: 'action',
        interrupt: false,
        priority: 'normal',
        guidance: {
          options: [
            {
              label: 'collect wood',
              steps: ['find a tree', 'chop it'],
            },
          ],
        },
      },
    })

    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'signal:vera_command',
      payload: expect.objectContaining({
        type: 'vera_command',
        description: 'Directive from Vera: "collect wood"',
        sourceId: 'vera',
        metadata: expect.objectContaining({
          message: 'collect wood',
          sparkCommandId: 'spark-1',
          sparkIntent: 'action',
        }),
      }),
    }))
    expect(eventBus.emit).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'signal:chat_message',
    }))

    bridge.destroy()
  })
})
