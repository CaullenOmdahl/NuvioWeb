import { LocalStore } from "../storage/localStore.js";
import { PluginDataStore } from "./pluginDataStore.js";
import { TMDB_API_KEY } from "../../config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEGACY_KEY = "pluginSources";
const PLUGIN_TIMEOUT_MS = 60000;
const MAX_CONCURRENT_SCRAPERS = 5;
const MAX_RESULT_ITEMS = 150;
const MAX_SCRAPER_CODE_BYTES = 5242880; // 5 MB

// ---------------------------------------------------------------------------
// Worker pool (semaphore pattern)
// ---------------------------------------------------------------------------

let activeWorkers = 0;
const workerQueue = [];

function acquireWorkerSlot() {
  if (activeWorkers < MAX_CONCURRENT_SCRAPERS) {
    activeWorkers++;
    return Promise.resolve();
  }
  return new Promise((resolve) => workerQueue.push(resolve));
}

function releaseWorkerSlot() {
  activeWorkers--;
  if (workerQueue.length > 0) {
    activeWorkers++;
    workerQueue.shift()();
  }
}

// ---------------------------------------------------------------------------
// Worker Blob URL (lazy)
// ---------------------------------------------------------------------------

/**
 * Returns the complete self-contained Web Worker script as a string.
 * Contains the inlined cheerioCompat + scraperWorker code so it can be
 * loaded via a Blob URL without any imports.
 */
