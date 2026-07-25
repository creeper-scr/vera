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
- Experimental web console / Doubao voice paths live under `src/composables/webConsole.ts` and related pages — not a full Live2D companion stack.
- User-facing docs: [VitePress manual](https://vera.moeru.ai/docs/).
