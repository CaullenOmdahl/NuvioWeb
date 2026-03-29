import { LocalStore } from "../storage/localStore.js";

const KEY_REPOSITORIES = "pluginRepositories";
const KEY_SCRAPERS = "pluginScrapers";
const KEY_SCRAPER_CODE_PREFIX = "pluginScraperCode:";
const KEY_SCRAPER_SETTINGS_PREFIX = "pluginScraperSettings:";

function generateId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function stripTrailingSlash(url) {
  return String(url).replace(/\/+$/, "");
}

function normalizeRepo(repo) {
  if (!repo || !repo.url) return null;
  return {
    id: repo.id || generateId(),
    url: stripTrailingSlash(repo.url),
    name: repo.name || "",
    version: repo.version || "",
    description: repo.description || "",
    author: repo.author || ""
  };
}

function normalizeScraper(scraper) {
  if (!scraper || !scraper.id) return null;
  return {
    id: scraper.id,
    name: scraper.name || "",
    version: scraper.version || "",
    filename: scraper.filename || "",
    supportedTypes: Array.isArray(scraper.supportedTypes) ? scraper.supportedTypes : [],
    enabled: scraper.enabled !== false,
    manifestEnabled: scraper.manifestEnabled !== false,
    logo: scraper.logo || null,
    contentLanguage: Array.isArray(scraper.contentLanguage) ? scraper.contentLanguage : [],
    formats: Array.isArray(scraper.formats) ? scraper.formats : [],
    repositoryId: scraper.repositoryId || ""
  };
}

export const PluginDataStore = {

  // ── Repositories ──────────────────────────────────────────────────

  getRepositories() {
    const raw = LocalStore.get(KEY_REPOSITORIES, []);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeRepo).filter(Boolean);
  },

  saveRepositories(repos) {
    const normalized = (Array.isArray(repos) ? repos : [])
      .map(normalizeRepo)
      .filter(Boolean);
    LocalStore.set(KEY_REPOSITORIES, normalized);
  },

  addRepository(repo) {
    const normalized = normalizeRepo(repo);
    if (!normalized) return null;

    const existing = this.getRepositories();
    const duplicate = existing.some(
      (r) => stripTrailingSlash(r.url) === normalized.url
    );
    if (duplicate) return null;

    existing.push(normalized);
    LocalStore.set(KEY_REPOSITORIES, existing);
    return normalized;
  },

  removeRepository(repoId) {
    const repos = this.getRepositories().filter((r) => r.id !== repoId);
    LocalStore.set(KEY_REPOSITORIES, repos);

    const scrapers = this.getScrapers();
    const remaining = [];
    for (const s of scrapers) {
      if (s.repositoryId === repoId) {
        this.deleteScraperCode(s.id);
        LocalStore.remove(KEY_SCRAPER_SETTINGS_PREFIX + s.id);
      } else {
        remaining.push(s);
      }
    }
    LocalStore.set(KEY_SCRAPERS, remaining);
  },

  // ── Scrapers ──────────────────────────────────────────────────────

  getScrapers() {
    const raw = LocalStore.get(KEY_SCRAPERS, []);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeScraper).filter(Boolean);
  },

  saveScrapers(scrapers) {
    const normalized = (Array.isArray(scrapers) ? scrapers : [])
      .map(normalizeScraper)
      .filter(Boolean);
    LocalStore.set(KEY_SCRAPERS, normalized);
  },

  setScraperEnabled(scraperId, enabled) {
    const scrapers = this.getScrapers();
    const target = scrapers.find((s) => s.id === scraperId);
    if (target) {
      target.enabled = Boolean(enabled);
      LocalStore.set(KEY_SCRAPERS, scrapers);
    }
  },

  // ── Scraper Code Cache ────────────────────────────────────────────

  getScraperCode(scraperId) {
    return LocalStore.get(KEY_SCRAPER_CODE_PREFIX + scraperId, null);
  },

  saveScraperCode(scraperId, code) {
    LocalStore.set(KEY_SCRAPER_CODE_PREFIX + scraperId, code);
  },

  deleteScraperCode(scraperId) {
    LocalStore.remove(KEY_SCRAPER_CODE_PREFIX + scraperId);
  },

  // ── Scraper Settings ──────────────────────────────────────────────

  getScraperSettings(scraperId) {
    return LocalStore.get(KEY_SCRAPER_SETTINGS_PREFIX + scraperId, {});
  },

  setScraperSettings(scraperId, settings) {
    LocalStore.set(KEY_SCRAPER_SETTINGS_PREFIX + scraperId, settings || {});
  }

};