function buildWorkerCode() {
  return `"use strict";

/**
 * cheerioCompat.js
 *
 * Lightweight cheerio-compatible HTML parsing library for use inside Web Workers.
 * Provides the jQuery-like API surface that scrapers written for the Android TV
 * app expect.  Uses DOMParser (available in Workers) — no external dependencies.
 *
 * Export: cheerioLoad(html) → $ function
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONTAINS_RE = /:contains\\((['"])(.*?)\\1\\)/g;

/**
 * Native querySelectorAll does not support the :contains(text) pseudo-selector.
 * We split any selector that uses it into (a) the part before the first
 * :contains(), and (b) one or more :contains() filters that we apply manually.
 *
 * Returns { baseSelector, textFilters[] } where textFilters may be empty.
 */
function parseContains(selector) {
  if (typeof selector !== "string") {
    return { baseSelector: selector, textFilters: [] };
  }
  const textFilters = [];
  let match;
  CONTAINS_RE.lastIndex = 0;
  while ((match = CONTAINS_RE.exec(selector)) !== null) {
    textFilters.push(match[2]);
  }
  if (textFilters.length === 0) {
    return { baseSelector: selector, textFilters: [] };
  }
  const baseSelector = selector.replace(CONTAINS_RE, "").trim() || "*";
  return { baseSelector, textFilters };
}

/**
 * Query elements under \`root\` honouring :contains() if present.
 */
function querySelectorAll(root, selector) {
  if (!root || typeof selector !== "string" || selector.trim() === "") {
    return [];
  }

  const { baseSelector, textFilters } = parseContains(selector);
  let elements;
  try {
    elements = Array.from(root.querySelectorAll(baseSelector));
  } catch (_e) {
    // Invalid selector — return empty set rather than throwing.
    return [];
  }

  if (textFilters.length === 0) {
    return elements;
  }

  return elements.filter((el) => {
    const text = el.textContent || "";
    return textFilters.every((filter) => text.indexOf(filter) !== -1);
  });
}

/**
 * Check whether a single element matches a selector string (with :contains
 * support).
 */
function matchesSelector(el, selector) {
  if (!el || typeof selector !== "string") {
    return false;
  }

  const { baseSelector, textFilters } = parseContains(selector);

  let baseMatch = true;
  if (baseSelector && baseSelector !== "*") {
    try {
      baseMatch = el.matches(baseSelector);
    } catch (_e) {
      return false;
    }
  }
  if (!baseMatch) {
    return false;
  }

  if (textFilters.length > 0) {
    const text = el.textContent || "";
    return textFilters.every((filter) => text.indexOf(filter) !== -1);
  }
  return true;
}

// ---------------------------------------------------------------------------
// CheerioSelection
// ---------------------------------------------------------------------------

class CheerioSelection {
  constructor(elements) {
    const els = Array.isArray(elements) ? elements : [];
    this._elements = els;
    this.length = els.length;

    // Expose numeric indices so sel[0] etc. work like jQuery/cheerio.
    for (let i = 0; i < els.length; i++) {
      this[i] = els[i];
    }
  }

  // -- Traversal -----------------------------------------------------------

  find(selector) {
    if (!selector) {
      return new CheerioSelection([]);
    }
    const results = [];
    for (const el of this._elements) {
      const found = querySelectorAll(el, selector);
      for (const f of found) {
        if (results.indexOf(f) === -1) {
          results.push(f);
        }
      }
    }
    return new CheerioSelection(results);
  }

  filter(selectorOrFn) {
    if (typeof selectorOrFn === "function") {
      const fn = selectorOrFn;
      const filtered = this._elements.filter((el, i) => fn.call(el, i, el));
      return new CheerioSelection(filtered);
    }
    if (typeof selectorOrFn === "string") {
      const filtered = this._elements.filter((el) =>
        matchesSelector(el, selectorOrFn)
      );
      return new CheerioSelection(filtered);
    }
    return new CheerioSelection([]);
  }

  children(selector) {
    const results = [];
    for (const el of this._elements) {
      const kids = Array.from(el.children || []);
      for (const kid of kids) {
        if (!selector || matchesSelector(kid, selector)) {
          if (results.indexOf(kid) === -1) {
            results.push(kid);
          }
        }
      }
    }
    return new CheerioSelection(results);
  }

  next() {
    const results = [];
    for (const el of this._elements) {
      const sib = el.nextElementSibling;
      if (sib && results.indexOf(sib) === -1) {
        results.push(sib);
      }
    }
    return new CheerioSelection(results);
  }

  prev() {
    const results = [];
    for (const el of this._elements) {
      const sib = el.previousElementSibling;
      if (sib && results.indexOf(sib) === -1) {
        results.push(sib);
      }
    }
    return new CheerioSelection(results);
  }

  first() {
    return new CheerioSelection(
      this._elements.length > 0 ? [this._elements[0]] : []
    );
  }

  last() {
    return new CheerioSelection(
      this._elements.length > 0
        ? [this._elements[this._elements.length - 1]]
        : []
    );
  }

  eq(index) {
    const i = index < 0 ? this._elements.length + index : index;
    const el = this._elements[i];
    return new CheerioSelection(el ? [el] : []);
  }

  // -- Iteration -----------------------------------------------------------

  each(callback) {
    for (let i = 0; i < this._elements.length; i++) {
      const ret = callback.call(this._elements[i], i, this._elements[i]);
      if (ret === false) {
        break;
      }
    }
    return this;
  }

  map(callback) {
    const results = [];
    for (let i = 0; i < this._elements.length; i++) {
      results.push(callback.call(this._elements[i], i, this._elements[i]));
    }
    return results;
  }

  // -- Data extraction -----------------------------------------------------

  text() {
    return this._elements.map((el) => el.textContent || "").join("");
  }

  html() {
    if (this._elements.length === 0) {
      return null;
    }
    return this._elements[0].innerHTML || null;
  }

  attr(name) {
    if (this._elements.length === 0 || !name) {
      return undefined;
    }
    const el = this._elements[0];
    if (!el.hasAttribute || !el.hasAttribute(name)) {
      return undefined;
    }
    return el.getAttribute(name);
  }

  // -- Raw access ----------------------------------------------------------

  get(index) {
    if (index === undefined || index === null) {
      return this._elements.slice();
    }
    const i = index < 0 ? this._elements.length + index : index;
    return this._elements[i];
  }

  toArray() {
    return this._elements.slice();
  }
}

// ---------------------------------------------------------------------------
// cheerioLoad
// ---------------------------------------------------------------------------

/**
 * Parse an HTML string and return a jQuery-like \`$\` function.
 *
 * @param {string} html  Raw HTML markup
 * @returns {Function}   $ selector function with .html() helper
 */
function cheerioLoad(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");

  /**
   * $(selector)          — query against the whole document
   * $(selector, context) — query within a context element or CheerioSelection
   * $(element)           — wrap a raw DOM element
   */
  function $(selectorOrElement, context) {
    // Wrap a raw DOM element / node.
    if (
      selectorOrElement &&
      typeof selectorOrElement === "object" &&
      selectorOrElement.nodeType
    ) {
      return new CheerioSelection([selectorOrElement]);
    }

    // Wrap an existing CheerioSelection (no-op pass through).
    if (selectorOrElement instanceof CheerioSelection) {
      return selectorOrElement;
    }

    if (typeof selectorOrElement !== "string") {
      return new CheerioSelection([]);
    }

    // Determine root to search from.
    let root = doc;
    if (context) {
      if (context instanceof CheerioSelection) {
        // Search within all context elements and dedupe.
        const results = [];
        for (const ctxEl of context._elements) {
          const found = querySelectorAll(ctxEl, selectorOrElement);
          for (const f of found) {
            if (results.indexOf(f) === -1) {
              results.push(f);
            }
          }
        }
        return new CheerioSelection(results);
      }
      if (context.nodeType) {
        root = context;
      }
    }

    return new CheerioSelection(querySelectorAll(root, selectorOrElement));
  }

  /**
   * $.html(selection?) — serialize HTML.
   * Without args: returns the full document HTML.
   * With a CheerioSelection: returns outerHTML of the first matched element.
   */
  $.html = function (selection) {
    if (!selection) {
      return doc.documentElement ? doc.documentElement.outerHTML : "";
    }
    if (selection instanceof CheerioSelection) {
      if (selection._elements.length === 0) {
        return null;
      }
      return selection._elements[0].outerHTML || null;
    }
    // If passed a raw element.
    if (selection && selection.outerHTML) {
      return selection.outerHTML;
    }
    return null;
  };

  return $;
}

// ---------------------------------------------------------------------------
// scraperWorker.js — Web Worker entry point for sandboxed scraper execution.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 262144; // 256 KB
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// ---------------------------------------------------------------------------
// Console proxy — forward all console calls to the main thread
// ---------------------------------------------------------------------------

function makeConsoleProxy() {
  const levels = ["log", "error", "warn", "info", "debug"];
  const proxy = {};
  levels.forEach((level) => {
    proxy[level] = function (...args) {
      try {
        self.postMessage({
          type: "console",
          level,
          args: args.map((a) => {
            try {
              return typeof a === "object" ? JSON.stringify(a) : String(a);
            } catch (_) {
              return "[unserializable]";
            }
          })
        });
      } catch (_) {
        // swallow — worker may be terminating
      }
    };
  });
  return proxy;
}

const consoleProxy = makeConsoleProxy();

// ---------------------------------------------------------------------------
// CryptoJS-compatible stub
// ---------------------------------------------------------------------------

function buildCryptoJS() {
  // Minimal WordArray — thin wrapper around Uint8Array
  class WordArray {
    constructor(bytes) {
      this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
      this.sigBytes = this.bytes.length;
    }

    static random(nBytes) {
      const buf = new Uint8Array(nBytes);
      crypto.getRandomValues(buf);
      return new WordArray(buf);
    }

    clone() {
      return new WordArray(new Uint8Array(this.bytes));
    }

    toString(encoder) {
      if (encoder && typeof encoder.stringify === "function") {
        return encoder.stringify(this);
      }
      // Default: hex
      return Array.from(this.bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  }

  // Encoders ------------------------------------------------------------------

  const encHex = {
    stringify(wordArray) {
      return Array.from(wordArray.bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    },
    parse(hexStr) {
      const bytes = [];
      for (let i = 0; i < hexStr.length; i += 2) {
        bytes.push(parseInt(hexStr.substr(i, 2), 16));
      }
      return new WordArray(new Uint8Array(bytes));
    }
  };

  const encUtf8 = {
    stringify(wordArray) {
      return new TextDecoder().decode(wordArray.bytes);
    },
    parse(str) {
      return new WordArray(new TextEncoder().encode(str));
    }
  };

  const encBase64 = {
    stringify(wordArray) {
      let binary = "";
      wordArray.bytes.forEach((b) => {
        binary += String.fromCharCode(b);
      });
      return btoa(binary);
    },
    parse(b64Str) {
      const binary = atob(b64Str);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new WordArray(bytes);
    }
  };

  // Simple hash helpers — NOT cryptographically accurate, but produce
  // deterministic hex-like output that matches the shape scrapers expect.

  function simpleHash(msg, rounds) {
    const input = typeof msg === "string" ? msg : encUtf8.stringify(msg);
    let h = 0x811c9dc5;
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
    }
    // Stretch to desired byte-count by rehashing
    const bytes = [];
    let state = h >>> 0;
    for (let i = 0; i < rounds; i++) {
      state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
      state = Math.imul(state ^ (state >>> 13), 0x45d9f3b);
      state = (state ^ (state >>> 16)) >>> 0;
      bytes.push((state >>> 24) & 0xff);
      bytes.push((state >>> 16) & 0xff);
      bytes.push((state >>> 8) & 0xff);
      bytes.push(state & 0xff);
    }
    return new WordArray(new Uint8Array(bytes));
  }

  function MD5(msg) {
    return simpleHash(msg, 4); // 16 bytes → 32 hex chars
  }

  function SHA1(msg) {
    return simpleHash(msg, 5); // 20 bytes → 40 hex chars
  }

  function SHA256(msg) {
    return simpleHash(msg, 8); // 32 bytes → 64 hex chars
  }

  // AES stubs — base64 encode/decode as a stand-in

  const AES = {
    encrypt(msg, key) {
      const plainText = typeof msg === "string" ? msg : encUtf8.stringify(msg);
      const cipherText = btoa(plainText);
      return {
        toString() {
          return cipherText;
        },
        ciphertext: encBase64.parse(cipherText)
      };
    },
    decrypt(cipher, key) {
      const cipherStr =
        typeof cipher === "string" ? cipher : cipher.toString();
      let decoded;
      try {
        decoded = atob(cipherStr);
      } catch (_) {
        decoded = cipherStr;
      }
      const wa = encUtf8.parse(decoded);
      return {
        toString(enc) {
          if (enc && typeof enc.stringify === "function") {
            return enc.stringify(wa);
          }
          return decoded;
        },
        bytes: wa.bytes
      };
    }
  };

  return {
    MD5,
    SHA1,
    SHA256,
    AES,
    enc: {
      Base64: encBase64,
      Utf8: encUtf8,
      Hex: encHex
    },
    lib: {
      WordArray
    }
  };
}

// ---------------------------------------------------------------------------
// Cheerio module (wraps the cheerioLoad function)
// ---------------------------------------------------------------------------

function buildCheerioModule() {
  return {
    load: cheerioLoad
  };
}

// ---------------------------------------------------------------------------
// require() shim
// ---------------------------------------------------------------------------

function buildRequire(cheerioMod, cryptoMod) {
  const modules = {
    "cheerio": cheerioMod,
    "crypto-js": cryptoMod,
    "cryptojs": cryptoMod
  };

  return function __require__(name) {
    const key = String(name).toLowerCase().trim();
    if (modules[key]) {
      return modules[key];
    }
    throw new Error("Module not found: " + name);
  };
}

// ---------------------------------------------------------------------------
// Fetch implementation with CORS proxy fallback
// ---------------------------------------------------------------------------

let fetchRequestCounter = 0;
const pendingFetches = new Map();

/**
 * Listen for fetchResponse messages from the main thread and resolve the
 * matching pending promise.
 */
function handleFetchResponse(data) {
  if (data.type !== "fetchResponse") return;
  const pending = pendingFetches.get(data.requestId);
  if (!pending) return;
  pendingFetches.delete(data.requestId);
  pending.resolve(data);
}

/**
 * Proxy a fetch request through the main thread.
 */
function proxyFetch(url, options) {
  return new Promise((resolve, reject) => {
    const requestId = ++fetchRequestCounter;
    const timer = setTimeout(() => {
      pendingFetches.delete(requestId);
      reject(new Error("Proxy fetch timeout: " + url));
    }, FETCH_TIMEOUT_MS);

    pendingFetches.set(requestId, {
      resolve(data) {
        clearTimeout(timer);
        resolve(data);
      },
      reject(err) {
        clearTimeout(timer);
        reject(err);
      }
    });

    self.postMessage({
      type: "fetch",
      requestId,
      url: String(url),
      method: (options && options.method) || "GET",
      headers: (options && options.headers) || {},
      body: (options && options.body) || null
    });
  });
}

/**
 * Build a Response-like object from proxy data.
 */
function buildProxyResponse(data) {
  const headers = new Headers(data.headers || {});
  return {
    ok: Boolean(data.ok),
    status: data.status || 0,
    statusText: data.statusText || "",
    url: data.url || "",
    headers,
    _body: data.body || "",
    _truncated: Boolean(data.truncated),
    async text() {
      return this._body;
    },
    async json() {
      return JSON.parse(this._body);
    },
    async arrayBuffer() {
      const enc = new TextEncoder();
      return enc.encode(this._body).buffer;
    }
  };
}

/**
 * Truncate a response body string to MAX_BODY_BYTES.
 * Returns { body, truncated }.
 */
function truncateBody(bodyStr) {
  if (typeof bodyStr !== "string") {
    bodyStr = String(bodyStr);
  }
  if (new Blob([bodyStr]).size <= MAX_BODY_BYTES) {
    return { body: bodyStr, truncated: false };
  }
  // Truncate by character — slightly conservative but simple
  let truncated = bodyStr.slice(0, MAX_BODY_BYTES);
  return { body: truncated, truncated: true };
}

/**
 * Create the sandboxed fetch function injected into scrapers.
 */
function buildFetch() {
  return async function scraperFetch(url, options) {
    const opts = Object.assign({}, options || {});

    // Ensure default User-Agent
    const hdrs = Object.assign({}, opts.headers || {});
    if (!hdrs["User-Agent"] && !hdrs["user-agent"]) {
      hdrs["User-Agent"] = DEFAULT_USER_AGENT;
    }
    opts.headers = hdrs;

    // ---------- Try direct fetch first ----------
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const directResponse = await fetch(url, {
        ...opts,
        signal: controller.signal
      });
      clearTimeout(timer);

      // Wrap to enforce body limit
      const originalText = directResponse.text.bind(directResponse);
      const wrappedResponse = {
        ok: directResponse.ok,
        status: directResponse.status,
        statusText: directResponse.statusText,
        url: directResponse.url,
        headers: directResponse.headers,
        _bodyPromise: null,
        _getBody() {
          if (!this._bodyPromise) {
            this._bodyPromise = originalText().then((raw) => truncateBody(raw));
          }
          return this._bodyPromise;
        },
        async text() {
          const result = await this._getBody();
          return result.body;
        },
        async json() {
          const txt = await this.text();
          return JSON.parse(txt);
        },
        async arrayBuffer() {
          const txt = await this.text();
          return new TextEncoder().encode(txt).buffer;
        }
      };
      return wrappedResponse;
    } catch (_directError) {
      // Direct fetch failed (CORS, network, etc.) — fall back to proxy
    }

    // ---------- Proxy through main thread ----------
    try {
      const proxyData = await proxyFetch(url, opts);
      return buildProxyResponse(proxyData);
    } catch (proxyError) {
      throw new Error(
        "Fetch failed for " + url + ": " + (proxyError.message || proxyError)
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Result normalisation
// ---------------------------------------------------------------------------

function normalizeResults(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((item) => item && typeof item === "object" && item.url)
    .map((item) => ({
      url: String(item.url),
      title: String(item.title || item.name || ""),
      name: String(item.name || item.title || ""),
      quality: String(item.quality || ""),
      size: String(item.size || ""),
      language: String(item.language || ""),
      type: String(item.type || ""),
      seeders: Number(item.seeders) || 0,
      peers: Number(item.peers) || 0,
      infoHash: String(item.infoHash || ""),
      headers: item.headers && typeof item.headers === "object"
        ? item.headers
        : {}
    }));
}

// ---------------------------------------------------------------------------
// Scraper execution
// ---------------------------------------------------------------------------

async function executeScraper(data) {
  const {
    code,
    tmdbId,
    mediaType,
    season,
    episode,
    scraperId,
    settings,
    tmdbApiKey
  } = data;

  // Normalise type: "series" → "tv"
  const normalizedType = mediaType === "series" ? "tv" : mediaType;

  // Prepare season / episode as Number or undefined
  const seasonArg = season != null ? Number(season) : undefined;
  const episodeArg = episode != null ? Number(episode) : undefined;

  // Build injected modules
  const cheerioMod = buildCheerioModule();
  const cryptoMod = buildCryptoJS();
  const requireFn = buildRequire(cheerioMod, cryptoMod);
  const fetchFn = buildFetch();

  // Build the wrapped source code
  const wrappedCode = [
    "var module = { exports: {} };",
    "var exports = module.exports;",
    "var require = __require__;",
    "var fetch = __fetch__;",
    "var console = __console__;",
    "var SCRAPER_ID = __scraperId__;",
    "var SCRAPER_SETTINGS = __scraperSettings__;",
    "var TMDB_API_KEY = __tmdbApiKey__;",
    "var cheerio = require('cheerio');",
    "var CryptoJS = require('crypto-js');",
    "var global = self;",
    "var window = self;",
    "",
    "(function() {",
    code,
    "})();",
    "",
    "return module.exports;"
  ].join("\\n");

  // Execute using new Function
  let moduleExports;
  try {
    const factory = new Function(
      "__require__",
      "__fetch__",
      "__console__",
      "__scraperId__",
      "__scraperSettings__",
      "__tmdbApiKey__",
      wrappedCode
    );

    moduleExports = factory(
      requireFn,
      fetchFn,
      consoleProxy,
      scraperId || "",
      settings || {},
      tmdbApiKey || ""
    );
  } catch (err) {
    throw new Error("Scraper compilation error: " + (err.message || err));
  }

  // Invoke getStreams
  if (
    !moduleExports ||
    typeof moduleExports.getStreams !== "function"
  ) {
    throw new Error(
      "Scraper does not export a getStreams() function"
    );
  }

  const rawResults = await moduleExports.getStreams(
    tmdbId,
    normalizedType,
    seasonArg,
    episodeArg
  );

  return normalizeResults(rawResults);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async function (event) {
  const data = event.data;
  if (!data || !data.type) return;

  // Handle fetch responses from the main thread
  if (data.type === "fetchResponse") {
    handleFetchResponse(data);
    return;
  }

  // Handle execute commands
  if (data.type === "execute") {
    try {
      const results = await executeScraper(data);
      self.postMessage({ type: "result", results });
    } catch (err) {
      self.postMessage({
        type: "error",
        message: String(err.message || err)
      });
    }
    return;
  }
};
`;
}

