---
title: Introduction
description: Get to know Project Vera
---

### TL;DR

Think of us as

- open source re-creation of [Neuro-sama](https://www.youtube.com/@Neurosama)
- open source alternative to [Grok Companion](https://news.ycombinator.com/item?id=44566355)
- a Live2D, VRM (3D), and role playing with gaming, and application
awareness specialized [SillyTavern](https://github.com/SillyTavern/SillyTavern)
alternative.

Have you dreamed about having a cyber living being (cyber waifu),
or digital companion that could play with and talk to you?

With the power of modern large language models, platforms like
[Character.ai (a.k.a. c.ai)](https://character.ai) and
[JanitorAI](https://janitorai.com/), or applications like
[SillyTavern](https://github.com/SillyTavern/SillyTavern) is already a well-enough
solution for chat based, or visual adventure game like experience.

> But, what about the abilities to play games? And see what you are coding
> at? Chatting while playing games, watching videos, and capable of doing many
> other things.

Perhaps you know [Neuro-sama](https://www.youtube.com/@Neurosama) already, she is
currently the best companion capable of playing games, chatting, and interacting
with you and the participants (in VTuber community), some call this kind of being,
"digital human" too. **Sadly, it's not open sourced, you cannot interact with her after she went offline from live stream**.

Therefore, this project, Vera, offers another possibility here:
**let you own your digital life, cyber living, easily, anywhere, anytime**.

## Getting started

This documentation tree’s **primary** surface is the **web companion** (`stage-web`). Configure LLM providers locally in settings — there is no hosted login / account UI in this fork.

<div flex gap-2 w-full justify-center text-xl>
  <div w-full flex flex-col items-center gap-2 border="2 solid gray-500/10" rounded-lg px-2 pt-6 pb-4>
    <div flex items-center gap-2 text-5xl>
      <div i-lucide:app-window />
    </div>
    <span>Web</span>
    <a href="https://airi.moeru.ai/" target="_blank" decoration-none class="text-primary-900 dark:text-primary-400 text-base not-prose bg-primary-400/10 dark:bg-primary-600/10 block px-4 py-2 rounded-lg active:scale-95 transition-all duration-200 ease-in-out">Upstream demo</a>
  </div>
  <div w-full flex flex-col items-center gap-2 border="2 solid gray-500/10" rounded-lg px-2 pt-6 pb-4>
    <div flex items-center gap-2 text-5xl>
      <div i-lucide:terminal />
    </div>
    <span>From source</span>
    <a href="../contributing/" decoration-none class="text-primary-900 dark:text-primary-400 text-base not-prose bg-primary-400/10 dark:bg-primary-600/10 block px-4 py-2 rounded-lg active:scale-95 transition-all duration-200 ease-in-out">
      Develop
    </a>
  </div>
</div>

From the repo root: `pnpm install` then `pnpm dev` for the browser stage. Game coop needs `pnpm dev:server` plus a game adapter (Minecraft / file bridges).

<div flex gap-2 w-full flex-col justify-center text-base>
  <a href="../manual/web/" w-full flex items-center gap-2 border="2 solid gray-500/10" rounded-lg px-4 py-2>
    <div w-full flex items-center gap-2>
      <div flex items-center gap-2 text-2xl>
        <div i-lucide:app-window />
      </div>
      <span>Web</span>
    </div>
    <div class="text-gray-900 dark:text-gray-200 text-base not-prose rounded-lg active:scale-95 transition-all duration-200 ease-in-out text-nowrap">
      How to use?
    </div>
  </a>
  <a href="../manual/config/" w-full flex items-center gap-2 border="2 solid gray-500/10" rounded-lg px-4 py-2>
    <div w-full flex items-center gap-2>
      <div flex items-center gap-2 text-2xl>
        <div i-lucide:settings />
      </div>
      <span>Providers</span>
    </div>
    <div class="text-gray-900 dark:text-gray-200 text-base not-prose rounded-lg active:scale-95 transition-all duration-200 ease-in-out text-nowrap">
      Configure LLM / voice
    </div>
  </a>
</div>

Desktop (`stage-tamagotchi`) / mobile (`stage-pocket`) trees may still exist in the monorepo; release and nightly pipelines for them are **not** maintained in this fork. Prefer web + from-source game companion.

## Contributing

For guides that help you understand how to contribute to this project, please refer to [Contributing](../contributing/) page.

For references to help you design and improve the UI of Project Vera, please refer to [Design Guidelines](../contributing/design-guidelines/resources) page.
