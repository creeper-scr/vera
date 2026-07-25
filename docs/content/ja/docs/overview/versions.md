---
title: バージョン一覧
description: Vera の異なるバージョンと入手方法
---

<script setup>
import ReleaseDownloads from '../../../../.vitepress/components/ReleaseDownloads.vue'
import ReleasesList from '../../../../.vitepress/components/ReleasesList.vue'
</script>

## Release をダウンロード

GitHub Releases には upstream / 過去のデスクトップビルドが残っている場合があります。**この fork で維持しているのはソースからの Web companion**（`pnpm dev`）です。旧 `release-tamagotchi.yml` などの Nightly ワークフローは **ここでは提供しません**。

<ReleaseDownloads />

### 最近の Release

<ReleasesList type="releases" :limit="5" />

[GitHub で以前のすべてのリリースを見る →](https://github.com/moeru-ai/airi/releases)

## ソースから実行（推奨）

```sh
corepack enable
pnpm install
pnpm dev
```

詳細は [Contributing](../contributing/) を参照（ゲーム連携の `pnpm dev:server` 含む）。
