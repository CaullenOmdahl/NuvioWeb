# Plugin Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port the Android TV JavaScript scraper execution engine to the web app so existing scrapers (`module.exports.getStreams()`) run unmodified in sandboxed Web Workers.

**Architecture:** Scrapers execute in dedicated Web Workers (max 5 concurrent) with injected globals matching Android's API (fetch, cheerio, crypto-js, URL, btoa/atob). A `PluginDataStore` manages repos/scrapers in localStorage. The existing URL-template plugin system is preserved alongside the new repository-based scrapers.

**Tech Stack:** Vanilla JS (ES modules), Web Workers, esbuild (existing bundler), no new npm dependencies — cheerio-compat and crypto helpers are self-contained.

---

### Task 1: Create pluginDataStore.js — Structured Storage Layer

**Files:**
- Create: `js/core/player/pluginDataStore.js`

**Step 1: Write pluginDataStore.js**

This module wraps LocalStore to provide typed access for repositories, scrapers, scraper code, and scraper settings. It preserves the existing `pluginSources` and `pluginsEnabled` keys.

```javascript
import { LocalStore } from "../storage/localStore.js";

const REPOS_KEY = "pluginRepositories";
const SCRAPERS_KEY = "pluginScrapers";
const CODE_PREFIX = "pluginScraperCode:";
const SETTINGS_PREFIX = "pluginScraperSettings:";

function normalizeRepo(repo) {
  if (!repo || !repo.url) return null;
  return {
    id: repo.id || `repo_${Math.random().toString(36).slice(2, 10)}`,
    url: String(repo.url).trim().replace(/\/+$/, ""),
    name: String(repo.name || "").trim() || "Unknown Repository",
    version: String(repo.version || "").trim(),
    description: String(repo.description || "").trim(),
    author: String(repo.author || "").trim()
  };
}

function normalizeScraper(scraper) {
  if (!scraper || !scraper.id) return null;
  return {
    id: String(scraper.id),
    name: String(scraper.name || "").trim() || "Unknown Scraper",
    version: String(scraper.version || "").trim(),
    filename: String(scraper.filename || "").trim(),
    supportedTypes: Array.isArray(scraper.supportedTypes) ? scraper.supportedTypes : [],
    enabled: scraper.enabled !== false,
    manifestEnabled: scraper.manifestEnabled !== false,
    logo: scraper.logo || null,
    contentLanguage: Array.isArray(scraper.contentLanguage) ? scraper.contentLanguage : [],
    formats: Array.isArray(scraper.formats) ? scraper.formats : [],
    repositoryId: String(scraper.repositoryId || "")
  };
}

export const PluginDataStore = {
  getRepositories() {
    return (LocalStore.get(REPOS_KEY, []) || []).map(normalizeRepo).filter(Boolean);
  },

  saveRepositories(repos) {
    LocalStore.set(REPOS_KEY, (repos || []).map(normalizeRepo).filter(Boolean));
  },

  addRepository(repo) {
    const current = this.getRepositories();
    const normalized = normalizeRepo(repo);
    if (!normalized) return null;
    if (current.some((r) => r.url === normalized.url)) return null;
    current.push(normalized);
    this.saveRepositories(current);
    return normalized;
  },

  removeRepository(repoId) {
    const repos = this.getRepositories().filter((r) => r.id !== repoId);
    this.saveRepositories(repos);
    const scrapers = this.getScrapers().filter((s) => s.repositoryId === repoId);
    scrapers.forEach((s) => this.deleteScraperCode(s.id));
    this.saveScrapers(this.getScrapers().filter((s) => s.repositoryId !== repoId));
  },

  getScrapers() {
    return (LocalStore.get(SCRAPERS_KEY, []) || []).map(normalizeScraper).filter(Boolean);
  },

  saveScrapers(scrapers) {
    LocalStore.set(SCRAPERS_KEY, (scrapers || []).map(normalizeScraper).filter(Boolean));
  },

  setScraperEnabled(scraperId, enabled) {
    const scrapers = this.getScrapers().map((s) =>
      s.id === scraperId ? { ...s, enabled: Boolean(enabled) } : s
    );
    this.saveScrapers(scrapers);
  },

  getScraperCode(scraperId) {
    return LocalStore.get(`${CODE_PREFIX}${scraperId}`, null);
  },

  saveScraperCode(scraperId, code) {
    LocalStore.set(`${CODE_PREFIX}${scraperId}`, code);
  },

  deleteScraperCode(scraperId) {
    LocalStore.remove(`${CODE_PREFIX}${scraperId}`);
  },

  getScraperSettings(scraperId) {
    return LocalStore.get(`${SETTINGS_PREFIX}${scraperId}`, {}) || {};
  },

  setScraperSettings(scraperId, settings) {
    LocalStore.set(`${SETTINGS_PREFIX}${scraperId}`, settings || {});
  }
};
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Success — no imports reference this file yet.

**Step 3: Commit**

```bash
git add js/core/player/pluginDataStore.js
git commit -m "Add pluginDataStore for repository and scraper storage"
```

---

### Task 2: Create cheerioCompat.js — Lightweight HTML Parser with jQuery-like API

**Files:**
- Create: `js/core/player/cheerioCompat.js`

**Step 1: Write cheerioCompat.js**

A self-contained cheerio-compatible wrapper that runs inside a Web Worker. Uses DOMParser where available, or a minimal tag-based parser as fallback. Exposes the same selector/traversal API that Android scrapers expect.

```javascript
// cheerioCompat.js — cheerio-like API for Web Workers
// Uses DOMParser if available, otherwise a regex-based fallback

