# Vera（简体中文）

开源数字伙伴 / AI VTuber 容器：网页舞台、语音、游戏陪玩（Minecraft / 星露谷 / 饥荒）。

- 上游网页体验（Moeru Project AIRI）：[https://airi.moeru.ai](https://airi.moeru.ai)；本仓库本地：`pnpm dev` / `pnpm dev:play`
- 上游用户文档：[https://airi.moeru.ai/docs/zh-Hans/](https://airi.moeru.ai/docs/zh-Hans/)；本地文档：`pnpm dev:docs`
- 英文仓库说明：[../README.md](../README.md)

## 仓库里实际有什么

本仓库是 **pnpm monorepo**（当前版本见根与各包 `package.json`）。

| 目录 | 内容 |
|------|------|
| `apps/stage-web` | 浏览器 companion（默认 `pnpm dev`）；本 fork 无托管登录 |
| `apps/server` | 托管后端（Hono：鉴权、计费、LLM 网关、WebSocket；可选） |
| `packages/stage-ui` | 共享舞台业务 UI / Pinia / companion session |
| `packages/core-agent` | 平台无关对话与 companion agent 契约 |
| `packages/game-coop-core` | 游戏协作契约与 adapter registry |
| `packages/server-runtime` | 本地 WS hub（`pnpm dev:server`，`:6121`） |
| `services/minecraft` | Minecraft bot + game-coop |
| `services/game-bridges` | 星露谷 / 饥荒文件桥 |
| `docs/` | VitePress + `handbook/` 工程契约 + `records/` 归档计划 |

桌面 / 移动端树（`stage-tamagotchi`、`stage-pocket`）可能仍在仓库，但根脚本与发布流水线不在此 fork 维护。

## 本地开发

需要 **Node.js 23+**、`corepack` + **pnpm**。细节见 [`.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md)。

```sh
corepack enable
pnpm install

pnpm dev              # 网页 companion
pnpm dev:server       # server-runtime WS
pnpm dev:docs         # 文档站
pnpm build
pnpm test:run
pnpm lint && pnpm typecheck
```

游戏陪玩一键：`pnpm dev:play`。配置用 `.env.play.local` 或已有的 `services/minecraft/.env.local`（后者加两行 `VITE_VOLCENGINE_*` 即可）。

## 工程文档

面向贡献者与 agent 的稳定边界说明在 [`handbook/`](./handbook/)：

- [`architecture.md`](./handbook/architecture.md) — 包所有权与运行时边界
- [`game-companion.md`](./handbook/game-companion.md) — 游戏陪玩分层（语音 / 决策 / 适配器）
