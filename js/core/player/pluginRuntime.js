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
 * Placeholder worker code. Task 7 will replace this with the real inlined
 * scraperWorker.js + cheerioCompat.js bundle.
 */
function buildWorkerCode() {
  return `
    self.onmessage = function(event) {
      if (event.data.type === "execute") {
        // Placeholder — Task 7 will inline the real worker code here
        self.postMessage({ type: "result", results: [] });
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
