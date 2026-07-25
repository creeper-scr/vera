---
title: Minecraft 智能体
description: 在受信任的 Minecraft 服务器上运行 Vera 的本地游戏智能体
---

Minecraft 集成会通过 Mineflayer 连接 Vera 与 Minecraft 服务器，让智能体接收上下文、执行游戏内动作并回传状态。它面向本地开发和维护；当前实现正计划迁移到 Fabric 运行时，不建议围绕它开发新的长期功能。

## 前提条件

* 已在仓库根目录安装依赖：**pnpm i**。
* 可访问的本地或受信任 Minecraft 服务器；连接地址与端口由环境配置提供。
* 可用的 Vera 与模型服务配置。

::: warning 凭据安全
API Key、服务地址和 Minecraft 服务器凭据只应保存在本地 **.env.local** 文件中。不要提交、截图或发送这些配置。
:::

## 配置

任选一个文件（`dev:play` 优先根目录）：

* **`services/minecraft/.env.local`** — 你已有 bot 配置时，直接加两行豆包即可
* **`.env.play.local`**（根目录）— `cp .env.play.example .env.play.local`

必填：

* `OPENAI_API_KEY` — bot 侧 LLM
* `VITE_VOLCENGINE_APP_ID` / `VITE_VOLCENGINE_ACCESS_KEY` — 网页豆包实时语音（会进浏览器）
* `BOT_HOSTNAME` / `BOT_PORT` — 默认 `127.0.0.1:25565`
* `Vera_WS_BASEURL` — 默认 `ws://127.0.0.1:6121/ws`

在已有 `.env.local` 末尾追加示例：

~~~bash
VITE_VOLCENGINE_APP_ID=你的AppID
VITE_VOLCENGINE_ACCESS_KEY=你的AccessToken
~~~

## 一键启动（推荐）

~~~bash
pnpm dev:play
~~~

同时启动网页 companion、`server-runtime` WS hub 与 Minecraft bot。浏览器打开 Vite 地址 → 选择 Minecraft → attach。

## 单独启动 bot

~~~bash
pnpm -F @proj-vera/minecraft-bot dev
~~~

会读根目录 `.env.play.local`（若存在），否则 `services/minecraft/.env.local`。需另开 `pnpm dev:server` 与 `pnpm dev`。

## 安全与限制

不要将该智能体连接到不受信任的公共服务器。它会驱动本地 Minecraft 会话和网络连接；即使动作计划在隔离环境中执行，恶意服务器仍可能造成非预期行为。
