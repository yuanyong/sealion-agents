# Craft Agents Web

Web version of Craft Agents — a browser-based interface for the same agent functionality as the Electron desktop app.

## Architecture

```
┌─────────────────────────────┐
│   Browser Client (React)    │  ← Reuses Electron renderer components
│   + WebAPI Adapter          │  ← Replaces window.electronAPI with HTTP/WS
└──────────┬──────────────────┘
           │ HTTP REST + WebSocket
┌──────────▼──────────────────┐
│   Hono Backend Server       │  ← Replaces Electron main process
│   + @craft-agent/shared     │  ← Same business logic packages
└─────────────────────────────┘
```

### Key Design Decisions

1. **WebAPI Adapter** (`src/client/web-api.ts`): Implements the same `ElectronAPI` interface using `fetch()` and WebSocket. This allows all existing renderer code to work without modification.

2. **Shims** (`src/client/shims/`): Replace Electron-specific modules (`@sentry/electron`, `electron-log`) with browser-compatible alternatives.

3. **Desktop Feature Adaptations**:
   - Window management → Browser tabs/URL routing
   - File dialogs → Web File API / `showDirectoryPicker`
   - Auto-update → Not needed for web
   - Notifications → Web Notifications API
   - System theme → `prefers-color-scheme` media query
   - Menu shortcuts → Keyboard event listeners
   - Badge count → Document title

## Development

```bash
# Start both server and client in dev mode
bun run web:dev

# Or start them separately:
bun run web:dev:server   # Backend: http://localhost:3001
bun run web:dev:client   # Frontend: http://localhost:3000 (proxies API to 3001)
```

## Production Build

```bash
bun run web:build    # Builds both client and server
bun run web:start    # Starts production server (serves built client + API)
```

## Project Structure

```
apps/web/
├── src/
│   ├── client/              # Web client entry point
│   │   ├── main.tsx         # React entry (replaces Electron renderer main.tsx)
│   │   ├── web-api.ts       # ElectronAPI → HTTP/WS adapter
│   │   ├── index.html       # HTML template
│   │   ├── index.css        # Styles (Tailwind)
│   │   └── shims/           # Electron module replacements
│   │       ├── sentry.ts
│   │       ├── electron-log.ts
│   │       └── electron-log-renderer.ts
│   └── server/
│       └── index.ts         # Hono backend server
├── vite.config.ts           # Vite config (shares renderer via @/ alias)
├── tsconfig.json            # TypeScript config
└── package.json
```