let workerBlobUrl = null;

function getWorkerBlobUrl() {
  if (workerBlobUrl) return workerBlobUrl;
  const blob = new Blob([buildWorkerCode()], { type: "application/javascript" });
  workerBlobUrl = URL.createObjectURL(blob);
  return workerBlobUrl;
}

// ---------------------------------------------------------------------------
// Fetch proxy handler (main thread → worker)
// ---------------------------------------------------------------------------

async function handleWorkerFetch(worker, data) {
  const { requestId, url, method, headers, body } = data;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(url, {
      method: method || "GET",
      headers: headers || {},
      body: body || undefined,
      signal: controller.signal
    });

    const text = await response.text();
    clearTimeout(timer);

    try {
      worker.postMessage({
        type: "fetchResponse",
        requestId,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        headers: Object.fromEntries(response.headers.entries()),
        body: text,
        truncated: false
      });
    } catch (_) {
      // Worker was terminated before we could respond
    }
  } catch (err) {
    try {
      worker.postMessage({
        type: "fetchResponse",
        requestId,
        ok: false,
        status: 0,
        statusText: "",
        url: url,
        headers: {},
        body: "",
        truncated: false,
        error: String(err.message || err)
      });
    } catch (_) {
      // Worker was terminated
    }
  }
}

// ---------------------------------------------------------------------------
// Run a single scraper inside a Web Worker
// ---------------------------------------------------------------------------

