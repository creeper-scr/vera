# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are people who want to play games but have no one available to join them — often after work or in other scarce free time — and feel lonely when friends do not show up. Their job is not “get better at the game”; it is to have companionship and shared presence inside a world they already care about.

Secondary audiences (contributors, streamers) exist around the open-source stack, but they are not the primary job this product is built for.

## Product Purpose

Deliver an AI agent that enters the player’s game world and acts with them — follow, mine, clear blocks, and similar co-presence — so the world does not feel empty when friends are offline.

Success today means a player can open Minecraft, attach the agent, and feel someone is there doing things beside them. Success later means the same relationship formed in-game can extend beyond a single title and, eventually, beyond the game session itself — without claiming that life-outside-game capabilities already ship.

## Positioning

This is not a chat-only “how do I play” bot and not a substitute for real friends. The mechanism that neighboring products cannot truthfully copy without the same stack is: **the agent acts inside the game** (presence + basic co-action), starting from Minecraft and expanding to more worlds.

Strategic arc (confirmed intent): start from games as the meeting place; build toward an agent that understands the person and can enter more of their life. Game companionship is the wedge, not the entire long-term identity.

Public product, companion, and stack identity: **Vera** (also **Project Vera**). This repository is a fork of Moeru Project AIRI (historical upstream lineage only — not the current brand). Early promo drafts used “Soul” as a placeholder — replace with Vera in any shipping copy.

## Operating Context

- Player runs a game client/server they already use (today: Minecraft; in progress: Don’t Starve, Stardew Valley).
- Web UI (`apps/stage-web`) is the only frontend surface for this product; desktop/mobile app trees may exist in the monorepo but are not the maintained product surface here.
- Local play path: web stage + WebSocket hub + game adapter (e.g. `pnpm dev` / `pnpm dev:play` with Minecraft bot).
- Shared stage/agent contracts live in packages such as `stage-ui`, `core-agent`, and `game-coop-core`; game adapters live under `services/`.

## Capabilities and Constraints

**Shipped (Minecraft):**

- Agent joins the same world/server as the player (co-presence).
- Follow the player.
- Mine / dig on basic instruction.
- Break / clear blocks in a directed area.
- Conversational personality over voice or chat while acting in-world.

**In progress:**

- Don’t Starve and Stardew Valley adapters (not yet equivalent to Minecraft readiness).

**Explicit non-claims for current product:**

- Not an autonomous master builder, combat partner, or full adventure completer.
- Does not replace real friends.
- Cross-device continuity, long-term shared memory, and real-world life assistance are vision — must be labeled as vision in any marketing or UI, not presented as shipped.

**Open / undecided:**

- Hosted vs fully self-hosted commercial packaging for this fork.
- Accessibility standard beyond ordinary web expectations (none product-mandated yet).

## Brand Commitments

- Name: **Vera** (preferred casing in prose: Vera; stack: Project Vera). In-game join / character references should use Vera, not Soul or AIRI.
- Companion presence framing from confirmed promo script: lonely player, empty world still running, agent that waits / joins / acts with you.
- Confirmed taglines / lines for messaging continuity (swap any draft “Soul” → Vera):
  - 「这一次，有人在等你上线。」
  - “An AI companion that acts inside Minecraft.”
  - Vision line: “One Vera. Beyond the game.” / 「游戏，是你们相遇的地方。但不一定是陪伴结束的地方。」
- Tone for the loneliness problem: restrained and empathetic first; product demo warm and light; vision clearly separated from current capability.
- Repo/legal signals: open-source Vera / Project Vera (fork of Moeru Project AIRI); project states it has no official cryptocurrency or token — do not invent crypto/token claims. Do not present AIRI as the current product brand.
- Do not invent testimonials, user counts, or capabilities beyond the confirmed list.

## Evidence on Hand

- Promo video script (user-provided): full narrative, capability list, and production boundaries (current vs vision).
- Runnable surfaces in repo: `apps/stage-web`, `services/minecraft`, `services/game-bridges`, docs under `docs/`.
- Upstream try/docs site `airi.moeru.ai` is Moeru Project AIRI presence, not this fork’s product face.
- No customer testimonials or case studies confirmed for fabrication-free marketing; future work must not invent them.

## Product Principles

1. **Presence over advice** — Prefer being in the world and doing something together over explaining the game from outside it.
2. **Honest capability** — Show follow / mine / break as real; never sell vision (life beyond game, autonomous mastery) as current product.
3. **Companionship first** — Optimize for “someone is here with me,” not leaderboard performance or full automation.
4. **Games as the door** — New worlds and deeper understanding expand from shared play; do not reverse into a generic life-assistant pitch that forgets the game wedge.
5. **One continuous Vera** — Character, voice, and relationship continuity matter across sessions and, later, across surfaces; implementations may lag, but messaging should not fragment the companion into disposable tools.
