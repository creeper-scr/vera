---
title: Versions
description: Different versions of Vera and how to get them
---

<script setup>
import ReleaseDownloads from '../../../../.vitepress/components/ReleaseDownloads.vue'
import ReleasesList from '../../../../.vitepress/components/ReleasesList.vue'
</script>

## Download Releases

Upstream / historical desktop builds may still appear on GitHub Releases. **This fork’s maintained path is the web companion from source** (`pnpm dev`). Desktop nightly workflows (e.g. former `release-tamagotchi.yml`) are **not** shipped here.

<ReleaseDownloads />

### Recent Releases

<ReleasesList type="releases" :limit="5" />

[View all releases on GitHub →](https://github.com/moeru-ai/airi/releases)

## Run from source (recommended here)

```sh
corepack enable
pnpm install
pnpm dev
```

See [Contributing](../contributing/) for the full local setup, including `pnpm dev:server` for game coop.