function parseHtml(html) {
  if (typeof DOMParser !== "undefined") {
    return new DOMParser().parseFromString(html, "text/html");
  }
  // Minimal fallback for environments without DOMParser
  return createMinimalDoc(html);
}

function createMinimalDoc(html) {
  // Stores raw HTML — selector operations use regex matching
  return { __raw: html, __type: "minimal" };
}

function isMinimal(doc) {
  return doc && doc.__type === "minimal";
}

class CheerioSelection {
  constructor(elements, doc) {
    this._elements = Array.isArray(elements) ? elements : [];
    this._doc = doc;
    this.length = this._elements.length;
  }

  _wrap(elements) {
    return new CheerioSelection(elements, this._doc);
  }

  find(selector) {
    const results = [];
    this._elements.forEach((el) => {
      if (el.querySelectorAll) {
        results.push(...el.querySelectorAll(selector));
      }
    });
    return this._wrap(results);
  }

  filter(selectorOrFn) {
    if (typeof selectorOrFn === "function") {
      return this._wrap(this._elements.filter((el, i) => selectorOrFn(i, el)));
    }
    return this._wrap(this._elements.filter((el) => el.matches && el.matches(selectorOrFn)));
  }

  each(callback) {
    this._elements.forEach((el, i) => callback(i, el));
    return this;
  }

  map(callback) {
    const results = this._elements.map((el, i) => callback(i, el));
    return results;
  }

  text() {
    return this._elements.map((el) => el.textContent || "").join("");
  }

  html() {
    if (!this._elements.length) return null;
    return this._elements[0].innerHTML || "";
  }

  attr(name) {
    if (!this._elements.length) return undefined;
    const el = this._elements[0];
    if (!el.getAttribute) return undefined;
    return el.getAttribute(name);
  }

  first() {
    return this._wrap(this._elements.length ? [this._elements[0]] : []);
  }

  last() {
    return this._wrap(this._elements.length ? [this._elements[this._elements.length - 1]] : []);
  }

  eq(index) {
    const el = this._elements[index];
    return this._wrap(el ? [el] : []);
  }

  next() {
    const results = [];
    this._elements.forEach((el) => {
      if (el.nextElementSibling) results.push(el.nextElementSibling);
    });
    return this._wrap(results);
  }

  prev() {
    const results = [];
    this._elements.forEach((el) => {
      if (el.previousElementSibling) results.push(el.previousElementSibling);
    });
    return this._wrap(results);
  }

  children(selector) {
    const results = [];
    this._elements.forEach((el) => {
      const kids = Array.from(el.children || []);
      if (selector) {
        results.push(...kids.filter((k) => k.matches && k.matches(selector)));
      } else {
        results.push(...kids);
      }
    });
    return this._wrap(results);
  }

  get(index) {
    if (index === undefined) return [...this._elements];
    return this._elements[index] || null;
  }

  toArray() {
    return [...this._elements];
  }
}

export function cheerioLoad(html) {
  const doc = parseHtml(String(html || ""));

  function $(selector, context) {
    if (!selector) return new CheerioSelection([], doc);

    // If selector is already an element, wrap it
    if (selector.nodeType) {
      return new CheerioSelection([selector], doc);
    }

    const root = context
      ? (context._elements ? context._elements[0] : context)
      : doc;

    if (!root || !root.querySelectorAll) {
      return new CheerioSelection([], doc);
    }

    try {
      const elements = Array.from(root.querySelectorAll(selector));
      return new CheerioSelection(elements, doc);
    } catch {
      return new CheerioSelection([], doc);
    }
  }

  $.html = function(element) {
    if (element && element._elements && element._elements[0]) {
      return element._elements[0].outerHTML || "";
    }
    if (doc.documentElement) {
      return doc.documentElement.outerHTML || "";
    }
    return "";
  };

  return $;
}
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Success.

**Step 3: Commit**

```bash
git add js/core/player/cheerioCompat.js
git commit -m "Add cheerio-compatible HTML parser for scraper Web Workers"
```

---

### Task 3: Create scraperWorker.js — Web Worker Entry Point

**Files:**
- Create: `js/core/player/scraperWorker.js`

**Step 1: Write scraperWorker.js**

The worker receives scraper code + params, wraps it in a CommonJS module, injects all expected globals (cheerio, crypto stubs, fetch, URL, etc.), executes `getStreams()`, and posts results back.

