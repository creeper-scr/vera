<picture>
  <source
    width="100%"
    srcset="./docs/content/public/banner-dark-1280x640.avif"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="./docs/content/public/banner-light-1280x640.avif"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="250" src="./docs/content/public/banner-light-1280x640.avif" alt="Vera" />
</picture>

<h1 align="center">Vera</h1>

<p align="center">
  Open-source AI game companion stack — chat, voice, Live2D/VRM stage, and agents that act with you in games (fork of Moeru Project AIRI).
</p>

<p align="center">
  [<a href="https://airi.moeru.ai">Upstream Try Web</a>]
  · [<a href="https://github.com/moeru-ai/airi/releases">Releases</a>]
  · [<a href="https://airi.moeru.ai/docs/">Upstream Docs</a>]
  · [<a href="./docs/README.zh-CN.md">简体中文</a>]
  · [<a href="https://discord.gg/TgQ3Cu2F7A">Discord</a>]
</p>

<p align="center">
  <a href="https://github.com/moeru-ai/airi/blob/main/LICENSE"><img src="https://img.shields.io/github/license/moeru-ai/airi.svg?style=flat&colorA=080f12&colorB=1fa669" alt="MIT"></a>
  <a href="https://discord.gg/TgQ3Cu2F7A"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdiscord.com%2Fapi%2Finvites%2FTgQ3Cu2F7A%3Fwith_counts%3Dtrue&query=%24.approximate_member_count&suffix=%20members&logo=discord&logoColor=white&label=%20&color=7389D8&labelColor=6A7EC2" alt="Discord"></a>
</p>

> Inspired by [Neuro-sama](https://www.youtube.com/@Neurosama). **Vera** is an open-source AI companion that talks, appears on stage, and acts in external worlds (games, chat platforms, MCP tools). Historical upstream: [Moeru Project AIRI](https://github.com/moeru-ai/airi).

> [!WARNING]
> This project has **no** official cryptocurrency or token.

## What you can run today

| Surface | Package | Role |
|---------|---------|------|
| Browser stage | `@proj-vera/stage-web` | Default `pnpm dev` target; web companion + Doubao voice |
| Hosted API | `@proj-vera/server` | Hono backend: auth, billing, LLM gateway, WebSocket |
| Docs site | `@proj-vera/docs` | VitePress site under `docs/` |
| Minecraft bot | `@proj-vera/minecraft-bot` | Mineflayer + `game-coop` adapter |
| Game bridges | `@proj-vera/game-bridges` | File-bridge adapters (Stardew / DST) |

Shared stage logic lives in `@proj-vera/stage-ui` (UI + Pinia) and `@proj-vera/core-agent` (platform-neutral turn / companion agent contracts). Game cooperation contracts live in `@proj-vera/game-coop-core`.

## Monorepo layout

```text
apps/           Product surfaces (stage-web, server; residual desktop/mobile trees may remain)
packages/       Shared libraries (stage-ui, core-agent, game-coop-core, audio, plugin-*, server-*, ui, …)
services/       Game agents / bridges (minecraft, game-bridges) + optional bots
plugins/        Vera host plugins (Home Assistant, Bilibili, …)
docs/           VitePress user docs + engineering handbook (+ dated records/)
```

### Services (agents & bridges)

| Package | Purpose |
|---------|---------|
| `services/minecraft` | Mineflayer bot + `game-coop` adapter |
| `services/game-bridges` | File-bridge adapters (Stardew / DST) |

## Install (end users)

- **Web (upstream demo)**: [https://airi.moeru.ai](https://airi.moeru.ai) — Moeru Project AIRI; this fork runs locally via `pnpm dev` / `pnpm dev:play`.

## Develop (from source)

Prerequisites: **Node.js 23+**, [corepack](https://github.com/nodejs/corepack) + **pnpm** (see [`.github/CONTRIBUTING.md`](./.github/CONTRIBUTING.md)).

```sh
corepack enable
pnpm install          # postinstall builds packages

pnpm dev:play         # web + WS hub(:6121) + minecraft-bot (one command)
pnpm dev              # stage-web only
pnpm dev:server       # server-runtime WS hub only
pnpm dev:docs         # VitePress
pnpm build            # turbo: packages + apps
pnpm test:run         # vitest (root + selected package configs)
pnpm lint && pnpm typecheck
```

### Game companion (Minecraft) — one command

1. Start a Minecraft server / LAN world the bot can join (default `127.0.0.1:25565`).
2. Config (bot LLM + Doubao + WS) — either file works:

```sh
# A) already using minecraft .env.local? just append:
#    VITE_VOLCENGINE_APP_ID=...
#    VITE_VOLCENGINE_ACCESS_KEY=...
#    → services/minecraft/.env.local

# B) or root play file:
cp .env.play.example .env.play.local
```

`dev:play` prefers `.env.play.local`, else `services/minecraft/.env.local`.

3. Run:

```sh
pnpm dev:play
```

Opens `stage-web` + `server-runtime` + `minecraft-bot`. Web UI: pick Minecraft → attach.

Useful filters:

```sh
pnpm -F @proj-vera/minecraft-bot start
pnpm -F @proj-vera/game-bridges start
pnpm -F @proj-vera/server dev
```

Stack highlights: **pnpm** workspaces + **Turbo**, **Vue 3** + **Vite**, **Hono** + Drizzle (server), **Vitest**, **xsAI** for model I/O, **UnoCSS** / Reka UI for UI.

## Documentation

| Doc | Contents |
|-----|----------|
| [User docs (VitePress)](./docs/) (upstream publish: [airi.moeru.ai/docs](https://airi.moeru.ai/docs/)) | Manuals, providers, contributing guides |
| [`docs/README.zh-CN.md`](./docs/README.zh-CN.md) | Chinese repo overview |
| [`docs/handbook/`](./docs/handbook/) | Engineering contracts (architecture, game companion, UI, verification) |
| [`apps/server/CLAUDE.md`](./apps/server/CLAUDE.md) | Hosted server agent guide |

Local docs: `pnpm dev:docs`.

## License

[MIT](./LICENSE) — Vera (fork of Moeru Project AIRI).
