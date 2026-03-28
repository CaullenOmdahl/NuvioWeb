# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NuvioTV Web is a vanilla JavaScript TV streaming app that runs in browsers and powers lightweight wrappers for Samsung Tizen and LG webOS. It integrates with the Stremio addon ecosystem for content discovery and source resolution. Status: BETA.

## Build & Development Commands

```bash
npm install              # Install dependencies (only esbuild)
npm run build            # Bundle with esbuild → dist/
npm run serve            # Local dev server
python3 -m http.server 8080 -d dist  # Alternative: serve built output

# Deploy to wrapper projects
npm run sync:webos -- /absolute/path/to/project
npm run sync:tizen -- /absolute/path/to/project
npm run sync:tizenbrew
```

There are no tests, linters, or type checkers configured.

## Architecture

### Tech Stack
- **Vanilla JavaScript** (ES modules, no framework) — intentional for TV performance
- **esbuild** — bundles `js/app.js` → `app.bundle.js` (IIFE, ES2015 target)
- **No TypeScript, no CSS framework** — plain CSS split into base/layout/components/themes
- **Supabase** for auth and cloud sync; **Stremio addon protocol** for content APIs

### Runtime Environment
Config is injected via `nuvio.env.js` (loaded before the bundle in `index.html`). The build copies `nuvio.env.js` → `dist/`, falling back to `nuvio.env.example.js` or generating defaults. Key vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TMDB_API_KEY`, `PREFERRED_PLAYBACK_ORDER`.

### Source Layout (`js/`)

| Directory | Purpose |
|-----------|---------|
| `app.js` | Entry point — bootstrap sequence |
| `bootstrap/` | App shell HTML injection, addon remote mode |
| `config.js` | Reads `globalThis.__NUVIO_ENV__` into typed exports |
| `core/auth/` | AuthManager (pub-sub state machine: LOADING → SIGNED_OUT / AUTHENTICATED) |
| `core/player/` | PlayerController — multi-engine: native video, HLS.js, DASH.js, platform Avplay |
| `core/player/engines/` | Per-engine implementations selected by `PREFERRED_PLAYBACK_ORDER` |
| `core/profile/` | Sync services — orchestrated startup sync, 120s cycle, debounced pushes |
| `core/network/` | `httpClient.js` (fetch wrapper with auth token), `safeApiCall()` → `NetworkResult` |
| `core/storage/` | `localStore.js` / `sessionStore.js` — localStorage/sessionStorage wrappers |
| `data/local/` | Profile-scoped localStorage stores (theme, player settings, watch progress, etc.) |
| `data/remote/api/` | API clients: catalog, meta, stream, subtitle, addon |
| `data/remote/dto/` | Data transfer objects mapping API responses |
| `data/remote/supabase/` | Supabase REST/RPC client |
| `data/repository/` | Repository pattern — high-level data access with caching |
| `domain/model/` | Factory functions for domain objects (not classes) |
| `i18n/` | 15 languages, key aliasing, `I18n.t(key, params, { fallback })` |
| `platform/` | Adapter pattern: `browserAdapter`, `webosAdapter`, `tizenAdapter` — key normalization, capabilities, exit handling |
| `runtime/` | Polyfills, environment detection, deferred HLS/DASH library loading |
| `ui/screens/` | Screen-per-route (home, player, detail, library, search, settings, account, etc.) |
| `ui/navigation/` | Hash-based Router, FocusEngine (D-pad/keyboard), ScreenUtils |
| `ui/components/` | DOM-building factory functions (not JSX) — catalogRow, heroCarousel, holdMenu, etc. |
| `ui/theme/` | ThemeManager applies CSS custom properties to document root |

### Key Patterns

**Bootstrap sequence** (`app.js`): renderAppShell → Platform.init → I18n.init → Router/PlayerController/FocusEngine init → ThemeManager/I18n apply → warmStreamingLibs (1.4s delay) → AuthManager.bootstrap

**Screens**: Mount/unmount lifecycle. All implement optional `onKeyDown()`, `onKeyUp()`, `consumeBackRequest()`. Router manages a stack-based navigation history. Three home layouts: modern, grid, classic.

**Platform abstraction**: Runtime detection of webOS (PalmSystem/webOS globals), Tizen (tizen global/UA), or browser fallback. Each adapter provides: key normalization, capabilities list, exit behavior, video element preparation.

**Player multi-engine**: PlayerController tries engines in preference order. Falls back on failure. Codec detection for webOS audio restrictions (no DTS/TrueHD). Progress tracked every 15s.

**Data flow**: Screen → Repository.fetch() → API (httpClient + safeApiCall) → DTO mapping → domain model → cache + render. Cloud sync via profile-scoped stores with 1.5s debounced pushes.

**Performance mode**: TV platforms and low-end devices (≤4 cores or ≤2GB RAM) get `.performance-constrained` CSS class. Streaming libs are lazily loaded after UI renders.

### Wrapper Repositories
- webOS: `NuvioMedia/NuvioWebOS`
- Tizen: `NuvioMedia/NuvioTVTizen`

The sync commands copy built output into these wrapper projects for packaging.