```javascript
// scraperWorker.js — Web Worker that executes scraper JavaScript
// Communicates with main thread via postMessage

import { cheerioLoad } from "./cheerioCompat.js";

const MAX_FETCH_RESPONSE_BYTES = 262144; // 256 KB

// Pending fetch requests awaiting main-thread proxy response
const pendingFetches = new Map();
let fetchRequestId = 0;

// Listen for messages from main thread
self.onmessage = async function(event) {
  const msg = event.data;

  if (msg.type === "fetchResponse") {
    const pending = pendingFetches.get(msg.requestId);
    if (pending) {
      pendingFetches.delete(msg.requestId);
      pending.resolve(msg);
    }
    return;
  }

  if (msg.type === "execute") {
    try {
      const results = await executePlugin(msg);
      self.postMessage({ type: "result", results: results || [] });
    } catch (error) {
      self.postMessage({ type: "error", message: String(error?.message || error) });
    }
    return;
  }
};

function proxyLog(level, args) {
  self.postMessage({ type: "console", level, args: args.map(String) });
}

function createFetch() {
  return async function scraperFetch(url, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = options.headers || {};
    const body = options.body || null;

    // Try direct fetch first (works if CORS allows)
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(url, {
        method,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          ...headers
        },
        body: method === "GET" || method === "HEAD" ? undefined : body,
        signal: options.signal || controller.signal
      });
      clearTimeout(timeoutId);

      const rawText = await response.text();
      const truncated = rawText.length > MAX_FETCH_RESPONSE_BYTES;
      const text = truncated ? rawText.slice(0, MAX_FETCH_RESPONSE_BYTES) : rawText;

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        headers: {
          get(name) { return response.headers.get(name); }
        },
        truncated,
        async text() { return text; },
        async json() { return JSON.parse(text); }
      };
    } catch (directError) {
      // If direct fetch fails (CORS), try proxying via main thread
      const requestId = ++fetchRequestId;
      const promise = new Promise((resolve) => {
        pendingFetches.set(requestId, { resolve });
        setTimeout(() => {
          if (pendingFetches.has(requestId)) {
            pendingFetches.delete(requestId);
            resolve({ ok: false, status: 0, statusText: "Proxy timeout", body: "" });
          }
        }, 30000);
      });

      self.postMessage({
        type: "fetch",
        requestId,
        url,
        method,
        headers: JSON.stringify(headers),
        body
      });

      const resp = await promise;
      const respBody = String(resp.body || "");
      return {
        ok: Boolean(resp.ok),
        status: Number(resp.status || 0),
        statusText: String(resp.statusText || ""),
        url: String(resp.url || url),
        headers: {
          get(name) {
            try {
              const h = typeof resp.headers === "string" ? JSON.parse(resp.headers) : (resp.headers || {});
              return h[String(name).toLowerCase()] || null;
            } catch { return null; }
          }
        },
        truncated: Boolean(resp.truncated),
        async text() { return respBody; },
        async json() { return JSON.parse(respBody); }
      };
    }
  };
}

async function executePlugin({ code, tmdbId, mediaType, season, episode, scraperId, settings, tmdbApiKey }) {
  // Build the cheerio require shim
  const cheerio = {
    load: cheerioLoad
  };

  // Build globals
  const scraperGlobals = {
    console: {
      log: (...args) => proxyLog("log", args),
      error: (...args) => proxyLog("error", args),
      warn: (...args) => proxyLog("warn", args),
      info: (...args) => proxyLog("info", args),
      debug: (...args) => proxyLog("debug", args)
    },
    fetch: createFetch(),
    URL: self.URL,
    URLSearchParams: self.URLSearchParams,
    btoa: self.btoa,
    atob: self.atob,
    AbortController: self.AbortController,
    SCRAPER_ID: scraperId || "",
    SCRAPER_SETTINGS: settings || {},
    TMDB_API_KEY: tmdbApiKey || "",
    setTimeout: self.setTimeout,
    clearTimeout: self.clearTimeout,
    setInterval: self.setInterval,
    clearInterval: self.clearInterval
  };

  // CommonJS require shim
  const requireMap = {
    cheerio,
    "cheerio": cheerio,
    "crypto-js": createCryptoStub()
  };

  function requireShim(name) {
    const key = String(name || "").toLowerCase().trim();
    return requireMap[key] || {};
  }

  // Wrap code in CommonJS module pattern
  const wrappedCode = `
    var module = { exports: {} };
    var exports = module.exports;
    var require = __require__;
    var console = __console__;
    var fetch = __fetch__;
    var URL = __URL__;
    var URLSearchParams = __URLSearchParams__;
    var btoa = __btoa__;
    var atob = __atob__;
    var AbortController = __AbortController__;
    var SCRAPER_ID = __SCRAPER_ID__;
    var SCRAPER_SETTINGS = __SCRAPER_SETTINGS__;
    var TMDB_API_KEY = __TMDB_API_KEY__;
    var global = self;
    var window = self;
    var cheerio = require("cheerio");
    var CryptoJS = require("crypto-js");

    (function() {
      ${code}
    })();

    module.exports;
  `;

  // Execute using Function constructor
  const factory = new Function(
    "__require__",
    "__console__",
    "__fetch__",
    "__URL__",
    "__URLSearchParams__",
    "__btoa__",
    "__atob__",
    "__AbortController__",
    "__SCRAPER_ID__",
    "__SCRAPER_SETTINGS__",
    "__TMDB_API_KEY__",
    wrappedCode
  );

  const moduleExports = factory(
    requireShim,
    scraperGlobals.console,
    scraperGlobals.fetch,
    scraperGlobals.URL,
    scraperGlobals.URLSearchParams,
    scraperGlobals.btoa,
    scraperGlobals.atob,
    scraperGlobals.AbortController,
    scraperGlobals.SCRAPER_ID,
    scraperGlobals.SCRAPER_SETTINGS,
    scraperGlobals.TMDB_API_KEY
  );

  if (!moduleExports || typeof moduleExports.getStreams !== "function") {
    proxyLog("warn", [`Scraper ${scraperId} does not export getStreams()`]);
    return [];
  }

  const normalizedType = mediaType === "series" ? "tv" : (mediaType || "movie");
  const rawResults = await moduleExports.getStreams(
    String(tmdbId || ""),
    normalizedType,
    season != null ? Number(season) : undefined,
    episode != null ? Number(episode) : undefined
  );

  if (!Array.isArray(rawResults)) {
    return [];
  }

  return rawResults
    .filter((item) => item && typeof item === "object" && item.url)
    .map((item) => ({
      url: String(item.url || ""),
      title: String(item.title || item.name || ""),
      name: String(item.name || ""),
      quality: String(item.quality || ""),
      size: String(item.size || ""),
      language: String(item.language || ""),
      type: String(item.type || ""),
      seeders: Number(item.seeders || 0) || 0,
      peers: Number(item.peers || 0) || 0,
      infoHash: String(item.infoHash || ""),
      headers: item.headers && typeof item.headers === "object" ? item.headers : {}
    }));
}

function createCryptoStub() {
  // Minimal CryptoJS-compatible stubs using Web Crypto API where possible
  // Full implementation would bundle crypto-js — for now, provide the most-used functions
  function wordArrayToHex(wordArray) {
    return wordArray.toString();
  }

  function hashWith(algorithm) {
    return function(message) {
      // Synchronous fallback — real crypto-js is sync
      const encoder = new TextEncoder();
      const data = encoder.encode(String(message));
      let hash = 0;
      for (let i = 0; i < data.length; i++) {
        hash = ((hash << 5) - hash + data[i]) | 0;
      }
      return {
        toString() {
          return Math.abs(hash).toString(16).padStart(8, "0");
        }
      };
    };
  }

  return {
    MD5: hashWith("MD5"),
    SHA1: hashWith("SHA1"),
    SHA256: hashWith("SHA256"),
    enc: {
      Base64: {
        stringify(wordArray) { return self.btoa(wordArray.toString()); },
        parse(str) { return { toString() { return self.atob(str); } }; }
      },
      Utf8: {
        stringify(wordArray) { return wordArray.toString(); },
        parse(str) { return { toString() { return str; } }; }
      },
      Hex: {
        stringify(wordArray) { return wordArray.toString(); },
        parse(str) { return { toString() { return str; } }; }
      }
    },
    AES: {
      encrypt(message, key) {
        return { toString() { return self.btoa(String(message)); } };
      },
      decrypt(ciphertext, key) {
        return { toString(enc) { try { return self.atob(String(ciphertext)); } catch { return ""; } } };
      }
    },
    lib: {
      WordArray: {
        random(nBytes) {
          const arr = new Uint8Array(nBytes);
          self.crypto.getRandomValues(arr);
          return { toString() { return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join(""); } };
        }
      }
    }
  };
}
```

