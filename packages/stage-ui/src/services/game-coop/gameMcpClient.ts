import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import type {
  GameEnvironmentSnapshot,
  GameMcpCall,
  GameMcpClientPort,
  GameMcpJson,
  GameMcpToolCallResult,
  GameMcpToolDescriptor,
} from '@proj-vera/core-agent'
import type {
  GameActionEvent,
  GameCapability,
  GameCommand,
  GameCommandInput,
  GameExecutionPort,
  Unsubscribe,
} from '@proj-vera/game-coop-core'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { GameEnvironmentUnavailableError } from '@proj-vera/game-coop-core'
import { nanoid } from 'nanoid'

const MAX_REMEMBERED_TOOL_CALLS = 1024
const META_SESSION_ID = 'ai.moeru.vera.game/sessionId'
const META_TURN_ID = 'ai.moeru.vera.game/turnId'
const META_TOOL_CALL_ID = 'ai.moeru.vera.game/toolCallId'

interface McpObjectInputSchema extends Record<string, unknown> {
  type: 'object'
  properties: Record<string, object>
  required: string[]
  additionalProperties: boolean
}

interface RememberedToolCall {
  name: string
  argumentsJson: string
  execution: Promise<GameMcpToolCallResult>
}

interface TrackedAction {
  capabilityId: string
  cancellable: boolean
  execution: Promise<GameMcpToolCallResult>
}

export interface GameMcpClientOptions {
  executionPort: GameExecutionPort
  createActionId?: () => string
  now?: () => number
  /** @default 5_000 */
  environmentFreshnessMs?: number
  /**
   * Risks exposed as MCP tools. Capabilities outside this set are hidden from
   * listing and rejected on call. Missing capability risk is impossible per
   * GameCapability; adapters own the declaration.
   * @default ['low']
   */
  allowedRisks?: ReadonlyArray<GameCapability['risk']>
  /** Extra teardown hooks run by dispose, after the disposed signal aborts. */
  onDispose?: () => void
}

export interface GameMcpClient extends GameMcpClientPort {
  dispose: () => Promise<void>
}

/**
 * Adapts any GameExecutionPort catalog to an in-process MCP client/server
 * pair. Capability IDs map to tools without a per-game prefix filter; risk
 * projection stays configurable. Environment reads prefer the adapter-native
 * `getEnvironment` resource and never mint per-game status tools.
 */
export function createGameMcpClient(options: GameMcpClientOptions): GameMcpClient {
  return new GameMcpClientRuntime(options)
}

class GameMcpClientRuntime implements GameMcpClient {
  private readonly client = new Client({ name: 'vera-game-client', version: '1.0.0' })
  // NOTICE: Dynamic per-session capability schemas require MCP's low-level Server.
  private readonly server = new Server(
    { name: 'vera-game-server', version: '1.0.0' },
    { capabilities: { resources: {}, tools: {} } },
  )

  private readonly clientTransport: InMemoryTransport
  private readonly serverTransport: InMemoryTransport
  private readonly createActionId: () => string
  private readonly now: () => number
  private readonly allowedRisks: ReadonlySet<GameCapability['risk']>
  private readonly validator = new AjvJsonSchemaValidator()
  private readonly toolCalls = new Map<string, RememberedToolCall>()
  private readonly actions = new Map<string, TrackedAction>()
  private readonly disposedController = new AbortController()
  private connectPromise?: Promise<void>
  private disposed = false

