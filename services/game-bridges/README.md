# `@proj-vera/game-bridges`

File-bridge adapters for Stardew Valley and Don’t Starve Together. Each configured game joins `server-runtime` as `module:${adapterId}-bot` (`stardew-bot` / `dst-bot`).

## Setup

```bash
cp services/game-bridges/.env.example services/game-bridges/.env.local
# edit paths, then:
pnpm -F @proj-vera/game-bridges start
```

Needs a running WS hub (`pnpm dev:server` or `pnpm dev:play`).

## Env

| Key | Role |
|-----|------|
| `VERA_URL` | WS hub URL (default `ws://127.0.0.1:6121/ws`). **Not** `VERA_WS_BASEURL` (that key is Minecraft-only). |
| `VERA_TOKEN` | Optional auth token |
| `STARDEW_BRIDGE_PATH` + `STARDEW_ACTION_DIR` | Stardew SMAPI bridge paths |
| `STARDEW_COMPANION` | Companion name (default `Companion1`) |
| `DST_BRIDGE_PATH` + `DST_COMMAND_PATH` | DST Lua bridge paths |

At least one game pair must be set or the process exits.

## Layout

| Path | Role |
|------|------|
| `src/adapters/stardewGameAdapter.ts` | Stardew `GameAdapter` |
| `src/adapters/dontStarveTogetherGameAdapter.ts` | DST `GameAdapter` |
| `src/index.ts` | Client + `GameCoopChannel` per adapter |

Contracts: `@proj-vera/game-coop-core`. Companion layering: [`docs/handbook/game-companion.md`](../../docs/handbook/game-companion.md).