function runScraperInWorker(code, params) {
  return new Promise((resolve, reject) => {
    const blobUrl = getWorkerBlobUrl();
    let worker;

    try {
      worker = new Worker(blobUrl);
    } catch (err) {
      reject(new Error("Failed to create worker: " + (err.message || err)));
      return;
    }

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("Scraper timed out after " + PLUGIN_TIMEOUT_MS + "ms"));
    }, PLUGIN_TIMEOUT_MS);

    worker.onmessage = (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      if (msg.type === "fetch") {
        handleWorkerFetch(worker, msg);
        return;
      }

      if (msg.type === "console") {
        const level = msg.level || "log";
        const args = Array.isArray(msg.args) ? msg.args : [];
        const prefix = "[scraper:" + (params.scraperId || "unknown") + "]";
        if (typeof console[level] === "function") {
          console[level](prefix, ...args);
        }
        return;
      }

      if (msg.type === "result") {
        clearTimeout(timer);
        worker.terminate();
        resolve(Array.isArray(msg.results) ? msg.results : []);
        return;
      }

      if (msg.type === "error") {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(msg.message || "Unknown scraper error"));
        return;
      }
    };

    worker.onerror = (err) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error("Worker error: " + (err.message || err)));
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
      tmdbApiKey: TMDB_API_KEY
    });
  });
}

