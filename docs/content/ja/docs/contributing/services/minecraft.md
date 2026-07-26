---
title: Minecraft
description: Project Vera への貢献
---

### Minecraft エージェント

```shell
cd services/minecraft
```

Minecraft クライアントを起動し、希望のポートでワールドを公開し、そのポート番号を `.env.local` に記入します。

`.env.example` から `.env.local` を作成

```shell
cp .env.example .env.local
```

`.env.local` 内の認証情報を編集します。

フル companion ループ（web + WS hub + bot + Doubao relay）はリポジトリルートで:

```shell
pnpm dev:play
```

レイヤリング: `docs/handbook/game-companion.md`。

ボット単体の実行

```shell
pnpm -F @proj-vera/minecraft-bot start
```

::: tip

[@antfu/ni](https://github.com/antfu-collective/ni) ユーザーの場合：

```shell
nr -F @proj-vera/minecraft-bot dev
```

:::