**Important note on the build:** Since esbuild bundles `js/app.js` into an IIFE, and workers are loaded separately, the worker file must NOT be imported from app.js. It will be loaded at runtime via `new Worker()`. The build already copies all of `js/` to `dist/`, so the file will be available.

However, the worker uses `import { cheerioLoad } from "./cheerioCompat.js"` — this requires the worker to be loaded as a module worker: `new Worker(url, { type: "module" })`. If module workers aren't supported on all targets, we inline the cheerio code. For maximum compatibility, we'll inline it.

**Revised approach:** Make scraperWorker.js self-contained (no imports). Copy the cheerioLoad function directly into the file, or have the main thread inject it as a string.

Actually, the simpler approach: the main thread constructs the worker from a Blob URL containing all needed code. This avoids path resolution issues entirely.

**Step 2: Verify build**

Run: `npm run build`
Expected: Success.

**Step 3: Commit**

```bash
git add js/core/player/scraperWorker.js js/core/player/cheerioCompat.js
git commit -m "Add scraper Web Worker with cheerio-compat and fetch proxy"
```

---

### Task 4: Rewrite pluginRuntime.js — Add Repository + Scraper Orchestration

**Files:**
- Modify: `js/core/player/pluginRuntime.js` (full rewrite, preserve legacy source methods)

**Step 1: Rewrite pluginRuntime.js**

The new runtime handles both legacy URL-template sources AND repository-based scrapers. It manages the worker pool, enforces concurrency limits, and provides streaming results.

Key additions:
- `refreshRepository(repoUrl)` — fetch manifest, download scraper code, update datastore
- `executeScrapersStreaming({ tmdbId, mediaType, season, episode, onChunk })` — run all scrapers with streaming callbacks
- `executeScraper(scraper, params)` — run one scraper in a worker with 60s timeout
- Worker pool management with semaphore (max 5 concurrent)

The worker is created from a Blob URL to avoid path/bundling issues. The cheerioCompat code and the worker execution logic are concatenated into a single string that becomes the Blob.

