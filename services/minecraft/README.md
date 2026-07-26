# `@proj-vera/minecraft-bot`

Mineflayer-based Minecraft bot for Vera. Connects to a trusted Minecraft server, exposes world actions to the stage, and implements the `game-coop` adapter used by companion sessions.

## Safety

Do **not** connect this bot to public servers you do not trust. The runtime can drive a real local Minecraft session (including JS action plans in an isolate). Treat it as a local-development / trusted-server tool only.

## Setup

```bash
pnpm i   # from repo root
cp services/minecraft/.env.example services/minecraft/.env.local
# edit .env.local
pnpm -F @proj-vera/minecraft-bot dev
# or: pnpm -F @proj-vera/minecraft-bot start
```

For the full companion loop (web + WS hub + bot + Doubao relay): `pnpm dev:play` from repo root. See [`docs/handbook/game-companion.md`](../../docs/handbook/game-companion.md).

## Game-coop

| Path | Role |
|------|------|
| `src/game-coop/minecraftGameAdapter.ts` | `GameAdapter` implementation |
| `src/game-coop/minecraftGameCoopChannel.ts` | Channel / session glue |
| `src/libs/mineflayer/connection-supervisor.ts` | Disconnect / reconnect + spawn watchdog |
| `src/game-coop/*.test.ts` | Unit / integration / closed-loop e2e |

Contracts: `@proj-vera/game-coop-core`. Session wiring on the stage side: [`docs/handbook/game-companion.md`](../../docs/handbook/game-companion.md).

## Runtime layout

`src/cognitive/` still hosts Mineflayer plugins, `TaskExecutor` / `llm-actions`, and the glue that constructs `MinecraftGameAdapter` + channel. Companion contracts live under `src/game-coop/`.

New world capabilities: bind in TaskExecutor / `llm-actions` first, then expose as a `MinecraftGameAdapter` capability. Do not add a parallel voice→action control plane outside game-coop.
