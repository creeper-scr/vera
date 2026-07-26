---
title: コントリビューション
description: Project Vera への貢献
---

こんにちは！このプロジェクトへの貢献に興味を持っていただきありがとうございます。このガイドは、あなたが始めるのに役立ちます。

## 前提条件

- [Git](https://git-scm.com/downloads)
- [Node.js 23+](https://nodejs.org/en/download/)
- [corepack](https://github.com/nodejs/corepack)
- [pnpm](https://pnpm.io/installation)

<details>
<summary>Windows のセットアップ</summary>

0. PowerShell を開く
1. [`scoop`](https://scoop.sh/) をインストール

   ```powershell
   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
   Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
   ```

2. `scoop` を使って `git`, Node.js をインストール

   ```powershell
   scoop install git nodejs
   ```

3. `corepack` を使って `pnpm` をインストール

   ```powershell
   corepack enable
   corepack prepare pnpm@latest --activate
   ```

</details>

<details>
<summary>macOS のセットアップ</summary>

0. Terminal (または iTerm2, Ghostty, Kitty など) を開く
1. `brew` を使って `git`, `node` をインストール

   ```shell
   brew install git node
   ```

2. `corepack` を使って `pnpm` をインストール

   ```shell
   corepack enable
   corepack prepare pnpm@latest --activate
   ```

</details>

<details>
<summary>Linux のセットアップ</summary>

0. Terminal を開く
1. [nodesource/distributions: NodeSource Node.js Binary Distributions](https://github.com/nodesource/distributions?tab=readme-ov-file#table-of-contents) に従って `node` をインストール
2. [Git](https://git-scm.com/downloads/linux) に従って `git` をインストール
3. `corepack` を使って `pnpm` をインストール

   ```shell
   corepack enable
   corepack prepare pnpm@latest --activate
   ```
</details>

## 以前にこのプロジェクトに貢献したことがある場合

::: warning

このリポジトリをクローンしていない場合は、このセクションをスキップしてください。

:::

ローカルリポジトリがアップストリームリポジトリと最新の状態であることを確認してください：

```shell
git fetch --all
git checkout main
git pull upstream main --rebase
```

作業中のブランチがある場合、ブランチをアップストリームリポジトリと最新の状態にするには：

```shell
git checkout <your-branch-name>
git rebase main
```

## このプロジェクトをフォークする

[moeru-ai/airi](https://github.com/moeru-ai/airi) ページの右上にある **Fork** ボタンをクリックしてください。

## クローン

```shell
git clone https://github.com/<your-github-username>/airi.git
cd airi
```

## 作業用ブランチを作成する

```shell
git checkout -b <your-branch-name>
```

## 依存関係のインストール

```shell
corepack enable
pnpm install
```

::: tip

スクリプトを簡単にするために [@antfu/ni](https://github.com/antfu-collective/ni) のインストールをお勧めします。

```shell
corepack enable
npm i -g @antfu/ni
```

インストールしたら、以下のように使用できます

- `pnpm install`, `npm install`, `yarn install` の代わりに `ni` を使用。
- `pnpm run`, `npm run`, `yarn run` の代わりに `nr` を使用。

パッケージマネージャーを気にする必要はありません。`ni` が適切なものを選択してくれます。
:::

## 開発したいアプリケーションを選択する

この fork の第一級サーフェスは **Web companion**、**ローカル WS hub**、**ゲーム adapter**。ホスト型ログインは無し — 設定画面でプロバイダを構成。エンジニアリング契約は本リポジトリの `docs/handbook/`（`architecture.md`、`game-companion.md`）。

### Stage Web（デフォルト）

```shell
pnpm dev
```

### ローカル WS hub + game coop

```shell
pnpm dev:server
pnpm -F @proj-vera/minecraft-bot start
# または: pnpm -F @proj-vera/game-bridges start
```

### Docs

```shell
pnpm dev:docs
```

### Hosted API（任意）

```shell
pnpm -F @proj-vera/server dev
```

Postgres / Redis と `apps/server/.env.local` が必要。

## コミット

### コミットの前に

::: warning

リント (静的チェッカー) と TypeScript コンパイラが満たされていることを確認してください：

```shell
pnpm lint && pnpm typecheck
```

:::

::: tip

[@antfu/ni](https://github.com/antfu-collective/ni) がインストールされている場合は、`nr` を使用してコマンドを実行できます：

```shell
nr lint && nr typecheck
```

:::

### コミット

```shell
git add .
git commit -m "<your-commit-message>"
```

### フォークリポジトリへのプッシュ

```shell
git push origin <your-branch-name> -u
```

フォークリポジトリでブランチを閲覧できるはずです。

::: tip

このプロジェクトへの貢献が初めての場合は、アップストリームリポジトリも追加する必要があります：

```shell
git remote add upstream https://github.com/moeru-ai/airi.git
```

:::

## プルリクエストの作成

[moeru-ai/airi](https://github.com/moeru-ai/airi) ページに移動し、**Pull requests** タブをクリックし、**New pull request** ボタンをクリックします。**Compare across forks** リンクをクリックし、あなたのフォークリポジトリを選択します。

変更を確認し、**Create pull request** ボタンをクリックします。

## やったー！できました！

おめでとうございます！このプロジェクトへの最初の貢献を行いました。メンテナーがプルリクエストをレビューするのを待つことができます。
