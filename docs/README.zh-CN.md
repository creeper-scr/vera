# Vera（简体中文）

开源 AI 游戏陪玩：网页舞台、语音、Minecraft / 星露谷 / 饥荒。上游体验见 [airi.moeru.ai](https://airi.moeru.ai)；本仓库本地跑。

英文说明：[../README.md](../README.md)

## 跑起来

Node.js 23+、corepack、pnpm。

```sh
corepack enable && pnpm install
cp services/minecraft/.env.example services/minecraft/.env.local
# 填 OPENAI_API_KEY + VITE_VOLCENGINE_*
pnpm dev:play
```

`dev:play` = stage-web + WS hub(`:6121`) + minecraft-bot + Doubao relay(`:6122`)。

```sh
pnpm dev          # 仅网页
pnpm dev:server   # 仅 WS hub
pnpm dev:docs     # 文档站
```

## 目录

| 路径 | 作用 |
|------|------|
| `apps/stage-web` | 浏览器 companion |
| `packages/stage-ui` / `core-agent` / `game-coop-core` | 舞台与 agent 契约 |
| `packages/server-runtime` | 本地 WS hub |
| `services/minecraft` | Mineflayer + game-coop |
| `services/game-bridges` | 星露谷 / 饥荒文件桥 |

## 工程文档

[`handbook/`](./handbook/)：`architecture.md`、`game-companion.md`。
