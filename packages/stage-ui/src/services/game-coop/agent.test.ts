import type {
  GameActionEvent,
  GameActionEventListener,
  GameCapability,
  GameExecutionPort,
} from '@proj-vera/game-coop-core'

import type { GameIntentPolicy, GamePermissionPolicy } from './agent'
import type { UserTurn } from './interaction'

import { describe, expect, it, vi } from 'vitest'

import { GameCoopAgent } from './agent'

const capability: GameCapability = {
  capabilityId: 'dynamic.follow',
  description: 'Follow the player',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  risk: 'low',
  cancellable: true,
}

const turn: UserTurn = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  timestamp: 1,
  text: 'follow me',
}

function createHarness(
  resolve: GameIntentPolicy['resolve'],
  selectedCapability: GameCapability = capability,
  permissionPolicy?: GamePermissionPolicy,
) {
  let actionListener: GameActionEventListener | undefined
  const executionPort: GameExecutionPort = {
    getCapabilities: vi.fn(async () => [selectedCapability]),
    observe: vi.fn((_sessionId, listener) => {
      actionListener = listener
      return () => {
        actionListener = undefined
      }
    }),
    execute: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  }
  const intentPolicy: GameIntentPolicy = {
    resolve,
    describeAction: vi.fn(({ event }) =>
      event.state === 'running' ? 'Following now.' : null),
  }
  const agent = new GameCoopAgent({
    executionPort,
    intentPolicy,
    permissionPolicy,
    createActionId: () => 'action-1',
  })

  return {
    agent,
    executionPort,
    intentPolicy,
    emit(event: GameActionEvent) {
      actionListener?.(event)
    },
  }
}

describe('game Coop agent', () => {
  it('passes the dynamic catalog to policy and executes its selected capability', async () => {
    const resolve = vi.fn(async () => ({
      capabilityId: 'dynamic.follow',
      input: { playerName: 'Steve' },
    }))
    const harness = createHarness(resolve)
    harness.agent.start('session-1')

    await expect(harness.agent.handleUserTurn(turn)).resolves.toBe(true)

    expect(resolve).toHaveBeenCalledWith({
      turn,
      capabilities: [capability],
    })
    expect(harness.executionPort.execute).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'turn-1',
      actionId: 'action-1',
      capabilityId: 'dynamic.follow',
      input: { playerName: 'Steve' },
    })
  })

  it('returns false without executing when policy rejects the turn', async () => {
    const harness = createHarness(vi.fn(async () => null))
    harness.agent.start('session-1')

    await expect(harness.agent.handleUserTurn(turn)).resolves.toBe(false)
    expect(harness.executionPort.execute).not.toHaveBeenCalled()
  })

  it('denies medium-risk capabilities when Integration provides no permission policy', async () => {
    const mediumRiskCapability: GameCapability = {
      ...capability,
      risk: 'medium',
    }
    const harness = createHarness(vi.fn(async () => ({
      capabilityId: mediumRiskCapability.capabilityId,
      input: {},
    })), mediumRiskCapability)
    harness.agent.start('session-1')

    await expect(harness.agent.handleUserTurn(turn)).rejects.toThrow(
      'Permission denied for capability "dynamic.follow"',
    )
    expect(harness.executionPort.execute).not.toHaveBeenCalled()
  })

  it('executes a medium-risk capability after Integration authorizes it', async () => {
    const mediumRiskCapability: GameCapability = {
      ...capability,
      risk: 'medium',
    }
    const permissionPolicy: GamePermissionPolicy = {
      authorize: vi.fn(async () => true),
    }
    const harness = createHarness(vi.fn(async () => ({
      capabilityId: mediumRiskCapability.capabilityId,
      input: {},
    })), mediumRiskCapability, permissionPolicy)
    harness.agent.start('session-1')

    await expect(harness.agent.handleUserTurn(turn)).resolves.toBe(true)
    expect(permissionPolicy.authorize).toHaveBeenCalledWith({
      turn,
      capability: mediumRiskCapability,
      command: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        actionId: 'action-1',
        capabilityId: 'dynamic.follow',
        input: {},
      },
    })
    expect(harness.executionPort.execute).toHaveBeenCalledOnce()
  })

  it('converts correlated lifecycle events into agent utterances', async () => {
    const harness = createHarness(vi.fn(async () => ({
      capabilityId: 'dynamic.follow',
      input: {},
    })))
    const listener = vi.fn()
    harness.agent.start('session-1')
    harness.agent.onAgentUtterance(listener)
    await harness.agent.handleUserTurn(turn)

    harness.emit({
      sessionId: 'session-1',
      turnId: 'turn-1',
      actionId: 'action-1',
      capabilityId: 'dynamic.follow',
      timestamp: 2,
      state: 'queued',
    })
    harness.emit({
      sessionId: 'session-1',
      turnId: 'turn-1',
      actionId: 'action-1',
      capabilityId: 'dynamic.follow',
      timestamp: 3,
      state: 'running',
    })

    expect(listener).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'turn-1',
      timestamp: 3,
      text: 'Following now.',
    })
  })

  it('cancels only cancellable actions owned by the requested turn', async () => {
    const harness = createHarness(vi.fn(async () => ({
      capabilityId: 'dynamic.follow',
      input: {},
    })))
    harness.agent.start('session-1')
    await harness.agent.handleUserTurn(turn)

    await harness.agent.cancelTurn('turn-1', 'interrupted')

    expect(harness.executionPort.cancel).toHaveBeenCalledWith('action-1', 'interrupted')
  })

  it('detaches from a stopped voice session without cancelling its game actions', async () => {
    const harness = createHarness(vi.fn(async () => ({
      capabilityId: 'dynamic.follow',
      input: {},
    })))
    harness.agent.start('session-1')
    await harness.agent.handleUserTurn(turn)

    harness.agent.stop()

    expect(harness.executionPort.cancel).not.toHaveBeenCalled()
  })

  it('rejects capability IDs absent from the live catalog', async () => {
    const harness = createHarness(vi.fn(async () => ({
      capabilityId: 'hard-coded.missing',
      input: {},
    })))
    harness.agent.start('session-1')

    await expect(harness.agent.handleUserTurn(turn)).rejects.toThrow(
      'Intent policy selected unavailable capability "hard-coded.missing"',
    )
  })
})
