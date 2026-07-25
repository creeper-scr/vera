---
title: Project Vera 是什么？
description: 了解 Project Vera 的定位、能力与上手方式
---

### 太长不看

Project Vera 是一个开源的 AI VTuber / 数字伙伴项目。你可以把它理解为：

- 受 [Neuro-sama](https://www.youtube.com/@Neurosama) 启发的开源复刻方向；
- [Grok Companion](https://news.ycombinator.com/item?id=44566355) 这类数字陪伴产品的开源替代方案；
- 一个不只聊天，还支持 Live2D、VRM、语音、角色卡、游戏智能体和应用上下文感知的 [SillyTavern](https://github.com/SillyTavern/SillyTavern)（酒馆）延伸。

## 本仓库当前主路径

此 fork **优先维护**浏览器 companion（`apps/stage-web`）与游戏陪玩闭环（`server-runtime` + Minecraft / 文件桥）。**没有托管登录 / 账号 UI** —— 在设置里本地配置 LLM 服务商。

常见入口：

- `apps/stage-web`：默认 `pnpm dev`
- `packages/server-runtime`：`pnpm dev:server`（`ws://localhost:6121/ws`）
- `services/minecraft`、`services/game-bridges`：游戏适配器
- `apps/server`：可选托管 API（Postgres / Redis）
- `packages/stage-ui`、`packages/core-agent`、`packages/game-coop-core`：共享舞台与 agent 契约

`stage-tamagotchi` / `stage-pocket` 等树可能仍在仓库里，但根脚本与发布流水线**不**再维护；请优先用网页端。

## 可以做什么

- 通过 OpenAI 兼容接口、OpenRouter、DeepSeek、Ollama 等为角色配置「大脑」；
- 用角色卡定义名字、性格与模块模型；
- 在网页端聊天，并按需配置 TTS / ASR；
- 从源码跑 Minecraft / 星露谷 / 饥荒等游戏陪玩实验能力。

## 开始使用

<div flex gap-2 w-full justify-center text-xl>
  <div w-full flex flex-col items-center gap-2 border="2 solid gray-500/10" rounded-lg px-2 pt-6 pb-4>
    <div flex items-center gap-2 text-5xl>
      <div i-lucide:app-window />
    </div>
    <span>网页端</span>
    <a href="https://airi.moeru.ai/" target="_blank" decoration-none class="text-primary-900 dark:text-primary-400 text-base not-prose bg-primary-400/10 dark:bg-primary-600/10 block px-4 py-2 rounded-lg active:scale-95 transition-all duration-200 ease-in-out">上游演示</a>
  </div>
  <div w-full flex flex-col items-center gap-2 border="2 solid gray-500/10" rounded-lg px-2 pt-6 pb-4>
    <div flex items-center gap-2 text-5xl>
      <div i-lucide:terminal />
    </div>
    <span>从源码</span>
    <a href="../contributing/" decoration-none class="text-primary-900 dark:text-primary-400 text-base not-prose bg-primary-400/10 dark:bg-primary-600/10 block px-4 py-2 rounded-lg active:scale-95 transition-all duration-200 ease-in-out">
      开发
    </a>
  </div>
</div>

仓库根目录：`pnpm install` → `pnpm dev`。游戏闭环再加 `pnpm dev:server` 与对应 service。

<div flex gap-2 w-full flex-col justify-center text-base>
  <a href="../manual/web/" w-full flex items-center gap-2 border="2 solid gray-500/10" rounded-lg px-4 py-2>
    <div w-full flex items-center gap-2>
      <div flex items-center gap-2 text-2xl>
        <div i-lucide:app-window />
      </div>
      <span>网页端</span>
    </div>
    <div class="text-gray-900 dark:text-gray-200 text-base not-prose rounded-lg active:scale-95 transition-all duration-200 ease-in-out text-nowrap">
      如何使用？
    </div>
  </a>
  <a href="../manual/config/" w-full flex items-center gap-2 border="2 solid gray-500/10" rounded-lg px-4 py-2>
    <div w-full flex items-center gap-2>
      <div flex items-center gap-2 text-2xl>
        <div i-lucide:settings />
      </div>
      <span>服务商</span>
    </div>
    <div class="text-gray-900 dark:text-gray-200 text-base not-prose rounded-lg active:scale-95 transition-all duration-200 ease-in-out text-nowrap">
      配置 LLM / 语音
    </div>
  </a>
</div>

## 给开发者

主技术栈：Vue 3、TypeScript、Vite、Pinia、VueUse、UnoCSS、Vitest；服务侧 Hono + Drizzle；模型 I/O 多用 `xsai`。

工程契约见 [`docs/handbook/`](../../../../handbook/)（架构与游戏陪玩分层）。贡献步骤见[开发者指南](../contributing/)。

::: warning 实验性功能
游戏智能体、机器人、插件等能力可能仍需从源码配置。稳定路径以网页 companion + 本地服务商配置为准。
:::
