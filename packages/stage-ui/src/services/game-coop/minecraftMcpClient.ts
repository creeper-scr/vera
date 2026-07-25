import type {
  GameEnvironmentSnapshot as AdapterEnvironmentSnapshot,
  GameActionEventListener,
  GameCapability,
  GameCommand,
  GameExecutionPort,
  GameObservationListener,
  Unsubscribe,
} from '@proj-vera/game-coop-core'

import type { GameMcpClient } from './gameMcpClient'

import { nanoid } from 'nanoid'

import { createGameMcpClient } from './gameMcpClient'

const MINECRAFT_CAPABILITY_PREFIX = 'minecraft.'
const MINECRAFT_STATUS_CAPABILITY = 'minecraft.status'
const DEFAULT_ENVIRONMENT_TIMEOUT_MS = 5_000

export interface MinecraftMcpClientOptions {
  executionPort: GameExecutionPort
  createActionId?: () => string
  now?: () => number
  /** @default 5_000 */
  environmentFreshnessMs?: number
  /** @default 5_000 */
  environmentTimeoutMs?: number
}

export interface MinecraftMcpClient extends GameMcpClient {}

/**
 * @deprecated Use {@link createGameMcpClient} directly. This wrapper keeps the
 * legacy Minecraft surface: it narrows the catalog to `minecraft.*` and
 * synthesizes environment reads through the legacy `minecraft.status`
 * capability when the adapter lacks `getEnvironment`.
 */
export function createMinecraftMcpClient(options: MinecraftMcpClientOptions): MinecraftMcpClient {
  const now = options.now ?? Date.now
  const executionPort = new MinecraftLegacyExecutionPort(options, now)
  return createGameMcpClient({
    ...options,
    executionPort,
    onDispose: () => executionPort.dispose(),
  })
}

/**
 * Narrows the catalog to minecraft.* and synthesizes environment reads through
 * the legacy minecraft.status capability when the adapter lacks
 * getEnvironment. Freshness mirrors the legacy client: 0 when the status
 * capability is absent, the configured freshness after a successful read.
 */
class MinecraftLegacyExecutionPort implements GameExecutionPort {
  private readonly disposedController = new AbortController()

  constructor(
    private readonly options: MinecraftMcpClientOptions,
    private readonly now: () => number,
  ) {}

  /** Fails every in-flight status-tool environment read and detaches its observer. */
  public dispose(): void {
    this.disposedController.abort()
  }

  public async getCapabilities(sessionId: string): Promise<GameCapability[]> {
    const capabilities = await this.options.executionPort.getCapabilities(sessionId)
    return capabilities.filter(capability =>
      capability.capabilityId.startsWith(MINECRAFT_CAPABILITY_PREFIX)
      && capability.capabilityId !== MINECRAFT_STATUS_CAPABILITY,
    )
  }

  public observe(sessionId: string, listener: GameActionEventListener): Unsubscribe {
    return this.options.executionPort.observe(sessionId, listener)
  }

  public observeWorld(sessionId: string, listener: GameObservationListener): Unsubscribe {
    if (this.options.executionPort.observeWorld == null)
      return () => {}
    return this.options.executionPort.observeWorld(sessionId, listener)
  }

  public getEnvironment(sessionId: string): Promise<AdapterEnvironmentSnapshot> {
    if (this.options.executionPort.getEnvironment != null)
      return this.options.executionPort.getEnvironment(sessionId)
    return this.readStatusEnvironment(sessionId)
  }

  public async execute(command: GameCommand): Promise<void> {
    await this.options.executionPort.execute(command)
  }

  public async cancel(actionId: string, reason?: string): Promise<void> {
    await this.options.executionPort.cancel(actionId, reason)
  }

  private async readStatusEnvironment(sessionId: string): Promise<AdapterEnvironmentSnapshot> {
    const freshnessMs = this.options.environmentFreshnessMs ?? 5_000
    const timeoutMs = this.options.environmentTimeoutMs ?? DEFAULT_ENVIRONMENT_TIMEOUT_MS
    const capabilities = await this.options.executionPort.getCapabilities(sessionId)
    if (!capabilities.some(capability => capability.capabilityId === MINECRAFT_STATUS_CAPABILITY)) {
      return {
        sessionId,
        adapterId: 'minecraft',
        revision: 'unavailable',
        observedAt: this.now(),
        freshnessMs: 0,
        content: { available: false, game: 'minecraft' },
      }
    }

    const createActionId = this.options.createActionId ?? (() => nanoid())
    const actionId = createActionId()
    const command: GameCommand = {
      sessionId,
      turnId: `environment:${actionId}`,
      actionId,
      capabilityId: MINECRAFT_STATUS_CAPABILITY,
      input: {},
    }

    return new Promise<AdapterEnvironmentSnapshot>((resolve, reject) => {
      let latestSnapshot: unknown
      let observedAt = this.now()
      let settled = false
      let unsubscribe: Unsubscribe = () => {}
      let timeout: ReturnType<typeof setTimeout> | undefined
      let disposeAbort: () => void = () => {}
      // NOTICE: Legacy status-tool environment path must detach observers on
      // outer client dispose; the generic getEnvironment path never lands here.

      const finish = (result?: AdapterEnvironmentSnapshot, error?: unknown) => {
        if (settled)
          return
        settled = true
        if (timeout != null)
          clearTimeout(timeout)
        this.disposedController.signal.removeEventListener('abort', disposeAbort)
        unsubscribe()
        if (error != null)
          reject(error)
        else
          resolve(result!)
      }

      disposeAbort = () => finish(undefined, new Error('Minecraft MCP client is disposed'))

      timeout = setTimeout(() => {
        finish(undefined, new Error('Timed out waiting for Minecraft environment snapshot'))
      }, timeoutMs)

      this.disposedController.signal.addEventListener('abort', disposeAbort, { once: true })

      unsubscribe = this.options.executionPort.observe(sessionId, (event) => {
        if (
          event.sessionId !== command.sessionId
          || event.turnId !== command.turnId
          || event.actionId !== command.actionId
          || event.capabilityId !== command.capabilityId
        ) {
          return
        }
        if (event.state === 'snapshot') {
          latestSnapshot = event.snapshot
          observedAt = event.timestamp
          return
        }
        if (event.state === 'succeeded') {
          const snapshot = event.result ?? latestSnapshot
          if (snapshot == null) {
            finish(undefined, new Error('Minecraft status succeeded without a snapshot'))
            return
          }
          finish({
            sessionId,
            adapterId: 'minecraft',
            revision: `status:${observedAt}`,
            observedAt,
            freshnessMs,
            content: snapshot as AdapterEnvironmentSnapshot['content'],
          })
          return
        }
        if (event.state === 'failed') {
          finish(undefined, new Error(event.error))
          return
        }
        if (event.state === 'cancelled')
          finish(undefined, new Error(event.reason ?? 'Minecraft status was cancelled'))
      })

      void this.options.executionPort.execute(command).catch(error => finish(undefined, error))
    })
  }
}
