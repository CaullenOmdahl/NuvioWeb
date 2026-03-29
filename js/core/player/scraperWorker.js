/**
 * scraperWorker.js — Web Worker entry point for sandboxed scraper execution.
 *
 * Receives scraper JS code + parameters from the main thread, wraps it in a
 * CommonJS-style module pattern, injects the globals scrapers expect (cheerio,
 * CryptoJS, fetch with CORS fallback proxy, etc.), executes getStreams(), and
 * posts normalised results back.
 *
 * Message protocol is documented in the task spec above and in pluginRuntime.
 *
 * NOTE: The static import below is a reference for the non-inlined version.
 * When this file is later inlined as a Blob URL (Task 7) the cheerioLoad
 * source will be concatenated directly.
 */

import { cheerioLoad } from "./cheerioCompat.js";

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
// Cheerio module (wraps the cheerioLoad import)
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
  ].join("\n");

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
