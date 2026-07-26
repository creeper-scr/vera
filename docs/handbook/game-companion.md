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
│ Layer 2 — Decision          │  CompanionAgentRuntime (product)
│ Model may call MCP tools    │  (@proj-vera/core-agent)
└──────────────┬──────────────┘
               │ GameMcpClientPort
               ▼
┌─────────────────────────────┐
│ Layer 3 — World adapter     │  GameAdapter / GameExecutionPort
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
- Mic / PTT / VAD / finalize → `VoiceTurn` policy: `@proj-vera/core-agent`
  `createCompanionVoiceController` (`runtime/companionVoiceController.ts`).
  Stage media glue: `packages/stage-ui/src/composables/audio/use-companion-voice.ts`.
  Product `stage-web` today wires Doubao realtime directly; the controller is the
  portable L1 lifecycle API (tests + optional hosts), not yet the default web path.
- Barge-in / cancel ownership: `contracts/companionCancel.ts`
  (`CompanionCancelRequest` / `CompanionInterruptPort`). One cancel settles speech,
  inference, tools, and cancellable game actions; non-cancellable actions report
  terminal state instead of being dropped.

### Layer 2 — decision

- **Product path:** `CompanionAgentRuntime` — continuous MCP tool loop per user turn
  (default `maxSteps = 6`; `useCompanionSession` sets `maxSteps: 6`).
- Entry glue: `packages/stage-ui/src/services/game-coop/companionSession.ts`
  (`createCompanionSession` → `createCompanionAgentRuntime` + `createGameMcpClient`).
- Product session + L1 context + VoiceSteer: `packages/stage-ui/src/composables/useCompanionSession.ts`.
- MCP client: `packages/stage-ui/src/services/game-coop/gameMcpClient.ts`.
- Web UI: `apps/stage-web/src/pages/index.vue` → `useCompanionSession`
  (+ Doubao via `use-doubao-realtime-voice` / `libs/doubao-realtime-voice.ts`).

### Layer 3 — world

- Contract: `packages/game-coop-core` (`GameAdapter`, `GameExecutionPort`, observations, capabilities).
- Minecraft: `services/minecraft/src/game-coop/minecraftGameAdapter.ts`
  (+ reconnect / spawn watchdog: `services/minecraft/src/libs/mineflayer/connection-supervisor.ts`).
- Product attach proxy: `packages/stage-ui/src/services/game-coop/serverGameAdapter.ts`
  (`ServerGameAdapter` over `server-runtime` WS `game:coop:*`, destination
  `module:${adapterId}-bot`, default `module:minecraft-bot`).
- File-bridge games: `services/game-bridges` (Stardew / DST; env key `VERA_URL`, not `VERA_WS_BASEURL`).

## Legacy / parallel stacks (do not use for new work)

| Piece | Status |
|-------|--------|
| `GameActionRuntime` / `useGameActionRuntime` | Single MCP action/turn; demos/tests until Wave 4 removal |
| `GameCoopAgent` | Older stage-side agent; tests only |
| `createMinecraftMcpClient` / `MinecraftIntentPolicy` | Minecraft-specific MCP/intent; e2e may still touch; product uses generic `createGameMcpClient` |

Product path is always: `useCompanionSession` → `createCompanionSession` → `createGameMcpClient` → `ServerGameAdapter` → `module:*-bot`.

## Hybrid L1/L2 alignment

Mode: **hybrid**. Layer 1 may short-ack immediately; Layer 2 steers subsequent speech via typed facts. Doubao `UpdateConfig(201)` applies to **later** dialogue only — this wave does **not** interrupt current TTS.

```text
L1 spoken text ──rememberExternalAssistant──► L2 conversationHistory
L2 turn result ──VoiceSteerDirective────────► L1 system_role (facts/corrections/speakHint)
Shared persona ──companionPersonaContract───► both layer prompts
```

