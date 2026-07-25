import type {
  GameActionEvent,
  GameActionEventListener,
  GameCommand,
  JsonValue,
  Unsubscribe,
} from '@proj-vera/game-coop-core'

export class ActionEvents {
  private readonly listenersBySession = new Map<string, Set<GameActionEventListener>>()

  constructor(private readonly now: () => number) {}

  observe(sessionId: string, listener: GameActionEventListener): Unsubscribe {
    const listeners = this.listenersBySession.get(sessionId) ?? new Set<GameActionEventListener>()
    listeners.add(listener)
    this.listenersBySession.set(sessionId, listeners)

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0)
        this.listenersBySession.delete(sessionId)
    }
  }

  queued(command: GameCommand): void {
    this.emit({ ...this.base(command), state: 'queued' })
  }

  running(command: GameCommand): void {
    this.emit({ ...this.base(command), state: 'running' })
  }

  snapshot(command: GameCommand, snapshot: JsonValue): void {
    this.emit({ ...this.base(command), state: 'snapshot', snapshot })
  }

  succeeded(command: GameCommand, result?: JsonValue): void {
    this.emit({ ...this.base(command), state: 'succeeded', result })
  }

  failed(command: GameCommand, error: string): void {
    this.emit({ ...this.base(command), state: 'failed', error })
  }

  cancelled(command: GameCommand, reason?: string): void {
    this.emit({ ...this.base(command), state: 'cancelled', reason })
  }

  private base(command: GameCommand) {
    return {
      sessionId: command.sessionId,
      turnId: command.turnId,
      actionId: command.actionId,
      capabilityId: command.capabilityId,
      timestamp: this.now(),
    }
  }

  private emit(event: GameActionEvent): void {
    for (const listener of this.listenersBySession.get(event.sessionId) ?? [])
      listener(event)
  }
}