  constructor(private readonly options: GameMcpClientOptions) {
    this.createActionId = options.createActionId ?? nanoid
    this.now = options.now ?? Date.now
    this.allowedRisks = new Set(options.allowedRisks ?? ['low'])
    const transports = InMemoryTransport.createLinkedPair()
    this.clientTransport = transports[0]
    this.serverTransport = transports[1]

    this.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      this.assertActive(extra.signal)
      const sessionId = requiredMetadata(request.params?._meta, META_SESSION_ID)
      const capabilities = await this.readCapabilities(sessionId, extra.signal)
      return {
        tools: exposedTools(capabilities, this.allowedRisks).map(tool => ({
          name: tool.name,
          description: tool.capability.description,
          inputSchema: tool.inputSchema,
          // Risk/cancellable/capabilityId are Stage-local metadata; `_meta`
          // keeps them off the wire-visible MCP descriptor surface while the
          // client unwraps them back into GameMcpToolDescriptor.
          _meta: {
            'ai.moeru.vera.game/risk': tool.capability.risk,
            'ai.moeru.vera.game/cancellable': tool.capability.cancellable,
            ...(tool.capability.waitForTerminal == null
              ? {}
              : { 'ai.moeru.vera.game/waitForTerminal': tool.capability.waitForTerminal }),
            'ai.moeru.vera.game/capabilityId': tool.capability.capabilityId,
          },
          annotations: {
            destructiveHint: tool.capability.risk !== 'low',
            openWorldHint: true,
          },
        })),
      }
    })

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      this.assertActive(extra.signal)
      const sessionId = requiredMetadata(request.params._meta, META_SESSION_ID)
      const expectedUri = environmentUri(sessionId)
      if (request.params.uri !== expectedUri)
        throw new Error(`Game environment URI does not match session "${sessionId}"`)

      const environment = await this.readGameEnvironment(sessionId, extra.signal)
      return {
        contents: [{
          uri: expectedUri,
          mimeType: 'application/json',
          text: JSON.stringify(environment),
        }],
      }
    })

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      this.assertActive(extra.signal)
      const sessionId = requiredMetadata(request.params._meta, META_SESSION_ID)
      const turnId = requiredMetadata(request.params._meta, META_TURN_ID)
      const toolCallId = requiredMetadata(request.params._meta, META_TOOL_CALL_ID)
      const result = await this.executeTool({
        sessionId,
        turnId,
        toolCallId,
        name: request.params.name,
        arguments: request.params.arguments ?? {},
        abortSignal: extra.signal,
        waitForTerminal: parseWaitForTerminal(request.params._meta),
      })
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      }
    })
  }

  public async listTools(
    sessionId: string,
    abortSignal: AbortSignal,
  ): Promise<GameMcpToolDescriptor[]> {
    await this.connect(abortSignal)
    const result = await this.client.listTools({
      _meta: { [META_SESSION_ID]: sessionId },
    }, { signal: abortSignal })
    return result.tools.map((tool) => {
      const meta = isRecord(tool._meta) ? tool._meta : {}
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(isRisk(meta['ai.moeru.vera.game/risk'])
          ? { risk: meta['ai.moeru.vera.game/risk'] }
          : {}),
        ...(typeof meta['ai.moeru.vera.game/cancellable'] === 'boolean'
          ? { cancellable: meta['ai.moeru.vera.game/cancellable'] as boolean }
          : {}),
        ...(typeof meta['ai.moeru.vera.game/waitForTerminal'] === 'boolean'
          ? { waitForTerminal: meta['ai.moeru.vera.game/waitForTerminal'] as boolean }
          : {}),
        ...(typeof meta['ai.moeru.vera.game/capabilityId'] === 'string'
          ? { capabilityId: meta['ai.moeru.vera.game/capabilityId'] as string }
          : {}),
        ...(typeof meta['ai.moeru.vera.game/adapterId'] === 'string'
          ? { adapterId: meta['ai.moeru.vera.game/adapterId'] as string }
          : {}),
      }
    })
  }

  public async readEnvironment(
    sessionId: string,
    abortSignal: AbortSignal,
  ): Promise<GameEnvironmentSnapshot> {
    await this.connect(abortSignal)
    const result = await this.client.readResource({
      uri: environmentUri(sessionId),
      _meta: { [META_SESSION_ID]: sessionId },
    }, { signal: abortSignal })
    const content = result.contents.find(item => 'text' in item)
    if (content == null)
      throw new Error('Game MCP environment resource returned no text content')

    return parseEnvironment(content.text, sessionId)
  }

  public async callTool(call: GameMcpCall): Promise<GameMcpToolCallResult> {
    await this.connect(call.abortSignal)
    const result = await this.client.callTool({
      name: call.name,
      arguments: call.arguments,
      _meta: {
        [META_SESSION_ID]: call.sessionId,
        [META_TURN_ID]: call.turnId,
        [META_TOOL_CALL_ID]: call.toolCallId,
        'ai.moeru.vera.game/waitForTerminal': call.waitForTerminal ?? true,
      },
    }, undefined, { signal: call.abortSignal })

    if ('isError' in result && result.isError)
      throw new Error(toolErrorMessage(result.content))
    const value = 'toolResult' in result
      ? result.toolResult
      : result.structuredContent ?? toolTextResult(result.content)
    if (!isToolCallResult(value))
      throw new TypeError(`Game MCP tool "${call.name}" returned an invalid action result`)
    return value
  }

  public async cancelAction(input: {
    sessionId: string
    actionId: string
    reason?: string
    abortSignal?: AbortSignal
  }): Promise<void> {
    this.assertActive(input.abortSignal)
    const tracked = this.actions.get(input.actionId)
    if (tracked == null || !tracked.cancellable)
      return
    await this.options.executionPort.cancel(input.actionId, input.reason)
    // The terminal event settles the tracked execution; waitForTerminal=true
    // callers still observe the cancelled state through their own call promise.
  }

  public async dispose(): Promise<void> {
    if (this.disposed)
      return
    this.disposed = true
    this.disposedController.abort()
    this.toolCalls.clear()
    this.actions.clear()
    this.options.onDispose?.()
    await Promise.allSettled([
      this.client.close(),
      this.server.close(),
    ])
  }

  private async connect(abortSignal: AbortSignal): Promise<void> {
    this.assertActive(abortSignal)
    this.connectPromise ??= (async () => {
      await this.server.connect(this.serverTransport)
      await this.client.connect(this.clientTransport)
    })()
    await this.connectPromise
    this.assertActive(abortSignal)
  }

  private assertActive(abortSignal?: AbortSignal): void {
    if (this.disposed)
      throw new Error('Game MCP client is disposed')
    abortSignal?.throwIfAborted()
  }

  private async readCapabilities(
    sessionId: string,
    abortSignal: AbortSignal,
  ): Promise<GameCapability[]> {
    this.assertActive(abortSignal)
    const capabilities = await this.options.executionPort.getCapabilities(sessionId)
    this.assertActive(abortSignal)
    return capabilities
  }

  private async readGameEnvironment(
    sessionId: string,
    requestSignal: AbortSignal,
  ): Promise<GameEnvironmentSnapshot> {
    this.assertActive(requestSignal)
    if (this.options.executionPort.getEnvironment == null) {
      // No status-tool fallback: freeze doc forbids minting pseudo status
      // capabilities per game. freshnessMs 0 marks the placeholder as never
      // fresh so upper layers must not act on it.
      return {
        sessionId,
        observedAt: this.now(),
        freshnessMs: 0,
        content: { available: false },
      }
    }

    let snapshot: GameEnvironmentSnapshot
    try {
      snapshot = await this.options.executionPort.getEnvironment(sessionId)
    }
    catch (error) {
      if (!(error instanceof GameEnvironmentUnavailableError))
        throw error
      return {
        sessionId,
        observedAt: this.now(),
        freshnessMs: 0,
        content: { available: false },
      }
    }
    this.assertActive(requestSignal)
    if (snapshot.sessionId !== sessionId)
      throw new Error(`Game environment snapshot session "${snapshot.sessionId}" does not match "${sessionId}"`)

    return {
      sessionId,
      observedAt: snapshot.observedAt,
      freshnessMs: snapshot.freshnessMs,
      content: snapshot.content as GameMcpJson,
      adapterId: snapshot.adapterId,
      revision: snapshot.revision,
    }
  }

  private executeTool(call: GameMcpCall): Promise<GameMcpToolCallResult> {
    const callKey = `${call.sessionId}\0${call.turnId}\0${call.toolCallId}`
    const argumentsJson = JSON.stringify(call.arguments)
    const remembered = this.toolCalls.get(callKey)
    if (remembered != null) {
      if (remembered.name !== call.name || remembered.argumentsJson !== argumentsJson) {
        return Promise.reject(
          new Error(`Game MCP tool call "${call.toolCallId}" reused with different input`),
        )
      }
      return remembered.execution
    }

    const execution = this.executeNewTool(call)
    this.toolCalls.set(callKey, {
      name: call.name,
      argumentsJson,
      execution,
    })
    if (this.toolCalls.size > MAX_REMEMBERED_TOOL_CALLS) {
      const oldest = this.toolCalls.keys().next().value
      if (oldest != null)
        this.toolCalls.delete(oldest)
    }
    return execution
  }

  private async executeNewTool(call: GameMcpCall): Promise<GameMcpToolCallResult> {
    this.assertActive(call.abortSignal)
    const capabilities = await this.readCapabilities(call.sessionId, call.abortSignal)
    const exposed = exposedTools(capabilities, this.allowedRisks).find(tool => tool.name === call.name)
    if (exposed == null)
      throw new Error(`Game MCP tool "${call.name}" is unavailable or outside allowed risks`)

    const validate = this.validator.getValidator<GameCommandInput>(exposed.inputSchema as JsonSchemaType)
    const validated = validate(call.arguments)
    if (!validated.valid)
      throw new TypeError(`Invalid arguments for game tool "${call.name}": ${validated.errorMessage}`)

    const command: GameCommand = {
      sessionId: call.sessionId,
      turnId: call.turnId,
      actionId: this.createActionId(),
      capabilityId: exposed.capability.capabilityId,
      input: validated.data,
    }

    const execution = this.runAction(command, exposed.capability, call.abortSignal)
    this.actions.set(command.actionId, {
      capabilityId: command.capabilityId,
      cancellable: exposed.capability.cancellable,
      execution,
    })

    await this.options.executionPort.execute(command)
    this.assertActive(call.abortSignal)

    if (call.waitForTerminal === false) {
      const settled = await Promise.race([execution, Promise.resolve('pending' as const)])
      if (settled !== 'pending')
        return settled
      return {
        status: 'accepted',
        actionId: command.actionId,
        state: 'queued',
        capabilityId: command.capabilityId,
      }
    }
    return execution
  }

  /**
   * Bridges the action event stream to one settled GameMcpToolCallResult.
   *
   * waitForTerminal=true resolves on the first terminal event (result, error,
   * or reason preserved). waitForTerminal=false callers race this same promise
   * against the accept path, so a fast-terminal action still reports its real
   * terminal state instead of a synthetic accepted handle.
   */
  private runAction(
    command: GameCommand,
    capability: GameCapability,
    requestSignal: AbortSignal,
  ): Promise<GameMcpToolCallResult> {
    return new Promise<GameMcpToolCallResult>((resolve, reject) => {
      let settled = false
      let unsubscribe: Unsubscribe = () => {}
      let abort: () => void = () => {}

      const finish = (result?: GameMcpToolCallResult, error?: unknown) => {
        if (settled)
          return
        settled = true
        requestSignal.removeEventListener('abort', abort)
        this.disposedController.signal.removeEventListener('abort', abort)
        unsubscribe()
        if (error != null)
          reject(error)
        else
          resolve(result!)
      }

      abort = () => {
        if (capability.cancellable)
          void this.options.executionPort.cancel(command.actionId, 'Game MCP call aborted').catch(() => {})
        finish(undefined, requestSignal.reason ?? this.disposedController.signal.reason)
      }

      requestSignal.addEventListener('abort', abort, { once: true })
      this.disposedController.signal.addEventListener('abort', abort, { once: true })
      unsubscribe = this.options.executionPort.observe(command.sessionId, (event) => {
        if (!matchesCommand(event, command))
          return

        if (event.state === 'succeeded') {
          finish({
            status: 'terminal',
            actionId: command.actionId,
            state: 'succeeded',
            capabilityId: command.capabilityId,
            ...(event.result !== undefined ? { result: event.result as GameMcpJson } : {}),
          })
          return
        }
        if (event.state === 'failed') {
          finish({
            status: 'terminal',
            actionId: command.actionId,
            state: 'failed',
            capabilityId: command.capabilityId,
            error: event.error,
          })
          return
        }
        if (event.state === 'cancelled') {
          finish({
            status: 'terminal',
            actionId: command.actionId,
            state: 'cancelled',
            capabilityId: command.capabilityId,
            ...(event.reason !== undefined ? { reason: event.reason } : {}),
          })
        }
      })
    })
  }
}

