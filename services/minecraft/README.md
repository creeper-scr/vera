# `@proj-vera/minecraft-bot`

Mineflayer-based Minecraft bot for Vera. Connects to a trusted Minecraft server, exposes world actions to the stage, and implements the `game-coop` adapter used by companion sessions.

## Safety

Do **not** connect this bot to public servers you do not trust. The runtime can drive a real local Minecraft session (including JS action plans in an isolate). Treat it as a local-development / trusted-server tool only.

## Setup

```bash
pnpm i   # from repo root
cp services/minecraft/.env services/minecraft/.env.local
# edit .env.local
pnpm -F @proj-vera/minecraft-bot dev
# or: pnpm -F @proj-vera/minecraft-bot start
```

## Game-coop

| Path | Role |
|------|------|
| `src/game-coop/minecraftGameAdapter.ts` | `GameAdapter` implementation |
| `src/game-coop/minecraftGameCoopChannel.ts` | Channel / session glue |
| `src/game-coop/*.test.ts` | Unit / integration / closed-loop e2e |

Contracts: `@proj-vera/game-coop-core`. Session wiring on the stage side: [`docs/handbook/game-companion.md`](../../docs/handbook/game-companion.md).

## Legacy paths

`src/cognitive/` and `src/voice-game/` still exist for older Mineflayer cognitive flows. New companion / voice→action work should go through `src/game-coop/` and the Layer 1–3 split in the handbook — do not extend the legacy path for new features unless migrating it.