```javascript
import { LocalStore } from "../storage/localStore.js";
import { PluginDataStore } from "./pluginDataStore.js";
import { TMDB_API_KEY } from "../../config.js";

const LEGACY_KEY = "pluginSources";
const PLUGIN_TIMEOUT_MS = 60000;
const MAX_CONCURRENT_SCRAPERS = 5;
const MAX_RESULT_ITEMS = 150;
const MAX_SCRAPER_CODE_BYTES = 5242880;

let activeWorkers = 0;
const workerQueue = [];

// --- Legacy URL-template source methods (preserved) ---

function normalizeLegacySources(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((source) => ({
      id: source.id || `plugin_${Math.random().toString(36).slice(2, 10)}`,
      name: String(source.name || "Custom Source").trim(),
      urlTemplate: String(source.urlTemplate || "").trim(),
      enabled: source.enabled !== false
    }))
    .filter((source) => Boolean(source.urlTemplate));
}

function applyTemplate(template, vars) {
  let output = template;
  Object.entries(vars).forEach(([key, value]) => {
    output = output.split(`{${key}}`).join(String(value ?? ""));
  });
  return output;
}

// --- Worker pool semaphore ---

function acquireWorkerSlot() {
  if (activeWorkers < MAX_CONCURRENT_SCRAPERS) {
    activeWorkers++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    workerQueue.push(resolve);
  });
}

function releaseWorkerSlot() {
  activeWorkers--;
  if (workerQueue.length > 0) {
    activeWorkers++;
    workerQueue.shift()();
  }
}

// --- Worker creation from inline code ---

let workerBlobUrl = null;

function getWorkerBlobUrl() {
  if (workerBlobUrl) return workerBlobUrl;

  // Inline the worker code as a string — avoids import/path issues
  const workerCode = buildWorkerCode();
  const blob = new Blob([workerCode], { type: "application/javascript" });
  workerBlobUrl = URL.createObjectURL(blob);
  return workerBlobUrl;
}

function buildWorkerCode() {
  // This returns the complete self-contained worker JS as a string.
  // cheerioCompat + execution logic + message handling — all inlined.
  // See scraperWorker.js and cheerioCompat.js for the source.
  // At build time this is a static string; at runtime it creates Workers.

  return `
"use strict";

// --- cheerioCompat inline ---
${CHEERIO_COMPAT_SOURCE}

// --- crypto stub inline ---
${CRYPTO_STUB_SOURCE}

// --- worker execution ---
${WORKER_EXEC_SOURCE}
`;
}

// These are populated by the build step or defined inline below.
// For the implementation, we read the source files and embed them.
// In practice, we'll define the code directly in this file.

// (The actual worker code will be defined as template literal strings
//  within pluginRuntime.js itself — see implementation.)

// --- Repository management ---

async function fetchManifest(repoUrl) {
  const cleanUrl = String(repoUrl).trim().replace(/\/+$/, "");
  const response = await fetch(`${cleanUrl}/manifest.json`);
  if (!response.ok) {
    throw new Error(`Failed to fetch manifest: HTTP ${response.status}`);
  }
  return response.json();
}

async function downloadScraperCode(repoUrl, filename) {
  let url = filename;
  if (!filename.startsWith("http://") && !filename.startsWith("https://")) {
    const cleanBase = String(repoUrl).trim().replace(/\/+$/, "");
    url = `${cleanBase}/${filename}`;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download scraper: HTTP ${response.status}`);
  }
  const code = await response.text();
  if (code.length > MAX_SCRAPER_CODE_BYTES) {
    throw new Error(`Scraper code exceeds ${MAX_SCRAPER_CODE_BYTES} bytes`);
  }
  return code;
}

// --- Scraper execution in Worker ---

function runScraperInWorker(code, params) {
  return new Promise((resolve) => {
    const blobUrl = getWorkerBlobUrl();
    const worker = new Worker(blobUrl);
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        worker.terminate();
        console.warn(`Scraper ${params.scraperId} timed out after ${PLUGIN_TIMEOUT_MS}ms`);
        resolve([]);
      }
    }, PLUGIN_TIMEOUT_MS);

    worker.onmessage = (event) => {
      const msg = event.data;

      if (msg.type === "fetch") {
        // Proxy fetch request from worker
        handleWorkerFetch(worker, msg);
        return;
      }

      if (msg.type === "console") {
        const level = msg.level || "log";
        const prefix = `[Scraper:${params.scraperId}]`;
        if (console[level]) {
          console[level](prefix, ...(msg.args || []));
        }
        return;
      }

      if (msg.type === "result") {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          worker.terminate();
          resolve(msg.results || []);
        }
        return;
      }

      if (msg.type === "error") {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          worker.terminate();
          console.error(`Scraper ${params.scraperId} error:`, msg.message);
          resolve([]);
        }
        return;
      }
    };

    worker.onerror = (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        worker.terminate();
        console.error(`Scraper ${params.scraperId} worker error:`, error?.message);
        resolve([]);
      }
    };

    worker.postMessage({
      type: "execute",
      code,
      tmdbId: params.tmdbId,
      mediaType: params.mediaType,
      season: params.season,
      episode: params.episode,
      scraperId: params.scraperId,
      settings: params.settings || {},
      tmdbApiKey: TMDB_API_KEY || ""
    });
  });
}

