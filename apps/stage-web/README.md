# `@proj-vera/stage-web`

Browser stage for Project Vera (Vite + Vue). Default target of root `pnpm dev`.

## Commands

```sh
pnpm -F @proj-vera/stage-web dev
pnpm -F @proj-vera/stage-web dev:https
pnpm -F @proj-vera/stage-web build
pnpm -F @proj-vera/stage-web typecheck
```

From repo root: `pnpm dev` / `pnpm build:web`.

## Notes

- Shared stage UI and stores come from `@proj-vera/stage-ui`.
- Companion / Doubao voice product path: `src/pages/index.vue` → `@proj-vera/stage-ui` `useCompanionSession`. Layering: [`docs/handbook/game-companion.md`](../../docs/handbook/game-companion.md).
- User-facing docs: local `pnpm dev:docs`; upstream publish [airi.moeru.ai/docs](https://airi.moeru.ai/docs/).
