---
title: 版本与下载
description: Vera 的不同版本以及如何获取它们
---

<script setup>
import ReleaseDownloads from '../../../../.vitepress/components/ReleaseDownloads.vue'
import ReleasesList from '../../../../.vitepress/components/ReleasesList.vue'
</script>

## 下载 Release

GitHub Releases 上可能仍有上游 / 历史桌面构建。**本 fork 维护路径是从源码跑网页 companion**（`pnpm dev`）。桌面 Nightly 流水线（原 `release-tamagotchi.yml`）**已不在此树维护**。

<ReleaseDownloads />

### 最近的 Release

<ReleasesList type="releases" :limit="5" />

[在 GitHub 上查看所有版本 →](https://github.com/moeru-ai/airi/releases)

## 从源码运行（本仓库推荐）

```sh
corepack enable
pnpm install
pnpm dev
```

完整本地步骤与游戏陪玩（`pnpm dev:server`）见[开发者指南](../contributing/)。