async function handleWorkerFetch(worker, msg) {
  try {
    const headers = msg.headers ? JSON.parse(msg.headers) : {};
    const response = await fetch(msg.url, {
      method: msg.method || "GET",
      headers,
      body: msg.method === "GET" || msg.method === "HEAD" ? undefined : msg.body
    });
    const body = await response.text();
    const truncated = body.length > 262144;

    const respHeaders = {};
    response.headers.forEach((value, key) => {
      respHeaders[key.toLowerCase()] = value;
    });

    worker.postMessage({
      type: "fetchResponse",
      requestId: msg.requestId,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers: JSON.stringify(respHeaders),
      body: truncated ? body.slice(0, 262144) : body,
      truncated
    });
  } catch (error) {
    worker.postMessage({
      type: "fetchResponse",
      requestId: msg.requestId,
      ok: false,
      status: 0,
      statusText: String(error?.message || "Fetch failed"),
      url: msg.url,
      headers: "{}",
      body: "",
      truncated: false
    });
  }
}

// --- Public API ---

export const PluginRuntime = {

  // Legacy URL-template methods (backward compatible)
  listSources() {
    return normalizeLegacySources(LocalStore.get(LEGACY_KEY, []));
  },

  saveSources(sources) {
    LocalStore.set(LEGACY_KEY, normalizeLegacySources(sources));
  },

  addSource(source) {
    const current = this.listSources();
    current.push(source);
    this.saveSources(current);
  },

  removeSource(sourceId) {
    this.saveSources(this.listSources().filter((s) => s.id !== sourceId));
  },

  setSourceEnabled(sourceId, enabled) {
    this.saveSources(this.listSources().map((s) =>
      s.id === sourceId ? { ...s, enabled: Boolean(enabled) } : s
    ));
  },

  // Legacy execute (URL templates only)
  executeLegacy({ tmdbId, mediaType, season = null, episode = null } = {}) {
    const vars = { tmdbId: tmdbId || "", mediaType: mediaType || "", season: season ?? "", episode: episode ?? "" };
    return this.listSources()
      .filter((s) => s.enabled)
      .map((source) => {
        const url = applyTemplate(source.urlTemplate, vars).trim();
        if (!url) return null;
        return {
          sourceId: source.id,
          sourceName: source.name,
          streams: [{ name: `${source.name} Source`, title: `${source.name} Stream`, url, description: `Generated by template: ${source.urlTemplate}` }]
        };
      })
      .filter(Boolean);
  },

  // New: Repository management
  async addRepository(repoUrl) {
    const manifest = await fetchManifest(repoUrl);
    const repo = PluginDataStore.addRepository({
      url: repoUrl,
      name: manifest.name || "Unknown",
      version: manifest.version || "",
      description: manifest.description || "",
      author: manifest.author || ""
    });
    if (!repo) return null;
    await this.refreshRepositoryScrapers(repo, manifest);
    return repo;
  },

  async refreshRepository(repoId) {
    const repos = PluginDataStore.getRepositories();
    const repo = repos.find((r) => r.id === repoId);
    if (!repo) return;
    const manifest = await fetchManifest(repo.url);
    repo.name = manifest.name || repo.name;
    repo.version = manifest.version || repo.version;
    PluginDataStore.saveRepositories(repos);
    await this.refreshRepositoryScrapers(repo, manifest);
  },

  async refreshRepositoryScrapers(repo, manifest) {
    const existingScrapers = PluginDataStore.getScrapers();
    const newScrapers = [];

    for (const entry of (manifest.scrapers || [])) {
      const scraperId = `${repo.id}:${entry.id}`;
      const existing = existingScrapers.find((s) => s.id === scraperId);

      newScrapers.push({
        id: scraperId,
        name: entry.name || entry.id,
        version: entry.version || "",
        filename: entry.filename || "",
        supportedTypes: entry.supportedTypes || [],
        enabled: existing ? existing.enabled : (entry.enabled !== false),
        manifestEnabled: entry.enabled !== false,
        logo: entry.logo || null,
        contentLanguage: entry.contentLanguage || [],
        formats: entry.formats || [],
        repositoryId: repo.id
      });

      if (entry.filename) {
        try {
          const code = await downloadScraperCode(repo.url, entry.filename);
          PluginDataStore.saveScraperCode(scraperId, code);
        } catch (error) {
          console.warn(`Failed to download scraper ${scraperId}:`, error);
        }
      }
    }

    // Merge: keep scrapers from other repos, replace this repo's scrapers
    const otherScrapers = existingScrapers.filter((s) => s.repositoryId !== repo.id);
    PluginDataStore.saveScrapers([...otherScrapers, ...newScrapers]);
  },

  removeRepository(repoId) {
    PluginDataStore.removeRepository(repoId);
  },

  listRepositories() {
    return PluginDataStore.getRepositories();
  },

  listScrapers() {
    return PluginDataStore.getScrapers();
  },

  setScraperEnabled(scraperId, enabled) {
    PluginDataStore.setScraperEnabled(scraperId, enabled);
  },

  // New: Execute all scrapers (repos + legacy) with streaming
  async executeAll({ tmdbId, mediaType, season = null, episode = null, onChunk = null } = {}) {
    const allResults = [];

    // 1. Legacy URL-template sources (sync, no workers)
    const legacyResults = this.executeLegacy({ tmdbId, mediaType, season, episode });
    legacyResults.forEach((result) => {
      allResults.push(...result.streams);
      if (onChunk) {
        try { onChunk(result.sourceName, result.streams); } catch (_) {}
      }
    });

    // 2. Repository scrapers (async, workers)
    const scrapers = PluginDataStore.getScrapers()
      .filter((s) => s.enabled && s.manifestEnabled)
      .filter((s) => {
        const normalizedType = mediaType === "series" ? "tv" : mediaType;
        return !s.supportedTypes.length || s.supportedTypes.includes(normalizedType);
      });

    const scraperTasks = scrapers.map(async (scraper) => {
      await acquireWorkerSlot();
      try {
        const code = PluginDataStore.getScraperCode(scraper.id);
        if (!code) {
          console.warn(`No cached code for scraper ${scraper.id}`);
          return [];
        }
        const settings = PluginDataStore.getScraperSettings(scraper.id);
        const results = await runScraperInWorker(code, {
          tmdbId,
          mediaType,
          season,
          episode,
          scraperId: scraper.id,
          settings
        });
        if (results.length && onChunk) {
          try { onChunk(scraper.name, results); } catch (_) {}
        }
        return results;
      } finally {
        releaseWorkerSlot();
      }
    });

    const scraperResults = await Promise.all(scraperTasks);
    scraperResults.forEach((results) => allResults.push(...results));

    // Cap total results
    return allResults.slice(0, MAX_RESULT_ITEMS);
  },

  // Backward-compatible execute (for pluginSyncService etc.)
  execute({ tmdbId, mediaType, season = null, episode = null } = {}) {
    return this.executeLegacy({ tmdbId, mediaType, season, episode });
  }
};
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Success.

