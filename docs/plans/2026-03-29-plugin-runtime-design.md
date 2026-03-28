# Plugin Runtime Design — JavaScript Scraper Execution for Web

**Date:** 2026-03-29
**Status:** Approved
**Reference:** Android TV implementation at `tapframe/NuvioTV` (`PluginRuntime.kt`, `PluginManager.kt`)

## Problem

The Android TV app executes JavaScript scrapers via QuickJS to resolve streams from plugin repositories. The web app only supports URL-template interpolation — no code execution. This means plugin repositories with `.js` scrapers don't work on the web platform.

## Goal

Port the Android plugin runtime to the web with full scraper compatibility. Any scraper written for Android (`module.exports.getStreams()`) should run unmodified on the web app.

## Architecture

```
Main Thread                              Web Worker (per scraper)
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ PluginManager                │        │ Injected Globals:            │
│   ↓                          │        │   fetch()    (proxied)       │
│ PluginRuntime (orchestrator) │◄──────►│   cheerio    (built-in)      │
│   ├─ ScraperWorkerPool (≤5)  │  post  │   CryptoJS   (bundled)       │
│   ├─ PluginDataStore         │  Msg   │   URL, URLSearchParams       │
│   └─ Repository manifest I/O │        │   btoa(), atob()             │
│                              │        │   console.*  (proxied)       │
│ StreamRepository ←── results │        │   AbortController            │
└──────────────────────────────┘        │   SCRAPER_ID, SCRAPER_SETTINGS│
                                        │   TMDB_API_KEY               │
                                        │                              │
                                        │ Execution:                   │
                                        │   var module = {exports:{}}; │
                                        │   (function(){...code...})();│
                                        │   module.exports.getStreams()│
                                        │   → postMessage results      │
                                        └──────────────────────────────┘
```

## Components

### pluginRuntime.js (rewrite)

Orchestrates scraper execution. Maintains a pool of up to 5 concurrent Web Workers. Downloads and caches scraper `.js` files. Manages repository manifests alongside existing URL-template sources (backward compatible).

Key methods:
- `executeScrapersStreaming({ tmdbId, mediaType, season, episode, onChunk })` — runs all enabled scrapers, emits results per-scraper via callback
- `executeScrapers(...)` — same but returns combined array
- `executeScraper(scraper, ...)` — runs a single scraper in a worker
- `refreshRepository(repoUrl)` — fetch manifest, download scraper code, update store
- `listSources()` — returns both legacy URL-template sources and repository scrapers

### scraperWorker.js (new)

Web Worker entry point. Receives scraper code + params via `postMessage`. Wraps code in CommonJS module pattern, injects globals, calls `getStreams()`, posts results back.

Message protocol:
```javascript
// Main → Worker
{ type: "execute", code, tmdbId, mediaType, season, episode, scraperId, settings, tmdbApiKey }

// Worker → Main (fetch proxy)
{ type: "fetch", requestId, url, method, headers, body }
// Main → Worker (fetch response)
{ type: "fetchResponse", requestId, ok, status, statusText, url, headers, body, truncated }

// Worker → Main (console proxy)
{ type: "console", level, args }

// Worker → Main (results)
{ type: "result", results: [...] }
{ type: "error", message }
```

### pluginDataStore.js (new)

Structured storage layer using LocalStore. Replaces raw key access.

Storage keys:
- `pluginRepositories` — array of repository objects
- `pluginScrapers` — array of ScraperInfo objects
- `pluginScraperCode:{scraperId}` — cached `.js` source per scraper
- `pluginScraperSettings:{scraperId}` — per-scraper settings map
- `pluginsEnabled` — global toggle (existing key, preserved)
- `pluginSources` — legacy URL-template sources (existing key, preserved)

### cheerioCompat.js (new)

Cheerio-like API running entirely inside the Web Worker. Uses a lightweight HTML parser to build a DOM tree, then exposes the jQuery-like selector/traversal API that scrapers expect.

