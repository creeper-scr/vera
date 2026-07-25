import type {
  CompanionCancelRequest,
  GameMcpToolCallResult,
  GameMcpToolDescriptor,
  VoiceTurn,
} from '../index'

import { describe, expect, it } from 'vitest'

/**
 * D1 baseline shape locks. These tests freeze correlation and terminal
 * semantics without depending on Minecraft-specific prefixes.
 */
describe('core-agent D1 companion contracts', () => {
  it('requires VoiceTurn correlation metadata for Layer1→Layer2 handoff', () => {
    const turn: VoiceTurn = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      text: '跟着我',
      createdAt: 1_000,
      metadata: {
        source: 'hearing',
        eventId: 'evt-1',
        parentEventId: 'evt-0',
      },
    }

    expect(turn.metadata.source).toBe('hearing')
    expect(turn.metadata.eventId).toBe('evt-1')
    expect(turn.metadata.parentEventId).toBe('evt-0')
  })

  it('projects risk and cancel semantics onto MCP tool descriptors', () => {
    const tool: GameMcpToolDescriptor = {
      name: 'follow',
      description: 'Follow the player',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      risk: 'low',
      cancellable: true,
      capabilityId: 'game.follow',
      adapterId: 'demo',
    }

    expect(tool.risk).toBe('low')
    expect(tool.cancellable).toBe(true)
    expect(tool.capabilityId).toBe('game.follow')
    expect(tool.name).not.toMatch(/^minecraft\./)
  })

  it('distinguishes accepted handles from terminal tool results', () => {
    const accepted: GameMcpToolCallResult = {
      status: 'accepted',
      actionId: 'action-1',
      state: 'queued',
      capabilityId: 'game.follow',
    }
    const terminal: GameMcpToolCallResult = {
      status: 'terminal',
      actionId: 'action-1',
      state: 'succeeded',
      capabilityId: 'game.follow',
      result: { ok: true },
    }

    expect(accepted.status).toBe('accepted')
    expect(terminal.status).toBe('terminal')
    expect(terminal.state).toBe('succeeded')
  })

  it('models barge-in cancel scopes across speech/inference/tool/action', () => {
    const request: CompanionCancelRequest = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      scope: 'turn',
      reason: 'barge-in',
      soft: true,
    }

    expect(request.scope).toBe('turn')
    expect(request.soft).toBe(true)
  })
})