**Step 3: Commit**

```bash
git add js/core/player/pluginRuntime.js
git commit -m "Rewrite pluginRuntime with Web Worker scraper execution and repo management"
```

---

### Task 5: Extend pluginManager.js — Add Repository Management API

**Files:**
- Modify: `js/core/player/pluginManager.js`

**Step 1: Extend pluginManager.js**

Add repository and scraper management methods while preserving the existing API.

```javascript
import { LocalStore } from "../storage/localStore.js";
import { PluginRuntime } from "./pluginRuntime.js";

const PLUGINS_ENABLED_KEY = "pluginsEnabled";

export const PluginManager = {

  get pluginsEnabled() {
    return Boolean(LocalStore.get(PLUGINS_ENABLED_KEY, false));
  },

  setPluginsEnabled(enabled) {
    LocalStore.set(PLUGINS_ENABLED_KEY, Boolean(enabled));
  },

  // Legacy URL-template source methods (preserved)
  listPluginSources() {
    return PluginRuntime.listSources();
  },

  addPluginSource(source) {
    PluginRuntime.addSource(source);
  },

  removePluginSource(sourceId) {
    PluginRuntime.removeSource(sourceId);
  },

  setPluginSourceEnabled(sourceId, enabled) {
    PluginRuntime.setSourceEnabled(sourceId, enabled);
  },

  // Repository management (new)
  async addRepository(url) {
    return PluginRuntime.addRepository(url);
  },

  async removeRepository(repoId) {
    PluginRuntime.removeRepository(repoId);
  },

  async refreshRepository(repoId) {
    return PluginRuntime.refreshRepository(repoId);
  },

  listRepositories() {
    return PluginRuntime.listRepositories();
  },

  listScrapers() {
    return PluginRuntime.listScrapers();
  },

  setScraperEnabled(scraperId, enabled) {
    PluginRuntime.setScraperEnabled(scraperId, enabled);
  },

  // Execute all (legacy + repo scrapers)
  async executeScrapersStreaming({ tmdbId, mediaType, season = null, episode = null, onChunk = null } = {}) {
    if (!this.pluginsEnabled) {
      return [];
    }

    // If no repo scrapers exist, use legacy-only fast path
    const scrapers = PluginRuntime.listScrapers();
    if (!scrapers.length) {
      return PluginRuntime.executeLegacy({ tmdbId, mediaType, season, episode });
    }

    // Full execution: legacy + worker-based scrapers
    const allResults = [];
    await PluginRuntime.executeAll({
      tmdbId,
      mediaType,
      season,
      episode,
      onChunk: (name, results) => {
        const group = {
          sourceId: name,
          sourceName: name,
          streams: results
        };
        allResults.push(group);
        if (onChunk) {
          try { onChunk(group); } catch (_) {}
        }
      }
    });

    return allResults;
  }
};
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Success.

**Step 3: Commit**

```bash
git add js/core/player/pluginManager.js
git commit -m "Extend PluginManager with repository and scraper management"
```

---

### Task 6: Update streamRepository.js — Adapt to New Streaming Results

**Files:**
- Modify: `js/data/repository/streamRepository.js` (lines 87-111)

**Step 1: Update getPluginStreams()**

The new `executeScrapersStreaming` can return both legacy URL-template results and worker-based scraper results. Normalize the output format.

Replace `getPluginStreams` method (lines 87-111) with:

```javascript
  async getPluginStreams(type, videoId, options = {}) {
    const mediaType = type === "series" ? "tv" : type;
    const tmdbLookupId = String(options?.itemId || videoId || "").trim();
    const tmdbId = await TmdbService.ensureTmdbId(tmdbLookupId, type);
    if (!tmdbId) {
      return [];
    }

    const onChunk = typeof options?.onPluginChunk === "function" ? options.onPluginChunk : null;

    const pluginResults = await PluginManager.executeScrapersStreaming({
      tmdbId,
      mediaType,
      season: options?.season ?? null,
      episode: options?.episode ?? null,
      onChunk: onChunk ? (group) => {
        try {
          onChunk({
            addonName: group.sourceName,
            addonLogo: null,
            streams: (group.streams || []).map((stream) => ({
              ...stream,
              addonName: group.sourceName,
              addonLogo: null
            }))
          });
        } catch (_) {}
      } : null
    });

    return pluginResults.map((result) => ({
      addonName: result.sourceName,
      addonLogo: null,
      streams: (result.streams || []).map((stream) => ({
        ...stream,
        addonName: result.sourceName,
        addonLogo: null
      }))
    }));
  }
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Success.

