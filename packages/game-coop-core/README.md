# Game-Coop Core

Game-neutral contracts and adapter registry for cooperative game agents.

## Use

Implement `GameAdapter` in a game service, register it with
`createGameAdapterRegistry()`, then give the returned `GameExecutionPort` to
the agent core.

Adapters declare capabilities per session. The registry aggregates that
catalog, rejects capability ID collisions, routes commands and cancellation,
and forwards only valid action lifecycle events.

## Use this package when

- Agent logic needs a dynamic game capability catalog.
- A game service needs to expose commands without leaking its SDK into Core.
- Action progress and cancellation need stable session, turn, and action IDs.

## Do not use this package for

- Vue, Electron, provider, LLM, STT, or TTS integration.
- Game-specific action IDs or input schemas.
- Transport wiring. Eventa and server-channel bridges belong to Integration.
