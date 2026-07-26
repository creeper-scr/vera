# Game-Coop Core

Game-neutral contracts and adapter registry for cooperative game agents.

## Contracts

Implement `GameAdapter` in a game service. Capabilities, environment, execute / observe / cancel, and action lifecycle IDs live here — not in Vue, Electron, provider, or LLM packages.

`GameExecutionPort` extends `GameAdapter`. In-process multi-adapter hosts may use `createGameAdapterRegistry()` to aggregate catalogs, reject capability ID collisions, and route commands / cancellation. Registry usage today is mainly tests and in-process hosts.

## Product path in this repo

Browser companion does **not** register adapters in-process. Service processes hold the real adapter; the web stage attaches via `ServerGameAdapter` + `server-runtime` WS (`module:${adapterId}-bot`), then `createGameMcpClient` / `CompanionAgentRuntime`. See [`docs/handbook/game-companion.md`](../../docs/handbook/game-companion.md).

## Use this package when

- Agent logic needs a dynamic game capability catalog.
- A game service needs to expose commands without leaking its SDK into Core.
- Action progress and cancellation need stable session, turn, and action IDs.

## Do not use this package for

- Vue, Electron, provider, LLM, STT, or TTS integration.
- Game-specific action IDs or input schemas.
- Transport wiring. Server-channel / file-bridge transport belongs to `stage-ui` / `services/*`.