// ---------------------------------------------------------------------------
// Legacy source helpers (preserved from original implementation)
// ---------------------------------------------------------------------------

function normalizeSources(input) {
  if (!Array.isArray(input)) {
    return [];
  }
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
    const token = `{${key}}`;
    output = output.split(token).join(String(value ?? ""));
  });
  return output;
}

/**
 * Execute legacy URL-template sources. Returns an array of result objects.
 */
function executeLegacy({ tmdbId, mediaType, season = null, episode = null } = {}) {
  const vars = {
    tmdbId: tmdbId || "",
    mediaType: mediaType || "",
    season: season ?? "",
    episode: episode ?? ""
  };

  return normalizeSources(LocalStore.get(LEGACY_KEY, []))
    .filter((source) => source.enabled)
    .map((source) => {
      const url = applyTemplate(source.urlTemplate, vars).trim();
      if (!url) {
        return null;
      }
      return {
        sourceId: source.id,
        sourceName: source.name,
        streams: [
          {
            name: `${source.name} Source`,
            title: `${source.name} Stream`,
            url,
            description: `Generated by template: ${source.urlTemplate}`
          }
        ]
      };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Repository helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a scraper filename to an absolute URL.
 * If filename already starts with http:// or https://, use as-is.
 * Otherwise prepend repoUrl + "/".
 */
function resolveScraperUrl(repoUrl, filename) {
  if (/^https?:\/\//i.test(filename)) {
    return filename;
  }
  return repoUrl.replace(/\/+$/, "") + "/" + filename;
}

/**
 * Download and store scraper code for all scrapers declared in a manifest.
 * Preserves the enabled state of already-existing scrapers.
 */
async function refreshRepositoryScrapers(repo, manifest) {
  const existingScrapers = PluginDataStore.getScrapers();

  // Build lookup of current enabled state for this repo's scrapers
  const enabledMap = {};
  for (const s of existingScrapers) {
    if (s.repositoryId === repo.id) {
      enabledMap[s.id] = s.enabled;
    }
  }

  const updatedScrapers = [];
  const manifestScrapers = Array.isArray(manifest.scrapers) ? manifest.scrapers : [];

  for (const entry of manifestScrapers) {
    if (!entry || !entry.id || !entry.filename) {
      console.warn("[pluginRuntime] Skipping scraper with missing id or filename:", entry);
      continue;
    }

    const scraperId = repo.id + ":" + entry.id;
    const codeUrl = resolveScraperUrl(repo.url, entry.filename);

    // Download scraper code
    let code = null;
    try {
      const response = await fetch(codeUrl);
      if (!response.ok) {
        console.warn("[pluginRuntime] Failed to download scraper code:", codeUrl, response.status);
        continue;
      }
      code = await response.text();
    } catch (err) {
      console.warn("[pluginRuntime] Error downloading scraper code:", codeUrl, err.message || err);
      continue;
    }

    // Check size limit
    if (new Blob([code]).size > MAX_SCRAPER_CODE_BYTES) {
      console.warn("[pluginRuntime] Scraper code exceeds 5MB limit, skipping:", scraperId);
      continue;
    }

    // Store code
    PluginDataStore.saveScraperCode(scraperId, code);

    // Preserve existing enabled state, otherwise use manifest default
    const enabled = scraperId in enabledMap
      ? enabledMap[scraperId]
      : entry.enabled !== false;

    updatedScrapers.push({
      id: scraperId,
      name: entry.name || entry.id,
      version: entry.version || "",
      filename: entry.filename,
      supportedTypes: Array.isArray(entry.supportedTypes) ? entry.supportedTypes : [],
      enabled,
      manifestEnabled: entry.enabled !== false,
      logo: entry.logo || null,
      contentLanguage: Array.isArray(entry.contentLanguage) ? entry.contentLanguage : [],
      formats: Array.isArray(entry.formats) ? entry.formats : [],
      repositoryId: repo.id
    });
  }

  // Replace only this repo's scrapers; keep other repos' scrapers intact
  const otherScrapers = existingScrapers.filter((s) => s.repositoryId !== repo.id);

  // Clean up code for scrapers from this repo that are no longer in the manifest
  for (const s of existingScrapers) {
    if (s.repositoryId === repo.id) {
      const stillExists = updatedScrapers.some((u) => u.id === s.id);
      if (!stillExists) {
        PluginDataStore.deleteScraperCode(s.id);
      }
    }
  }

  PluginDataStore.saveScrapers([...otherScrapers, ...updatedScrapers]);
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

export const PluginRuntime = {

  // ── Legacy source methods (backward-compatible) ──────────────────────

  listSources() {
    return normalizeSources(LocalStore.get(LEGACY_KEY, []));
  },

  saveSources(sources) {
    LocalStore.set(LEGACY_KEY, normalizeSources(sources));
  },

  addSource(source) {
    const current = this.listSources();
    current.push(source);
    this.saveSources(current);
  },

  removeSource(sourceId) {
    const next = this.listSources().filter((source) => source.id !== sourceId);
    this.saveSources(next);
  },

  setSourceEnabled(sourceId, enabled) {
    const next = this.listSources().map((source) => {
      if (source.id !== sourceId) {
        return source;
      }
      return { ...source, enabled: Boolean(enabled) };
    });
    this.saveSources(next);
  },

  /**
   * Legacy URL-template execution. Kept as `execute` for backward compat.
   */
  execute({ tmdbId, mediaType, season = null, episode = null } = {}) {
    return executeLegacy({ tmdbId, mediaType, season, episode });
  },

  // ── Repository methods ───────────────────────────────────────────────

  /**
   * Fetch manifest from `{repoUrl}/manifest.json`, store the repo, and
   * download all declared scraper code.
   */
  async addRepository(repoUrl) {
    if (!repoUrl || typeof repoUrl !== "string") {
      throw new Error("Invalid repository URL");
    }

    const cleanUrl = repoUrl.replace(/\/+$/, "");
    const manifestUrl = cleanUrl + "/manifest.json";

    let manifest;
    try {
      const response = await fetch(manifestUrl);
      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }
      manifest = await response.json();
    } catch (err) {
      throw new Error("Failed to fetch repository manifest: " + (err.message || err));
    }

    if (!manifest || typeof manifest !== "object") {
      throw new Error("Invalid manifest format");
    }

    const repo = PluginDataStore.addRepository({
      url: cleanUrl,
      name: manifest.name || "",
      version: manifest.version || "",
      description: manifest.description || "",
      author: manifest.author || ""
    });

    if (!repo) {
      throw new Error("Repository already exists or could not be added");
    }

    await refreshRepositoryScrapers(repo, manifest);
    return repo;
  },

  /**
   * Re-fetch the manifest and scraper code for an existing repository.
   */
  async refreshRepository(repoId) {
    const repos = PluginDataStore.getRepositories();
    const repo = repos.find((r) => r.id === repoId);
    if (!repo) {
      throw new Error("Repository not found: " + repoId);
    }

    const manifestUrl = repo.url + "/manifest.json";

    let manifest;
    try {
      const response = await fetch(manifestUrl);
      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }
      manifest = await response.json();
    } catch (err) {
      throw new Error("Failed to fetch repository manifest: " + (err.message || err));
    }

    // Update repo metadata
    const updatedRepo = {
      ...repo,
      name: manifest.name || repo.name,
      version: manifest.version || repo.version,
      description: manifest.description || repo.description,
      author: manifest.author || repo.author
    };

    const allRepos = PluginDataStore.getRepositories().map((r) =>
      r.id === repoId ? updatedRepo : r
    );
    PluginDataStore.saveRepositories(allRepos);

    await refreshRepositoryScrapers(updatedRepo, manifest);
    return updatedRepo;
  },

  /**
   * Remove a repository and all its scrapers + code.
   */
  removeRepository(repoId) {
    PluginDataStore.removeRepository(repoId);
  },

  /**
   * List all installed repositories.
   */
  listRepositories() {
    return PluginDataStore.getRepositories();
  },

  /**
   * List all scrapers across all repositories.
   */
  listScrapers() {
    return PluginDataStore.getScrapers();
  },

  /**
   * Enable or disable a repository scraper.
   */
  setScraperEnabled(scraperId, enabled) {
    PluginDataStore.setScraperEnabled(scraperId, enabled);
  },

  // ── Combined execution ───────────────────────────────────────────────

  /**
   * Execute ALL sources — both legacy URL-template sources and repository
   * scrapers — returning combined results capped at MAX_RESULT_ITEMS.
   *
   * @param {Object} params
   * @param {string} params.tmdbId
   * @param {string} params.mediaType
   * @param {number|null} params.season
   * @param {number|null} params.episode
   * @param {Function} [params.onChunk] — called as (scraperName, results) for each source
   * @returns {Promise<Array>} Combined results array
   */
  async executeAll({ tmdbId, mediaType, season = null, episode = null, onChunk } = {}) {
    const allResults = [];

    // 1. Run legacy URL-template sources (synchronous, no workers)
    const legacyResults = executeLegacy({ tmdbId, mediaType, season, episode });
    for (const result of legacyResults) {
      allResults.push(result);
      if (typeof onChunk === "function") {
        onChunk(result.sourceName, result.streams);
      }
    }

    // 2. Run repository scrapers in Web Workers (max 5 concurrent)
    const scrapers = PluginDataStore.getScrapers().filter((s) => s.enabled && s.manifestEnabled);

    // Filter by supported media type
    const normalizedType = mediaType === "series" ? "tv" : mediaType;
    const applicableScrapers = scrapers.filter((s) => {
      if (s.supportedTypes.length === 0) return true;
      return s.supportedTypes.includes(normalizedType) || s.supportedTypes.includes(mediaType);
    });

    const scraperPromises = applicableScrapers.map(async (scraper) => {
      const code = PluginDataStore.getScraperCode(scraper.id);
      if (!code) {
        console.warn("[pluginRuntime] No code cached for scraper:", scraper.id);
        return null;
      }

      await acquireWorkerSlot();
      try {
        const settings = PluginDataStore.getScraperSettings(scraper.id);
        const results = await runScraperInWorker(code, {
          tmdbId,
          mediaType: normalizedType,
          season,
          episode,
          scraperId: scraper.id,
          settings
        });

        if (results.length > 0) {
          const chunk = {
            sourceId: scraper.id,
            sourceName: scraper.name,
            streams: results
          };
          allResults.push(chunk);
          if (typeof onChunk === "function") {
            onChunk(scraper.name, results);
          }
        }
        return results;
      } catch (err) {
        console.warn("[pluginRuntime] Scraper failed:", scraper.id, err.message || err);
        return null;
      } finally {
        releaseWorkerSlot();
      }
    });

    await Promise.allSettled(scraperPromises);

    // Cap total streams across all sources
    let totalStreams = 0;
    const cappedResults = [];
    for (const result of allResults) {
      if (totalStreams >= MAX_RESULT_ITEMS) break;
      const remaining = MAX_RESULT_ITEMS - totalStreams;
      if (result.streams.length <= remaining) {
        cappedResults.push(result);
        totalStreams += result.streams.length;
      } else {
        cappedResults.push({
          ...result,
          streams: result.streams.slice(0, remaining)
        });
        totalStreams += remaining;
      }
    }

    return cappedResults;
  }

};
