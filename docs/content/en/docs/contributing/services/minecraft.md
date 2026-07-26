---
title: Minecraft
description: Contribute to Project Vera
---

### Minecraft agent

```shell
cd services/minecraft
```

Start a Minecraft client, export your world with desired port, and fill-in the port number in `.env.local`.

Configure `.env.local` from the example

```shell
cp .env.example .env.local
```

Edit the credentials in `.env.local`.

For the full companion loop (web + WS hub + bot + Doubao relay) from repo root:

```shell
pnpm dev:play
```

Layering: `docs/handbook/game-companion.md`.

Run the bot alone

```shell
pnpm -F @proj-vera/minecraft-bot start
```

::: tip

For [@antfu/ni](https://github.com/antfu-collective/ni) users, you can

```shell
nr -F @proj-vera/minecraft-bot dev
```

:::
