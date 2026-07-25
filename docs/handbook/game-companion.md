# Game Companion

Stable layering for voice companion + game actions. Implementation lives in code; this page locks **who owns what**.

## Layers

```text
Player voice / text
        │
        ▼
┌─────────────────────────────┐
│ Layer 1 — Voice / media     │  Doubao (or other) realtime ASR/TTS
│ Chat only. No game tools.   │  system prompt refreshed from L2/L3
└──────────────┬──────────────┘
               │ finalized VoiceTurn / text
               ▼
┌─────────────────────────────┐
│ Layer 2 — Decision          │  CompanionAgentRuntime / GameActionRuntime
│ Model may call MCP tools    │  (@proj-vera/core-agent)
└──────────────┬──────────────┘
               │ GameMcpClientPort
               ▼
┌─────────────────────────────┐
│ Layer 3 — World adapter     │  GameExecutionPort / GameAdapter
│ Capabilities, environment,  │  (@proj-vera/game-coop-core + services)
│ execute / observe / cancel  │
└─────────────────────────────┘
```

### Layer 1 — voice

- Owns natural speech and listening only.
- Must not claim it executed tools; actions are attributed to the decision model.
- Environment text in the prompt is **data**, not instructions.
- Prompt builder: `packages/stage-ui/src/services/game-coop/gameVoiceSystemPrompt.ts`
  (`createGameVoiceSystemPrompt`, refresh interval `GAME_VOICE_SYSTEM_PROMPT_REFRESH_MS`).

### Layer 2 — decision

- Owns dialogue policy that may invoke game tools (at most one MCP action per game-action turn in `GameActionRuntime`).
- Entry glue: `packages/stage-ui/src/services/game-coop/companionSession.ts`
  (`createCompanionSession` → `createCompanionAgentRuntime` + `createGameMcpClient`).
- MCP client: `packages/stage-ui/src/services/game-coop/gameMcpClient.ts`.
- Web UI hook: `apps/stage-web` + `packages/stage-ui` `useCompanionSession`.

### Layer 3 — world

- Contract: `packages/game-coop-core` (`GameAdapter`, `GameExecutionPort`, observations, capabilities).
- Minecraft: `services/minecraft/src/game-coop/minecraftGameAdapter.ts`.
- Hosted / IPC-facing adapter paths live under `packages/stage-ui/src/services/game-coop/` (e.g. server adapter tests).
- File-bridge games: `services/game-bridges`.

## Session wiring

`createCompanionSession` is Wave-2 glue:

1. Inject a platform `GameExecutionPort` (fake in tests, real adapter in product).
2. Build MCP client over that port.
3. Run `CompanionAgentRuntime` with a `CompanionAgentModelPort`.
4. Optionally `startWorldObservations()` → auto-ingest `observeWorld` into the agent.

Callers supply `sessionId`, character system prompt getter, and phase/result callbacks. Dispose tears down MCP + agent + observation subscription.

## Ownership

| Concern | Owner |
|---------|--------|
| Voice media session | App / provider SDK boundary (e.g. Doubao in renderer) |
| Agent turn policy | `packages/core-agent` |
| MCP projection + session lifecycle | `packages/stage-ui` game-coop services |
| Server-channel game attach | `ServerGameAdapter` + `server-runtime` WS |
| Game-specific execute/observe | Owning `services/*` adapter |

## Out of scope for Layer 1

- Calling `GameExecutionPort` directly from the voice model.
- Treating stale environment snapshots as ground truth for spoken answers
  (`isGameVoiceEnvironmentStale` in `gameVoiceSystemPrompt.ts`).

## Related tests

- `packages/stage-ui/src/services/game-coop/companionSession.test.ts`
- `packages/stage-ui/src/services/game-coop/gameVoiceSystemPrompt.test.ts`
- `packages/stage-ui/src/services/game-coop/gameMcpClient.test.ts`
- `packages/core-agent/src/runtime/gameActionRuntime.test.ts`
- `services/minecraft/src/game-coop/*.test.ts`