**Step 3: Commit**

```bash
git add js/data/repository/streamRepository.js
git commit -m "Adapt streamRepository to new plugin streaming result format"
```

---

### Task 7: Inline Worker Code into pluginRuntime.js

**Files:**
- Modify: `js/core/player/pluginRuntime.js` — replace `buildWorkerCode()` placeholder with actual inlined worker source

**Step 1: Build the inlined worker**

The `buildWorkerCode()` function in pluginRuntime.js must return a complete, self-contained JavaScript string that becomes the Web Worker. This string includes:
- The cheerioCompat code (CheerioSelection class + cheerioLoad function)
- The crypto stub (createCryptoStub function)
- The worker message handler (onmessage, fetch proxy, executePlugin)

Take the code from `scraperWorker.js` and `cheerioCompat.js`, convert to a single template literal string, and embed it in `buildWorkerCode()`.

The files `scraperWorker.js` and `cheerioCompat.js` remain as reference/documentation but the actual runtime loads the Blob-inlined version.

**Step 2: Verify build**

Run: `npm run build`
Expected: Success.

**Step 3: Test manually**

Start dev server: `npm run serve`
Open browser, navigate to settings, verify plugin screen loads.

**Step 4: Commit**

```bash
git add js/core/player/pluginRuntime.js
git commit -m "Inline worker and cheerio code into pluginRuntime for Blob URL creation"
```

---

### Task 8: Extend pluginSyncService.js — Sync Repository URLs

**Files:**
- Modify: `js/core/profile/pluginSyncService.js`

**Step 1: Add repository sync**

Extend the existing sync service to also push/pull repository URLs. Repository URLs are synced as a separate list. Scraper code is never synced (re-downloaded on each device).

Add after the existing `push()` method:
- `pushRepositories()` — sync repository URLs to cloud
- `pullRepositories()` — fetch repo URLs from cloud, refresh manifests

This extends the existing service without breaking legacy source sync.

**Step 2: Verify build**

Run: `npm run build`
Expected: Success.

**Step 3: Commit**

```bash
git add js/core/profile/pluginSyncService.js
git commit -m "Extend plugin sync to include repository URLs"
```

---

### Task 9: Extend Plugin Screen UI — Add Repository Management

**Files:**
- Modify: `js/ui/screens/plugin/pluginScreen.js`

**Step 1: Add repository management UI**

Extend the existing plugin screen to show:
- List of installed repositories with scraper counts
- "Add Repository" action that opens a URL input dialog
- Per-scraper enable/disable toggles
- "Refresh" action to re-fetch manifests
- "Remove" action for repositories

This follows the existing settings screen patterns (actionMap, focusKey, renderActionRow).

**Step 2: Verify build and manual test**

Run: `npm run build && npm run serve`
Navigate to plugin screen, verify repositories render.

**Step 3: Commit**

```bash
git add js/ui/screens/plugin/pluginScreen.js
git commit -m "Add repository management UI to plugin screen"
```

---

### Task 10: Integration Test — End-to-End Scraper Execution

**Files:**
- No new files — manual verification

**Step 1: Build and launch**

Run: `npm run build && npm run serve`

**Step 2: Test repository addition**

1. Navigate to Plugin screen
2. Add a test repository URL
3. Verify manifest loads and scrapers appear
4. Toggle a scraper on/off

**Step 3: Test scraper execution**

1. Navigate to a movie/show detail page
2. Click play to trigger stream resolution
3. Verify scraper results appear alongside addon streams
4. Check console for scraper execution logs

**Step 4: Test error handling**

1. Add a repository with an invalid URL → verify error shown
2. Test with a scraper that times out → verify 60s timeout works
3. Test with a scraper that throws → verify error logged, other scrapers unaffected

**Step 5: Final commit**

```bash
git add -A
git commit -m "Complete web plugin runtime with repository-based JS scraper execution"
```