| Piece | Owner |
|-------|--------|
| Shared persona + L1/L2 rule builders | `companionPersonaContract.ts` |
| `VoiceSteerDirective` + `createVoiceSteerFromTurnResult` | `@proj-vera/core-agent` `contracts/voiceSteer.ts` |
| Steer → L1 prompt sections | `formatVoiceSteer` in `gameVoiceSystemPrompt.ts` |
| L1 speech → L2 history | `CompanionAgentRuntime.rememberExternalAssistant` via `useCompanionSession.rememberSpokenUtterance` |

Layer 1 must: short-ack first; no completion claims until「已确认事实」; honor「需纠正」before other talk; **never deny listed capabilities**. Layer 2 must: call tools before claiming action; pass full decision system via `getSystemPrompt` (`buildLayer2SystemPrompt`).

Capability awareness (voice knows *what*, decision owns *how*):

- Human capability card from MCP tools: `companionCapabilityCard.ts` → injected into L1 prompt
- Successful tool steps add a denial-correction steer so L1 can unsay 「做不到」 on the next turn
- Recent Layer 2 outcomes also feed L1 via action history in `gameVoiceSystemPrompt.ts` (`rememberGameVoiceAction`)

## Session wiring

`createCompanionSession` is Wave-2 glue; product callers use `useCompanionSession`:

1. Inject a platform `GameExecutionPort` (`ServerGameAdapter` in product, fake in tests).
2. Build MCP client over that port.
3. Run `CompanionAgentRuntime` with a `CompanionAgentModelPort`.
4. Optionally `startWorldObservations()` → auto-ingest `observeWorld` into the agent.
5. On each turn result: build `VoiceSteerDirective`, refresh L1 system prompt from environment + tools + steer.

Callers supply `sessionId`, character system prompt getter, and phase/result callbacks. Dispose tears down MCP + agent + observation subscription.

## Ownership

| Concern | Owner |
|---------|--------|
| Voice media session | App / provider SDK (e.g. Doubao in renderer) |
| Portable L1 voice lifecycle / cancel | `core-agent` `companionVoiceController` + `companionCancel` |
| Agent turn policy | `packages/core-agent` (`CompanionAgentRuntime`) |
| MCP client lifecycle | `packages/stage-ui` `services/game-coop/companionSession.ts` |
| Product session + L1 context + VoiceSteer | `packages/stage-ui` `composables/useCompanionSession.ts` |
| Web attach / Doubao wiring | `apps/stage-web` |
| Server-channel game attach | `ServerGameAdapter` + `server-runtime` WS |
| Minecraft reconnect / spawn | `services/minecraft` `connection-supervisor` |
| Game-specific execute/observe | Owning `services/*` adapter |

## Out of scope for Layer 1

- Calling `GameExecutionPort` directly from the voice model.
- Treating stale environment snapshots as ground truth for spoken answers
  (`isGameVoiceEnvironmentStale` in `gameVoiceSystemPrompt.ts`).
- Forced TTS of Layer 2 `assistantText` (relay mode) or mid-utterance Doubao interrupt.

## Related tests

- `packages/stage-ui/src/services/game-coop/companionSession.test.ts`
- `packages/stage-ui/src/services/game-coop/gameVoiceSystemPrompt.test.ts`
- `packages/stage-ui/src/services/game-coop/companionPersonaContract.test.ts`
- `packages/stage-ui/src/services/game-coop/companionCapabilityCard.test.ts`
- `packages/stage-ui/src/services/game-coop/gameMcpClient.test.ts`
- `packages/stage-ui/src/services/game-coop/serverGameAdapter.test.ts`
- `packages/core-agent/src/contracts/voiceSteer.test.ts`
- `packages/core-agent/src/runtime/companionAgentRuntime.test.ts`
- `packages/core-agent/src/runtime/companionVoiceController.test.ts`
- `packages/core-agent/src/runtime/gameActionRuntime.test.ts`
- `services/minecraft/src/game-coop/*.test.ts`
- `services/minecraft/src/libs/mineflayer/connection-supervisor.test.ts`