API surface (matching Android's cheerio bridge):
- `cheerio.load(html)` → returns `$` function
- `$(selector)` / `$(selector, context)` — CSS selector queries
- `.find()`, `.filter()`, `.each()`, `.map()`, `.text()`, `.html()`, `.attr()`
- `.first()`, `.last()`, `.eq()`, `.next()`, `.prev()`, `.children()`, `.get()`, `.toArray()`
- `$.html()` — serialize back to HTML

### pluginManager.js (extend)

Add repository management methods:
- `addRepository(url)` — fetch manifest, store repo + scrapers
- `removeRepository(repoId)` — remove repo and its scrapers/code
- `refreshRepository(repoId)` — re-fetch manifest and scraper code
- `listRepositories()` — return stored repositories
- `setScraperEnabled(scraperId, enabled)` — toggle individual scraper

Existing methods preserved for backward compatibility.

## Data Structures

### Repository (from manifest URL)
```javascript
{
  id: "uuid",
  url: "https://example.com/repo",
  name: "Repository Name",
  version: "1.0.0",
  description: "...",
  author: "..."
}
```

### Repository Manifest (fetched from `{repoUrl}/manifest.json`)
```json
{
  "name": "Repository Name",
  "version": "1.0.0",
  "description": "...",
  "author": "...",
  "scrapers": [
    {
      "id": "scraper-id",
      "name": "Scraper Name",
      "version": "1.0.0",
      "filename": "scraper.js",
      "supportedTypes": ["movie", "tv"],
      "enabled": true,
      "logo": "https://...",
      "contentLanguage": ["en"],
      "formats": ["torrent", "stream"]
    }
  ]
}
```

### ScraperInfo (stored locally)
```javascript
{
  id: "repoId:scraperId",
  name: "Scraper Name",
  version: "1.0.0",
  filename: "scraper.js",
  supportedTypes: ["movie", "tv"],
  enabled: true,
  manifestEnabled: true,
  logo: null,
  contentLanguage: ["en"],
  formats: ["torrent", "stream"],
  repositoryId: "repo-uuid"
}
```

### LocalScraperResult (returned by getStreams)
```javascript
{
  url: string,           // required — stream/torrent/magnet URL
  title: string,         // required — display title
  name: string,          // alternative name
  quality: string,       // "720p", "1080p", "4K"
  size: string,          // "1.2 GB"
  language: string,      // "en", "multi"
  type: string,          // "torrent", "http"
  seeders: number,
  peers: number,
  infoHash: string,
  headers: {}            // custom HTTP headers for playback
}
```

## Execution Flow

1. `streamRepository.getPluginStreams()` calls `PluginManager.executeScrapersStreaming()`
2. PluginRuntime collects enabled scrapers matching the media type
3. Also collects enabled legacy URL-template sources
4. For each scraper (max 5 concurrent via semaphore):
   a. Load cached JS code from pluginDataStore
   b. Create a new Web Worker from `scraperWorker.js`
   c. Post execute message with code, params, settings
   d. Set 60s timeout → `worker.terminate()` on expiry
   e. Worker wraps code in module pattern, injects globals, calls `getStreams()`
   f. Worker posts back results or error
5. For legacy sources: run URL interpolation (no worker needed)
6. Results emitted via `onChunk(scraperName, results)` as each completes
7. Combined results capped at 150 items

## Fetch Proxy

Scrapers call `fetch()` inside the worker. Since workers can make fetch requests directly (same-origin policy permitting), we use the worker's native `fetch` with added constraints:

- Response body limited to 256 KB
- Default User-Agent header injected
- Timeout per request: 30s
- If CORS blocks direct fetch, fall back to proxying via postMessage to main thread

## Cheerio Implementation

Instead of proxying DOM operations to the main thread (expensive round-trips), we bundle a minimal HTML parser inside the worker. The parser builds an in-memory tree; the cheerio-compatible wrapper provides selector and traversal methods.

This approach:
- Avoids postMessage serialization overhead
- Runs entirely in the worker thread
- Matches the Android API surface (which also runs cheerio in-process)

## Backward Compatibility

Existing URL-template sources (`{ id, name, urlTemplate, enabled }`) continue to work unchanged. The `pluginSources` LocalStore key is preserved. New repository-based scrapers are stored separately. Both types feed into the same stream resolution pipeline.

The `pluginSyncService.js` is extended to sync repository URLs and scraper enabled states alongside legacy sources. Scraper `.js` code is never synced — re-downloaded from repos on each device.

## Constants (matching Android)

| Constant | Value |
|----------|-------|
| PLUGIN_TIMEOUT_MS | 60,000 ms |
| MAX_CONCURRENT_SCRAPERS | 5 |
| MAX_RESULT_ITEMS | 150 |
| MAX_FETCH_RESPONSE_BYTES | 262,144 (256 KB) |
| MAX_SCRAPER_CODE_BYTES | 5,242,880 (5 MB) |

## Files to Create/Modify

| File | Action |
|------|--------|
| `js/core/player/pluginRuntime.js` | Rewrite — repository + scraper orchestration |
| `js/core/player/pluginManager.js` | Extend — repository management methods |
| `js/core/player/scraperWorker.js` | Create — Web Worker entry point |
| `js/core/player/pluginDataStore.js` | Create — structured localStorage layer |
| `js/core/player/cheerioCompat.js` | Create — cheerio-like API with HTML parser |
| `js/data/repository/streamRepository.js` | Modify — adapt to streaming results |
| `js/ui/screens/plugin/pluginScreen.js` | Extend — repository management UI |
| `js/core/profile/pluginSyncService.js` | Extend — sync repos + scraper states |

## Error Handling

- Scraper timeout (60s) → worker.terminate(), empty results, log warning
- Scraper JS error → catch in worker, post error message, empty results
- Missing getStreams export → empty results, log warning
- Manifest fetch failure → surface error to UI, skip repo
- Scraper code download failure → skip scraper, log warning
- Invalid results format → filter to valid items only (must have non-empty `url`)

## Security Considerations

- Workers have no DOM access — can't manipulate the page
- Workers can't access localStorage directly — all storage via postMessage
- Fetch from workers is subject to CORS (same as any browser request)
- worker.terminate() provides hard kill for runaway code
- No eval() on main thread — all code execution isolated in workers