function exposedTools(
  capabilities: GameCapability[],
  allowedRisks: ReadonlySet<GameCapability['risk']>,
) {
  const names = new Set<string>()
  return capabilities
    .filter(capability => allowedRisks.has(capability.risk))
    // Status stays on getEnvironment / resources, never as a model tool.
    .filter(capability => !capability.capabilityId.endsWith('.status'))
    .map((capability) => {
      const name = capability.capabilityId.replaceAll(/[^\w-]/g, '_')
      if (names.has(name))
        throw new Error(`Game capabilities collide on MCP tool name "${name}"`)
      names.add(name)
      return {
        capability,
        name,
        inputSchema: normalizeInputSchema(capability),
      }
    })
}

function normalizeInputSchema(capability: GameCapability): McpObjectInputSchema {
  const properties: Record<string, object> = {}
  for (const [name, schema] of Object.entries(capability.inputSchema.properties)) {
    if (!isRecord(schema))
      throw new TypeError(`Game capability "${capability.capabilityId}" has invalid schema property "${name}"`)
    properties[name] = schema
  }
  return {
    type: 'object',
    properties,
    required: [...capability.inputSchema.required],
    additionalProperties: capability.inputSchema.additionalProperties,
  }
}

function environmentUri(sessionId: string): string {
  return `vera-game://environment/${encodeURIComponent(sessionId)}`
}

function requiredMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = metadata?.[key]
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`Game MCP request is missing metadata "${key}"`)
  return value
}

function parseWaitForTerminal(metadata: Record<string, unknown> | undefined): boolean {
  const value = metadata?.['ai.moeru.vera.game/waitForTerminal']
  return value !== false
}

function matchesCommand(
  event: GameActionEvent,
  command: {
    sessionId: string
    turnId: string
    actionId: string
    capabilityId: string
  },
): boolean {
  return event.sessionId === command.sessionId
    && event.turnId === command.turnId
    && event.actionId === command.actionId
    && event.capabilityId === command.capabilityId
}

function parseEnvironment(text: string, sessionId: string): GameEnvironmentSnapshot {
  const parsed: unknown = JSON.parse(text)
  if (
    !isRecord(parsed)
    || parsed.sessionId !== sessionId
    || typeof parsed.observedAt !== 'number'
    || typeof parsed.freshnessMs !== 'number'
    || !isGameMcpJson(parsed.content)
  ) {
    throw new TypeError('Game MCP environment resource returned an invalid snapshot')
  }
  return {
    sessionId,
    observedAt: parsed.observedAt,
    freshnessMs: parsed.freshnessMs,
    content: parsed.content,
    ...(typeof parsed.adapterId === 'string' ? { adapterId: parsed.adapterId } : {}),
    ...(typeof parsed.revision === 'string' ? { revision: parsed.revision } : {}),
  }
}

function isToolCallResult(value: unknown): value is GameMcpToolCallResult {
  if (!isRecord(value))
    return false
  if (typeof value.actionId !== 'string' || typeof value.capabilityId !== 'string')
    return false
  if (value.status === 'accepted')
    return value.state === 'queued' || value.state === 'running'
  if (value.status === 'terminal')
    return value.state === 'succeeded' || value.state === 'failed' || value.state === 'cancelled'
  return false
}

function isRisk(value: unknown): value is 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high'
}

function toolErrorMessage(content: unknown): string {
  return toolTextContent(content) ?? 'Game MCP tool failed'
}

function toolTextResult(content: unknown): unknown {
  const text = toolTextContent(content)
  if (text == null)
    return content
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

function toolTextContent(content: unknown): string | undefined {
  if (!Array.isArray(content))
    return undefined
  for (const item of content) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string')
      return item.text
  }
  return undefined
}

function isGameMcpJson(value: unknown): value is GameMcpJson {
  if (value == null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
    return true
  if (Array.isArray(value))
    return value.every(isGameMcpJson)
  return isRecord(value) && Object.values(value).every(isGameMcpJson)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
