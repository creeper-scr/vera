# Architecture

## Product surfaces

**First-class in this fork** (see root `README.md` / `pnpm` scripts):

| Path | Role |
|------|------|
| `apps/stage-web` | Browser companion (Vite + Vue). Default `pnpm dev` target. No hosted login — providers in local settings. |
| `apps/server` | Hosted Hono API (auth, billing, LLM gateway, WebSocket). Optional for local companion; needs Postgres/Redis. |
| `packages/stage-ui` | Shared stage business UI, Pinia stores, game-coop session glue. |
| `packages/core-agent` | Platform-neutral turn policy, companion agent, game-action runtime. |
| `packages/game-coop-core` | `GameAdapter` / `GameExecutionPort` contracts and registry. |
| `packages/server-runtime` | Local WS hub for `game:coop:*` (`pnpm dev:server`, `:6121`). |
| `packages/ui` | Reusable Reka UI primitives. |
| `packages/i18n` | Translations. |
| `packages/server-*` | Server schema, SDK, shared protocol (plus `server-runtime` above). |
| `services/minecraft` | Mineflayer bot + game-coop adapter (`module:minecraft-bot`). |
| `services/game-bridges` | Stardew / DST file bridges (`module:stardew-bot` / `module:dst-bot`). |

**Residual / not release-maintained here**: `apps/stage-tamagotchi`, `apps/stage-pocket`, orphan auth-UI trees. Prefer `stage-web`. Auth redirects on `apps/server` use external `AUTH_UI_URL`.

## Chat turn boundary

`stage-ui` selects session, provider, model, context, and tools. `core-agent` owns FIFO sends, generation guards, prompt composition, normalized streaming, finalized history, and hooks. Apps own browser transport and UI projection.

Use `ChatOrchestratorSendOptions` for per-turn settings. Feed observations through `ContextUpdate`; perform side effects through typed tools or `spark:command`. Do not import Pinia, browser APIs, or provider SDKs into `core-agent`.

## Game companion boundary (summary)

Full layering: [`game-companion.md`](./game-companion.md).

- **Layer 1 (voice / chat media)**: realtime ASR/TTS (e.g. Doubao). Speaks only; does not call game tools.
- **Layer 2 (decision)**: `CompanionAgentRuntime` / `GameActionRuntime` in `core-agent`, wired by `createCompanionSession` / `useCompanionSession` in `stage-ui`.
- **Layer 3 (world)**: `GameExecutionPort` implementations (Minecraft adapter, server adapter, fakes in tests).

`stage-web` owns the companion UI and attaches to remote adapters over `server-runtime` WS. Shared contracts stay in `game-coop-core` / `core-agent`, not in app-local types.

## Ownership rules

- Shared policy and ports: `packages/core-agent`, `packages/game-coop-core`.
- Platform adapters and reactive stores: `packages/stage-ui`.
- Web companion UI / attach: `apps/stage-web`.
- Cross-module websocket envelopes: `packages/plugin-protocol` and server re-exports.
- External integrations: owning `services/*` or package boundary — never drive world actions from model prose alone.

Keep this page short. Durable feature decisions go in `docs/records/` when needed; active contracts stay in `docs/handbook/`. Do not fork a second architecture narrative.
