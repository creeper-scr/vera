# `@proj-vera/server`

HTTP and WebSocket backend for Vera. This app owns auth, billing, chat synchronization, gateway forwarding, and server-side observability export.

## What It Does

- Serves the Hono-based API and WebSocket endpoints.
- Uses Postgres as the source of truth for users, billing, and durable state.
- Uses Redis for cache, KV, Pub/Sub, and Streams.
- Forwards GenAI requests to the configured upstream gateway and records billing from usage.
- Exports traces, metrics, and logs through OpenTelemetry.

## How To Use It

Install dependencies from the repo root and run scoped commands:

```sh
pnpm -F @proj-vera/server typecheck
pnpm -F @proj-vera/server exec vitest run
pnpm -F @proj-vera/server build
```

For local observability infrastructure, use:

```sh
docker compose -f apps/server/docker-compose.otel.yml up -d
```

## `AUTH_UI_URL`

The API server still owns the historical `/auth/*` entrypoints and redirects them to **`AUTH_UI_URL`**.

The upstream auth UI package (`@proj-airi/ui-server-auth`) is **not** a workspace package in this fork (no `package.json` / not built here). Point `AUTH_UI_URL` at an externally hosted auth UI.

Default:

`AUTH_UI_URL=https://accounts.vera.build/ui`

Set this when previewing or deploying auth UI to a different URL.

## `ADMIN_UI_URL`

The admin UI is deployed from the standalone `proj-vera` repository. The API server still owns the historical `/admin/*` entrypoints and redirects them to **`ADMIN_UI_URL`**.

Default:

`ADMIN_UI_URL=https://admin.vera.build`

Set this when previewing or deploying admin UI to a different Cloudflare URL.

## `ADDITIONAL_TRUSTED_ORIGINS` (LAN / Capacitor dev)

When the mobile dev server uses a non-localhost origin (for example `https://10.x.x.x:5273` from `cap copy ios` / `capacitor.config.json`), set **`ADDITIONAL_TRUSTED_ORIGINS`** in `apps/server/.env.local` to a comma-separated list of exact origins (parsed and normalized at startup). Example:

`ADDITIONAL_TRUSTED_ORIGINS=https://10.0.0.129:5273,https://198.18.0.1:5273`

Restart the API server after changing this variable.
