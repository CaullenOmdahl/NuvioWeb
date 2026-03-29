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

  // ── Legacy URL-template source methods (preserved) ──────────────────

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

  // ── Repository management (new) ────────────────────────────────────

  async addRepository(url) {
    return PluginRuntime.addRepository(url);
  },

  removeRepository(repoId) {
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

  // ── Execution (legacy + repo scrapers) ──────────────────────────────

  async executeScrapersStreaming({ tmdbId, mediaType, season = null, episode = null, onChunk = null } = {}) {
    if (!this.pluginsEnabled) {
      return [];
    }

    // If no repo scrapers exist, use legacy-only fast path
    const scrapers = PluginRuntime.listScrapers();
    if (!scrapers.length) {
      return PluginRuntime.execute({ tmdbId, mediaType, season, episode });
    }

    // Full execution: legacy + worker-based scrapers
    const allResults = [];
    const results = await PluginRuntime.executeAll({
      tmdbId,
      mediaType,
      season,
      episode,
      onChunk: (name, streams) => {
        const group = {
          sourceId: name,
          sourceName: name,
          streams
        };
        allResults.push(group);
        if (onChunk) {
          try { onChunk(group); } catch (_) {}
        }
      }
    });

    // If onChunk was used, allResults has the streaming groups.
    // Otherwise fall back to the returned capped results.
    return allResults.length > 0 ? allResults : results;
  }

};
