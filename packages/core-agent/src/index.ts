export type {
  CompanionCancelOutcome,
  CompanionCancelRequest,
  CompanionCancelScope,
  CompanionInterruptPort,
} from './contracts/companionCancel'
export type { AgentContextPort } from './contracts/context-port'
export type {
  GameEnvironmentSnapshot,
  GameMcpCall,
  GameMcpClientPort,
  GameMcpJson,
  GameMcpToolCallResult,
  GameMcpToolDescriptor,
} from './contracts/gameMcpPort'
export type { ChatHookRegistry } from './contracts/hook-types'
export type { AgentLLMPort } from './contracts/llm-port'
export type { AgentSessionPort } from './contracts/session-port'
export type { AgentForegroundStreamPort } from './contracts/stream-port'
export type {
  SpeechPlaybackResult,
  SpeechPlaybackTerminal,
  VoiceTurn,
  VoiceTurnMetadata,
} from './contracts/voiceTurn'

export {
  buildContextPromptMessage,
  formatContextPromptText,
} from './messages/context-prompt'
export type { ContextSnapshot } from './messages/context-prompt'
export { formatTimePrefix } from './messages/datetime-prefix'
export { createChatHooks } from './runtime/agent-hooks'
export type {
  ChatOrchestratorLifecycleRecord,
  ChatOrchestratorLLMPort,
  ChatOrchestratorPromptProjection,
  ChatOrchestratorRuntime,
  ChatOrchestratorRuntimeDeps,
  ChatOrchestratorRuntimeState,
  ChatOrchestratorSendOptions,
  ChatOrchestratorSessionPort,
  QueuedSendSnapshot,
} from './runtime/chat-orchestrator-runtime'
export { createChatOrchestratorRuntime } from './runtime/chat-orchestrator-runtime'
export type {
  CompanionAgentModelPort,
  CompanionAgentModelRequest,
  CompanionAgentPhase,
  CompanionAgentRuntime,
  CompanionAgentRuntimeDeps,
  CompanionAgentToolStep,
  CompanionAgentTurnResult,
  CompanionObservationInput,
} from './runtime/companionAgentRuntime'
export { createCompanionAgentRuntime } from './runtime/companionAgentRuntime'
export type {
  CompanionMicMode,
  CompanionSpeechCancelPort,
  CompanionVoiceController,
  CompanionVoiceControllerDeps,
  CompanionVoicePhase,
} from './runtime/companionVoiceController'
export { createCompanionVoiceController } from './runtime/companionVoiceController'
export type { ContextHistoryEntry, ContextIngestResult, ContextRegistry } from './runtime/context-registry'
export { createContextRegistry } from './runtime/context-registry'
export type {
  GameActionModelPort,
  GameActionModelRequest,
  GameActionRuntime,
  GameActionRuntimeDeps,
  GameActionTurnResult,
  GameActionUserTurn,
} from './runtime/gameActionRuntime'
export { createGameActionRuntime } from './runtime/gameActionRuntime'
export { useLlmmarkerParser } from './runtime/llm-marker-parser'
export {
  isContentArrayRelatedError,
  isToolRelatedError,
  modelKey,
  sanitizeMessages,
  streamFrom,
  streamOptionsContentArrayCompatibilityOk,
  streamOptionsToolsCompatibilityOk,
} from './runtime/llm-service'
export {
  categorizeResponse,
  createStreamingCategorizer,
} from './runtime/response-categoriser'
export type {
  CategorizedResponse,
  CategorizedSegment,
  ResponseCategory,
} from './runtime/response-categoriser'
export { mergeLoadedSessionMessages } from './session/merge-loaded-session-messages'
export type {
  ChatAssistantMessage,
  ChatHistoryItem,
  ChatMessage,
  ChatSlices,
  ChatSlicesText,
  ChatSlicesToolCall,
  ChatSlicesToolCallResult,
  ChatStreamEvent,
  ChatStreamEventContext,
  ContextMessage,
  ErrorMessage,
  StreamingAssistantMessage,
} from './types/chat'

export type {
  BuiltinToolsResolver,
  StreamEvent,
  StreamFromOptions,
  StreamOptions,
} from './types/llm'
