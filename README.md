# Vera

Open-source AI game companion (fork of [Moeru Project AIRI](https://github.com/moeru-ai/airi)). Web stage + voice + agents that act in games.

No official cryptocurrency or token.

## Run

Node.js 23+, [corepack](https://github.com/nodejs/corepack) + pnpm.

```sh
corepack enable && pnpm install

cp services/minecraft/.env.example services/minecraft/.env.local
# fill OPENAI_API_KEY, VITE_VOLCENGINE_APP_ID, VITE_VOLCENGINE_ACCESS_KEY

# Minecraft world must be reachable (default 127.0.0.1:25565)
pnpm dev:play
```

`dev:play` starts stage-web + server-runtime (`:6121`) + minecraft-bot + Doubao relay (`:6122`). Prefer root `.env.play.local` if present, else `services/minecraft/.env.local`.

```sh
pnpm dev              # stage-web only
pnpm dev:server       # WS hub only
pnpm dev:docs         # VitePress
pnpm test:run && pnpm lint && pnpm typecheck
```

## Layout

| Path | Role |
|------|------|
| `apps/stage-web` | Browser companion (`pnpm dev`) |
| `apps/server` | Optional hosted API |
| `packages/stage-ui` | Stage UI + companion session |
| `packages/core-agent` | Turn / companion agent contracts |
| `packages/game-coop-core` | Game adapter contracts |
| `packages/server-runtime` | Local WS hub |
| `services/minecraft` | Mineflayer + game-coop |
| `services/game-bridges` | Stardew / DST file bridges |

## Docs

- Engineering: [`docs/handbook/`](./docs/handbook/) (`architecture.md`, `game-companion.md`)
- Chinese overview: [`docs/README.zh-CN.md`](./docs/README.zh-CN.md)
- User manuals: `pnpm dev:docs`
