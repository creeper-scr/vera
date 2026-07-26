---
title: 异星工厂
description: Factorio 设置残桩说明（本仓库无可用 bot / adapter）
---

设置页可保存 Factorio 的服务器地址、端口和游戏内用户名（默认端口 `34197`），但本仓库**没有** Factorio bot / game-coop adapter。保存「已配置」只表示三个字段已填写，**不等于可游玩**。

本 fork 维护的陪玩路径：

* Minecraft — `pnpm dev:play`（见 [Minecraft 智能体](./minecraft)）
* 星露谷 / 饥荒文件桥 — `services/game-bridges`

## 前提条件（若将来接入）

* 可访问的 Factorio 服务器，以及实际存在的服务端集成（本仓库未提供）。
* 服务器地址、端口和游戏内用户名。

::: warning 仅连接受信任的服务器
不要将游戏凭据用于不受信任的公共服务器，也不要在公共聊天、截图或 Issue 中公开服务器地址、令牌或账号信息。
:::

## 在 Vera 中配置（设置残桩）

1. 打开 **设置 → 机体模块 → 异星工厂（Factorio）**。
2. 启用 Factorio 集成。
3. 填写服务器地址、端口和你的游戏内用户名；默认端口为 `34197`。
4. 点击 **保存**。页面显示“已配置”仅代表字段已填写。

## 排查

* 若期望可交互陪玩：请改用 Minecraft 或 `services/game-bridges`，不要假设 Factorio 已接线。
* 桌面端（`stage-tamagotchi`）不是本 fork 的一等产品表面；网页 companion 是 `apps/stage-web`。
