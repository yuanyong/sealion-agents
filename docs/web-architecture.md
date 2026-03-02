# Web Architecture

This document describes how the Electron desktop app was converted to a web application.

## Overview

The original project is an Electron desktop app ("Craft Agents"). The web version reuses **all existing business logic** from `packages/shared` and `packages/core`, replacing only the Electron IPC layer with an HTTP/WebSocket server.

```
┌─────────────────────────────────────────────────────────┐
│  Electron App                    Web App                 │
│                                                          │
│  Renderer (React) ──IPC──> Main Process   Browser ──HTTP/WS──> Hono Server │
│                              │                                │             │
│                         packages/shared              packages/shared        │
│                         packages/core                packages/core          │
└─────────────────────────────────────────────────────────┘
```

## Directory Structure

```
apps/
  electron/          Original Electron desktop app
  web/               New web app
    src/
      client/        Browser-side code
        main.tsx     Entry point (installs WebAPI)
        web-api.ts   Implements ElectronAPI over HTTP/WebSocket
        index.html   HTML template
        index.css    Tailwind CSS
        shims/       Browser stubs for Electron-specific modules
          sentry.ts
          electron-log.ts
          electron-log-renderer.ts
      server/
        index.ts     Hono HTTP server (replaces Electron main process)
    vite.config.ts   Vite config (shares renderer code via path aliases)
    tsconfig.json
    package.json
```

## Key Design Decisions

### 1. WebAPI Adapter Pattern

The Electron renderer uses `window.electronAPI` (100+ methods) for all IPC calls. The web client implements the same interface using `fetch` and `WebSocket`, installed via `installWebAPI()` before React mounts.

This means **the entire React UI is reused unchanged** from `apps/electron/src/renderer`.

### 2. Vite Path Aliases

`apps/web/vite.config.ts` maps `@/` → `apps/electron/src/renderer` so the web client directly imports and compiles the Electron renderer source.

Electron-specific imports are shimmed:
- `@sentry/electron/renderer` → no-op stub
- `electron-log/renderer` → `console.*` wrapper

### 3. Hono Server

The web server (`apps/web/src/server/index.ts`) uses [Hono](https://hono.dev/) on Bun. It:
- Exposes REST endpoints for all `electronAPI.*` methods
- Broadcasts real-time events via WebSocket (`/ws`)
- Reuses the same `@craft-agent/shared` config/storage functions as Electron main

### 4. WebSocket Event Bus

The Electron app uses IPC events (push from main → renderer). The web version replaces this with a WebSocket connection. The `WebSocketEventBus` class in `web-api.ts` handles auto-reconnect and event subscription.

## Running the Web App

```bash
# Development (server + client with hot reload)
bun run web:dev

# Production build
bun run web:build
bun run web:start
```

Environment variables:
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP server port |
| `NODE_ENV` | `development` | Environment mode |
| `E2B_API_KEY` | — | Enable E2B cloud sandboxing (see [sandbox.md](./sandbox.md)) |

## See Also

- [Sandbox Integration](./sandbox.md) — Cloud VM isolation for agent tool execution
