import { AuthManager } from "../auth/authManager.js";
import { SupabaseApi } from "../../data/remote/supabase/supabaseApi.js";
import { PluginRuntime } from "../player/pluginRuntime.js";
import { PluginDataStore } from "../player/pluginDataStore.js";
import { ProfileManager } from "./profileManager.js";

const TABLE = "plugins";
const PUSH_RPC = "sync_push_plugins";
const REPO_TABLE = "plugin_repositories";
const REPO_PUSH_RPC = "sync_push_plugin_repositories";

function resolveProfileId() {
  const raw = Number(ProfileManager.getActiveProfileId() || 1);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.trunc(raw);
  }
  return 1;
}

async function resolvePluginProfileId() {
  const profileId = resolveProfileId();
  if (profileId === 1) {
    return 1;
  }
  const profiles = await ProfileManager.getProfiles();
  const activeProfile = profiles.find((profile) => {
    const id = Number(profile?.profileIndex || profile?.id || 1);
    return Number.isFinite(id) && Math.trunc(id) === profileId;
  });
  const usesPrimaryPlugins = typeof activeProfile?.usesPrimaryPlugins === "boolean"
    ? activeProfile.usesPrimaryPlugins
    : (typeof activeProfile?.uses_primary_plugins === "boolean"
      ? activeProfile.uses_primary_plugins
      : false);
  return usesPrimaryPlugins ? 1 : profileId;
}

function shouldTryLegacyTable(error) {
  if (!error) {
    return false;
  }
  if (error.status === 404) {
    return true;
  }
  if (typeof error.code === "string" && (error.code === "PGRST205" || error.code === "PGRST202")) {
    return true;
  }
  const message = String(error.message || "");
  return message.includes("PGRST205")
    || message.includes("PGRST202")
    || message.includes("Could not find the table")
    || message.includes("Could not find the function");
}

function sourceIdFromUrl(url, index) {
  const compact = String(url || "")
    .replace(/[^a-z0-9]/gi, "")
    .slice(-18)
    .toLowerCase();
  return `plugin_${index + 1}_${compact || "source"}`;
}

function mapRemoteRowsToSources(rows = []) {
  return (rows || [])
    .map((row, index) => {
      const url = row.url || row.url_template || row.urlTemplate || "";
      if (!url) {
        return null;
      }
      return {
        id: sourceIdFromUrl(url, index),
        name: row.name || `Plugin ${index + 1}`,
        urlTemplate: url,
        enabled: row.enabled !== false
      };
    })
    .filter(Boolean);
}

function sourceKey(source = {}) {
  return String(source.urlTemplate || "").trim();
}

function mergeSources(localSources = [], remoteSources = []) {
  if (!remoteSources.length) {
    return [...localSources];
  }
  const localByKey = new Map();
  localSources.forEach((source) => {
    const key = sourceKey(source);
    if (!key) {
      return;
    }
    localByKey.set(key, source);
  });

  const merged = [];
  remoteSources.forEach((remoteSource, index) => {
    const key = sourceKey(remoteSource);
    if (!key) {
      return;
    }
    const localSource = localByKey.get(key);
    merged.push({
      ...(localSource || {}),
      ...remoteSource,
      id: remoteSource.id || localSource?.id || sourceIdFromUrl(key, index)
    });
    localByKey.delete(key);
  });

  localByKey.forEach((localSource) => {
    merged.push(localSource);
  });

  return merged;
}

function readLocalSources() {
  return PluginRuntime.listSources();
}

function writeLocalSources(sources) {
  PluginRuntime.saveSources(sources || []);
}

export const PluginSyncService = {

  async pull() {
    try {
      if (!AuthManager.isAuthenticated) {
        return [];
      }
      const localSources = readLocalSources();
      const profileId = await resolvePluginProfileId();
      const ownerId = await AuthManager.getEffectiveUserId();
      const rows = await SupabaseApi.select(
        TABLE,
        `user_id=eq.${encodeURIComponent(ownerId)}&profile_id=eq.${profileId}&select=url,name,enabled,sort_order&order=sort_order.asc`,
        true
      );
      const remoteSources = mapRemoteRowsToSources(rows);
      if (!remoteSources.length && localSources.length) {
        return localSources;
      }
      const mergedSources = mergeSources(localSources, remoteSources);
      writeLocalSources(mergedSources);

      // Also pull repository URLs (fail silently if backend unsupported)
      await this.pullRepositories();

      return mergedSources;
    } catch (error) {
      console.warn("Plugin sync pull failed", error);
      return [];
    }
  },

  async push() {
    try {
      if (!AuthManager.isAuthenticated) {
        return false;
      }
      const profileId = await resolvePluginProfileId();
      const sources = readLocalSources();
      try {
        await SupabaseApi.rpc(PUSH_RPC, {
          p_profile_id: profileId,
          p_plugins: sources.map((source, index) => ({
            url: source.urlTemplate,
            name: source.name || `Plugin ${index + 1}`,
            enabled: source.enabled !== false,
            sort_order: index
          }))
        }, true);
      } catch (rpcError) {
        if (!shouldTryLegacyTable(rpcError)) {
          throw rpcError;
        }

        const ownerId = await AuthManager.getEffectiveUserId();
        const rows = sources.map((source, index) => ({
          user_id: ownerId,
          profile_id: profileId,
          url: source.urlTemplate,
          name: source.name || `Plugin ${index + 1}`,
          enabled: source.enabled !== false,
          sort_order: index
        }));
        await SupabaseApi.delete(
          TABLE,
          `user_id=eq.${encodeURIComponent(ownerId)}&profile_id=eq.${profileId}`,
          true
        );
        if (rows.length) {
          try {
            await SupabaseApi.upsert(TABLE, rows, "user_id,profile_id,url", true);
          } catch (upsertError) {
            await SupabaseApi.upsert(TABLE, rows, null, true);
          }
        }
      }

      // Also push repository URLs (fail silently if backend unsupported)
      await this.pushRepositories();
      return true;
    } catch (error) {
      console.warn("Plugin sync push failed", error);
      return false;
    }
  },

  // ── Repository sync ──────────────────────────────────────────────────

  async pushRepositories() {
    try {
      if (!AuthManager.isAuthenticated) {
        return;
      }
      const repos = PluginDataStore.getRepositories();
      if (!repos.length) {
        return;
      }
      const profileId = await resolvePluginProfileId();

      // Collect per-scraper enabled states for this device
      const scrapers = PluginDataStore.getScrapers();
      const scraperStates = {};
      for (const s of scrapers) {
        scraperStates[s.id] = s.enabled;
      }

      try {
        await SupabaseApi.rpc(REPO_PUSH_RPC, {
          p_profile_id: profileId,
          p_repositories: repos.map((repo, index) => ({
            url: repo.url,
            name: repo.name || "",
            sort_order: index
          })),
          p_scraper_states: scraperStates
        }, true);
      } catch (rpcError) {
        if (!shouldTryLegacyTable(rpcError)) {
          // Backend doesn't support repo sync yet — silently skip
          return;
        }
      }
    } catch (error) {
      // Repo sync is best-effort — never block the main push
      console.warn("Plugin repository sync push failed", error);
    }
  },

  async pullRepositories() {
    try {
      if (!AuthManager.isAuthenticated) {
        return;
      }
      const profileId = await resolvePluginProfileId();
      const ownerId = await AuthManager.getEffectiveUserId();

      let rows;
      try {
        rows = await SupabaseApi.select(
          REPO_TABLE,
          `user_id=eq.${encodeURIComponent(ownerId)}&profile_id=eq.${profileId}&select=url,name,scraper_states&order=sort_order.asc`,
          true
        );
      } catch (selectError) {
        if (shouldTryLegacyTable(selectError)) {
          // Backend doesn't support repo sync yet
          return;
        }
        throw selectError;
      }

      if (!Array.isArray(rows) || !rows.length) {
        return;
      }

      const localRepos = PluginDataStore.getRepositories();
      const localUrls = new Set(localRepos.map((r) => r.url));

      for (const row of rows) {
        const url = String(row.url || "").trim().replace(/\/+$/, "");
        if (!url) continue;

        if (!localUrls.has(url)) {
          // New repo from another device — install it
          try {
            await PluginRuntime.addRepository(url);
          } catch (err) {
            console.warn("Failed to add synced repository:", url, err.message || err);
          }
        }

        // Apply synced scraper enabled states if present
        if (row.scraper_states && typeof row.scraper_states === "object") {
          for (const [scraperId, enabled] of Object.entries(row.scraper_states)) {
            PluginDataStore.setScraperEnabled(scraperId, Boolean(enabled));
          }
        }
      }
    } catch (error) {
      console.warn("Plugin repository sync pull failed", error);
    }
  }

};
