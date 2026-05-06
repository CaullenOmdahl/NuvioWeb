import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { addonRepository } from "../../../data/repository/addonRepository.js";
import { LayoutPreferences } from "../../../data/local/layoutPreferences.js";
import { HomeCatalogStore } from "../../../data/local/homeCatalogStore.js";
import { Platform } from "../../../platform/index.js";
import { I18n } from "../../../i18n/index.js";
import { PluginManager } from "../../../core/player/pluginManager.js";
import { AuthManager } from "../../../core/auth/authManager.js";
import { LibrarySyncService } from "../../../core/profile/librarySyncService.js";
import { buildOrderedCatalogItems } from "../../../core/addons/homeCatalogs.js";
import { normalizeAddonInstallUrl } from "../../../core/addons/addonUrl.js";
import {
  activateLegacySidebarAction,
  bindRootSidebarEvents,
  getLegacySidebarNodes,
  getLegacySidebarSelectedNode,
  getModernSidebarNodes,
  getModernSidebarSelectedNode,
  getSidebarProfileState,
  isSelectedSidebarAction,
  isRootSidebarNode,
  renderRootSidebar,
  setModernSidebarExpanded,
  setModernSidebarPillIconOnly,
  setLegacySidebarExpanded
} from "../../components/sidebarNavigation.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function t(key, fallback = key) {
  return I18n.t(key, {}, { fallback });
}

function formatResourceSummary(addon) {
  const resources = Array.isArray(addon?.resources) ? addon.resources : [];
  const names = Array.from(new Set(resources.map((resource) => String(resource?.name || "").trim()).filter(Boolean)));
  if (!names.length) {
    return "No resources declared";
  }
  return names.join(", ");
}

function formatCatalogSummary(addon) {
  const count = Array.isArray(addon?.catalogs) ? addon.catalogs.length : 0;
  return `${count} catalog${count === 1 ? "" : "s"}`;
}

function formatAddonTypes(addon) {
  const types = Array.isArray(addon?.types) ? addon.types : [];
  const cleaned = types.map((type) => String(type || "").trim()).filter(Boolean);
  return cleaned.length ? cleaned.join(", ") : "No media types declared";
}

export const PluginScreen = {

  async mount() {
    this.container = document.getElementById("plugin");
    ScreenUtils.show(this.container);
    this.pluginRouteEnterPending = true;
    this.layoutPrefs = LayoutPreferences.get();
    this.focusZone = "content";
    this.sidebarFocusIndex = Number.isFinite(this.sidebarFocusIndex) ? this.sidebarFocusIndex : 0;
    this.sidebarExpanded = false;
    this.pillIconOnly = false;
    this.contentRow = Number.isFinite(this.contentRow) ? this.contentRow : 0;
    this.contentCol = Number.isFinite(this.contentCol) ? this.contentCol : 0;
    this.installDraft = this.installDraft || "";
    this.installError = "";
    this.operationMessage = "";
    this.operationIsError = false;
    this.expandedRepoId = this.expandedRepoId || null;
    const [sidebarProfile, model] = await Promise.all([
      getSidebarProfileState(),
      this.collectModel()
    ]);
    this.sidebarProfile = sidebarProfile;
    this.model = model;
    await this.render({ refreshModel: false });
  },

  async collectModel() {
    const repositories = PluginManager.listRepositories();
    const scrapers = PluginManager.listScrapers();
    const [addons, catalogPrefs] = await Promise.all([
      addonRepository.getInstalledAddons(),
      Promise.resolve(HomeCatalogStore.get())
    ]);
    const catalogItems = buildOrderedCatalogItems(addons, catalogPrefs.order, catalogPrefs.disabled);
    const addonUrls = addonRepository.getInstalledAddonUrls();
    return {
      addonUrls,
      addonCount: addonUrls.length,
      addons,
      catalogCount: catalogItems.length,
      repositories,
      scrapers
    };
  },

  setRowColumns(row, cols) {
    this.rowColumns.set(row, cols);
  },

  getAvailableRows() {
    return [...this.rowColumns.keys()].sort((left, right) => left - right);
  },

  getAvailableCols(row) {
    return this.rowColumns.get(row) || [0];
  },

  normalizeFocus() {
    const rows = this.getAvailableRows();
    this.contentRow = rows.includes(this.contentRow) ? this.contentRow : (rows[0] || 0);
    const cols = this.getAvailableCols(this.contentRow);
    this.contentCol = cols.includes(this.contentCol) ? this.contentCol : cols[0];
    const sidebarNodes = this.layoutPrefs?.modernSidebar ? getModernSidebarNodes(this.container) : getLegacySidebarNodes(this.container);
    this.sidebarFocusIndex = clamp(this.sidebarFocusIndex, 0, Math.max(0, sidebarNodes.length - 1));
  },

  ensureMainVisibility(target) {
    const container = this.container?.querySelector(".addons-main");
    if (!container || !target) {
      return;
    }
    const anchor = target.closest(".addons-installed-card, .addons-large-row, .addons-install-card") || target;
    const pad = 56;
    const containerRect = container.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const anchorTop = anchorRect.top - containerRect.top + container.scrollTop;
    const anchorBottom = anchorRect.bottom - containerRect.top + container.scrollTop;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;

    if (anchorBottom > viewBottom - pad) {
      container.scrollTop = Math.min(
        container.scrollHeight - container.clientHeight,
        Math.max(0, anchorBottom - container.clientHeight + pad)
      );
    } else if (anchorTop < viewTop + pad) {
      container.scrollTop = Math.max(0, anchorTop - pad);
    }
  },

  async syncAddonChanges() {
    if (!AuthManager.isAuthenticated) {
      return;
    }
    try {
      await LibrarySyncService.push();
    } catch (error) {
      console.warn("Addon sync push after local change failed", error);
    }
  },

  setOperationMessage(message, isError = false) {
    this.operationMessage = String(message || "");
    this.operationIsError = Boolean(isError);
  },

  async installAddonFromInput() {
    const clean = normalizeAddonInstallUrl(this.installDraft);
    if (!clean) {
      this.installError = "Enter a valid http, https, or stremio addon URL.";
      this.setOperationMessage("", false);
      await this.render({ refreshModel: false });
      return;
    }

    const installed = this.model?.addonUrls || addonRepository.getInstalledAddonUrls();
    if (installed.includes(clean)) {
      this.installError = "That addon is already installed.";
      this.setOperationMessage("", false);
      await this.render({ refreshModel: false });
      return;
    }

    this.installError = "";
    this.setOperationMessage("Checking addon manifest...", false);
    await this.render({ refreshModel: false });

    const result = await addonRepository.fetchAddon(clean);
    if (result.status !== "success") {
      this.installError = result.message || "Unable to load that addon manifest.";
      this.setOperationMessage("", false);
      await this.render({ refreshModel: false });
      return;
    }

    const added = await addonRepository.addAddon(clean);
    if (added === false) {
      this.installError = "That addon is already installed.";
      this.setOperationMessage("", false);
      await this.render({ refreshModel: false });
      return;
    }

    await this.syncAddonChanges();
    this.installDraft = "";
    this.installError = "";
    this.setOperationMessage(`${result.data?.displayName || result.data?.name || "Addon"} installed.`, false);
    await this.render();
  },

  async refreshAddon(index) {
    const addon = this.model?.addons?.[index] || null;
    if (!addon) {
      return;
    }
    const result = await addonRepository.refreshAddon(addon.baseUrl);
    if (result.status === "success") {
      this.setOperationMessage(`${result.data?.displayName || addon.displayName || addon.name || "Addon"} refreshed.`, false);
      await this.render();
      return;
    }
    this.setOperationMessage(result.message || "Unable to refresh addon.", true);
    await this.render({ refreshModel: false });
  },

  async removeAddon(index) {
    const addon = this.model?.addons?.[index] || null;
    if (!addon) {
      return;
    }
    const removed = await addonRepository.removeAddon(addon.baseUrl);
    if (removed) {
      await this.syncAddonChanges();
      this.contentRow = Math.max(0, this.contentRow - 1);
      this.setOperationMessage(`${addon.displayName || addon.name || "Addon"} removed.`, false);
      await this.render();
      return;
    }
    this.setOperationMessage("Unable to remove addon.", true);
    await this.render({ refreshModel: false });
  },

  async moveAddon(index, delta) {
    const addons = this.model?.addons || [];
    const addon = addons[index] || null;
    if (!addon) {
      return;
    }

    const urls = this.model?.addonUrls || addonRepository.getInstalledAddonUrls();
    const sourceIndex = urls.indexOf(addon.baseUrl);
    const nextIndex = sourceIndex + delta;
    if (sourceIndex < 0 || nextIndex < 0 || nextIndex >= urls.length) {
      return;
    }

    const next = [...urls];
    const moved = next.splice(sourceIndex, 1)[0];
    next.splice(nextIndex, 0, moved);
    await addonRepository.setAddonOrder(next);
    await this.syncAddonChanges();
    this.contentRow = Math.max(0, this.contentRow + delta);
    this.setOperationMessage(`${addon.displayName || addon.name || "Addon"} reordered.`, false);
    await this.render();
  },

  bindContentEvents() {
    const installInput = this.container.querySelector(".addons-install-input");
    if (installInput) {
      installInput.addEventListener("input", (event) => {
        this.installDraft = String(event.target?.value || "");
        if (this.installError) {
          this.installError = "";
        }
      });
      installInput.addEventListener("keydown", async (event) => {
        if (event.key === "Enter" || Number(event.keyCode || 0) === 13) {
          event.preventDefault();
          event.stopPropagation();
          this.installDraft = String(installInput.value || "");
          await this.installAddonFromInput();
        }
      });
    }

    this.container.querySelectorAll(".addons-focusable[data-action-id]").forEach((node) => {
      node.addEventListener("click", async () => {
        this.focusZone = "content";
        this.contentRow = Number(node.dataset.row || 0);
        this.contentCol = Number(node.dataset.col || 0);
        this.applyFocus();
        await this.activateFocused();
      });
    });
  },

  buildAddonRows(startRow) {
    const addons = this.model?.addons || [];
    if (!addons.length) {
      return {
        html: '<div class="addons-empty">No addons installed. Paste an addon manifest URL above to install one.</div>',
        nextRow: startRow
      };
    }

    let currentRow = startRow;
    const html = addons.map((addon, index) => {
      const row = currentRow++;
      const refreshAction = `addon_refresh_${index}`;
      const moveUpAction = `addon_move_up_${index}`;
      const moveDownAction = `addon_move_down_${index}`;
      const removeAction = `addon_remove_${index}`;
      const canMoveUp = index > 0;
      const canMoveDown = index < addons.length - 1;
      const cols = [0];
      if (canMoveUp) cols.push(1);
      if (canMoveDown) cols.push(2);
      cols.push(3);
      this.setRowColumns(row, cols);

      this.actionMap.set(refreshAction, () => this.refreshAddon(index));
      this.actionMap.set(moveUpAction, () => this.moveAddon(index, -1));
      this.actionMap.set(moveDownAction, () => this.moveAddon(index, 1));
      this.actionMap.set(removeAction, () => this.removeAddon(index));

      return `
        <article class="addons-installed-card">
          <div class="addons-installed-head">
            <div class="addons-installed-copy">
              <h3>${escapeHtml(addon.displayName || addon.name || addon.baseUrl)}</h3>
              <p class="addons-installed-version">${escapeHtml(`v${addon.version || "0.0.0"}`)}</p>
            </div>
            <div class="addons-installed-actions">
              <button type="button"
                      class="addons-action-btn addons-focusable"
                      data-zone="content"
                      data-row="${row}"
                      data-col="0"
                      data-action-id="${escapeHtml(refreshAction)}"
                      tabindex="-1"
                      aria-label="Refresh ${escapeHtml(addon.displayName || addon.name || "addon")}">
                <span class="material-icons" aria-hidden="true">refresh</span>
              </button>
              <button type="button"
                      class="addons-action-btn${canMoveUp ? " addons-focusable" : " is-disabled"}"
                      ${canMoveUp ? `data-zone="content" data-row="${row}" data-col="1" data-action-id="${escapeHtml(moveUpAction)}"` : 'aria-disabled="true"'}
                      tabindex="-1"
                      aria-label="Move ${escapeHtml(addon.displayName || addon.name || "addon")} up">
                <span class="material-icons" aria-hidden="true">arrow_upward</span>
              </button>
              <button type="button"
                      class="addons-action-btn${canMoveDown ? " addons-focusable" : " is-disabled"}"
                      ${canMoveDown ? `data-zone="content" data-row="${row}" data-col="2" data-action-id="${escapeHtml(moveDownAction)}"` : 'aria-disabled="true"'}
                      tabindex="-1"
                      aria-label="Move ${escapeHtml(addon.displayName || addon.name || "addon")} down">
                <span class="material-icons" aria-hidden="true">arrow_downward</span>
              </button>
              <button type="button"
                      class="addons-action-btn addons-remove-btn addons-focusable"
                      data-zone="content"
                      data-row="${row}"
                      data-col="3"
                      data-action-id="${escapeHtml(removeAction)}"
                      tabindex="-1">
                Remove
              </button>
            </div>
          </div>
          ${addon.description ? `<p class="addons-installed-description">${escapeHtml(addon.description)}</p>` : ""}
          <p class="addons-installed-meta">${escapeHtml(addon.baseUrl)}</p>
          <p class="addons-installed-meta">${escapeHtml(`${formatCatalogSummary(addon)} - ${formatResourceSummary(addon)} - ${formatAddonTypes(addon)}`)}</p>
        </article>
      `;
    }).join("");

    return { html, nextRow: currentRow };
  },

  buildRepositoryRows(startRow) {
    const repos = this.model.repositories || [];
    const scrapers = this.model.scrapers || [];
    let html = "";
    let currentRow = startRow;

    for (const repo of repos) {
      const repoScrapers = scrapers.filter((s) => s.repositoryId === repo.id);
      const scraperCount = repoScrapers.length;
      const repoRow = currentRow;

      this.setRowColumns(repoRow, [0, 1, 2]);

      this.actionMap.set(`repo_refresh_${repo.id}`, async () => {
        try {
          await PluginManager.refreshRepository(repo.id);
          this.setOperationMessage(`${repo.name || repo.url} refreshed.`, false);
        } catch (err) {
          this.setOperationMessage("Failed to refresh repository.", true);
          console.warn("Failed to refresh repository:", err);
        }
        await this.render();
      });

      this.actionMap.set(`repo_scrapers_${repo.id}`, async () => {
        this.expandedRepoId = this.expandedRepoId === repo.id ? null : repo.id;
        await this.render({ refreshModel: false });
      });

      this.actionMap.set(`repo_remove_${repo.id}`, async () => {
        try {
          PluginManager.removeRepository(repo.id);
          this.setOperationMessage(`${repo.name || repo.url} removed.`, false);
        } catch (err) {
          this.setOperationMessage("Failed to remove repository.", true);
          console.warn("Failed to remove repository:", err);
        }
        if (this.expandedRepoId === repo.id) {
          this.expandedRepoId = null;
        }
        await this.render();
      });

      const isExpanded = this.expandedRepoId === repo.id;

      html += `
        <div class="addons-large-row" style="display: flex; align-items: center; gap: 8px;">
          <span class="addons-large-row-icon material-icons" aria-hidden="true">extension</span>
          <span class="addons-large-row-copy" style="flex: 1; min-width: 0;">
            <strong>${escapeHtml(repo.name || repo.url)}</strong>
            <small>${escapeHtml(scraperCount + " scraper" + (scraperCount === 1 ? "" : "s"))}</small>
          </span>
          <button type="button"
                  class="addons-large-row addons-focusable"
                  data-zone="content"
                  data-row="${repoRow}"
                  data-col="0"
                  data-action-id="repo_refresh_${escapeHtml(repo.id)}"
                  tabindex="-1"
                  style="flex: 0 0 auto; min-width: auto;">
            <span class="addons-large-row-icon material-icons" aria-hidden="true">refresh</span>
            <span class="addons-large-row-copy"><strong>Refresh</strong></span>
          </button>
          <button type="button"
                  class="addons-large-row addons-focusable"
                  data-zone="content"
                  data-row="${repoRow}"
                  data-col="1"
                  data-action-id="repo_scrapers_${escapeHtml(repo.id)}"
                  tabindex="-1"
                  style="flex: 0 0 auto; min-width: auto;">
            <span class="addons-large-row-icon material-icons" aria-hidden="true">${isExpanded ? "expand_less" : "expand_more"}</span>
            <span class="addons-large-row-copy"><strong>Scrapers</strong></span>
          </button>
          <button type="button"
                  class="addons-large-row addons-focusable"
                  data-zone="content"
                  data-row="${repoRow}"
                  data-col="2"
                  data-action-id="repo_remove_${escapeHtml(repo.id)}"
                  tabindex="-1"
                  style="flex: 0 0 auto; min-width: auto;">
            <span class="addons-large-row-icon material-icons" aria-hidden="true">delete</span>
            <span class="addons-large-row-copy"><strong>Remove</strong></span>
          </button>
        </div>
      `;

      currentRow++;

      if (isExpanded) {
        for (const scraper of repoScrapers) {
          const scraperRow = currentRow;
          this.setRowColumns(scraperRow, [0]);

          this.actionMap.set(`scraper_toggle_${scraper.id}`, async () => {
            try {
              PluginManager.setScraperEnabled(scraper.id, !scraper.enabled);
              this.setOperationMessage(`${scraper.name || scraper.id} ${scraper.enabled ? "disabled" : "enabled"}.`, false);
            } catch (err) {
              this.setOperationMessage("Failed to toggle scraper.", true);
              console.warn("Failed to toggle scraper:", err);
            }
            await this.render();
          });

          html += `
            <button type="button"
                    class="addons-large-row addons-focusable"
                    data-zone="content"
                    data-row="${scraperRow}"
                    data-col="0"
                    data-action-id="scraper_toggle_${escapeHtml(scraper.id)}"
                    tabindex="-1"
                    style="padding-left: 48px;">
              <span class="addons-large-row-icon material-icons" aria-hidden="true">${scraper.enabled ? "toggle_on" : "toggle_off"}</span>
              <span class="addons-large-row-copy">
                <strong>${escapeHtml(scraper.name || scraper.id)}</strong>
                <small>${escapeHtml(scraper.version || "")}</small>
              </span>
              <span class="addons-large-row-tail-group">
                <span class="addons-large-row-badge">${escapeHtml(scraper.enabled ? "Enabled" : "Disabled")}</span>
              </span>
            </button>
          `;

          currentRow++;
        }
      }
    }

    return { html, nextRow: currentRow };
  },

  async render({ refreshModel = true } = {}) {
    if (refreshModel || !this.model) {
      this.model = await this.collectModel();
    }
    this.rowColumns = new Map();
    this.actionMap = new Map();
    this.setRowColumns(0, [0, 1]);
    this.setRowColumns(1, [0]);

    this.actionMap.set("install_input", async () => {
      const input = this.container.querySelector(".addons-install-input");
      input?.focus();
      input?.select?.();
    });
    this.actionMap.set("install_addon", async () => {
      const input = this.container.querySelector(".addons-install-input");
      this.installDraft = String(input?.value || this.installDraft || "");
      await this.installAddonFromInput();
    });
    this.actionMap.set("open_catalog_order", async () => {
      Router.navigate("catalogOrder");
    });
    this.actionMap.set("add_repository", async () => {
      const url = prompt("Enter plugin repository URL:");
      if (!url || !url.trim()) {
        return;
      }
      try {
        await PluginManager.addRepository(url.trim());
        this.setOperationMessage("Plugin repository added.", false);
      } catch (err) {
        this.setOperationMessage("Failed to add plugin repository.", true);
        console.warn("Failed to add repository:", err);
      }
      await this.render();
    });

    const addonRows = this.buildAddonRows(2);
    this.setRowColumns(addonRows.nextRow, [0]);
    const repositoryRows = this.buildRepositoryRows(addonRows.nextRow + 1);
    const addonCountLabel = `${this.model.addonCount} addon${this.model.addonCount === 1 ? "" : "s"} installed`;
    const catalogCountLabel = `${this.model.catalogCount} home catalog${this.model.catalogCount === 1 ? "" : "s"} available`;

    this.container.innerHTML = `
      <div class="home-shell addons-shell${this.pluginRouteEnterPending ? " addons-route-enter" : ""}">
        ${renderRootSidebar({
          selectedRoute: "plugin",
          profile: this.sidebarProfile,
          layout: this.layoutPrefs,
          expanded: Boolean(this.sidebarExpanded),
          pillIconOnly: Boolean(this.pillIconOnly)
        })}
        <main class="home-main addons-main">
          <div class="addons-panel">
            <section class="addons-hero-card">
              <p class="addons-kicker">Standalone management</p>
              <h1 class="addons-title">Addons</h1>
              <p class="addons-lede">
                Install and organize Stremio-compatible addons directly in this app.
              </p>
              <p class="addons-meta">${escapeHtml(`${addonCountLabel} - ${catalogCountLabel}`)}</p>
              ${this.operationMessage ? `<p class="${this.operationIsError ? "addons-install-error" : "addons-meta"}">${escapeHtml(this.operationMessage)}</p>` : ""}
            </section>

            <section class="addons-install-card">
              <h2 class="addons-install-heading">Install Addon</h2>
              <div class="addons-install-row">
                <label class="addons-install-surface addons-focusable"
                       data-zone="content"
                       data-row="0"
                       data-col="0"
                       data-action-id="install_input">
                  <input class="addons-install-input"
                         type="url"
                         value="${escapeHtml(this.installDraft)}"
                         placeholder="https://example.com/manifest.json"
                         autocomplete="off"
                         spellcheck="false" />
                </label>
                <button type="button"
                        class="addons-install-btn addons-focusable"
                        data-zone="content"
                        data-row="0"
                        data-col="1"
                        data-action-id="install_addon"
                        tabindex="-1">Add</button>
              </div>
              <div class="addons-install-error">${escapeHtml(this.installError)}</div>
            </section>

            <section>
              <button type="button"
                      class="addons-large-row addons-focusable"
                      data-zone="content"
                      data-row="1"
                      data-col="0"
                      data-action-id="open_catalog_order"
                      tabindex="-1">
                <span class="addons-large-row-icon material-icons" aria-hidden="true">view_agenda</span>
                <span class="addons-large-row-copy">
                  <strong>Home Catalogs</strong>
                  <small>Reorder catalog rows and enable or disable Home sections</small>
                </span>
                <span class="addons-large-row-tail-group">
                  <span class="addons-large-row-badge">${escapeHtml(String(this.model.catalogCount || 0))}</span>
                  <span class="addons-large-row-tail material-icons" aria-hidden="true">chevron_right</span>
                </span>
              </button>
            </section>

            <section>
              <h2 class="addons-subtitle">Installed Addons</h2>
              <div class="addons-installed-list">
                ${addonRows.html}
              </div>
            </section>

            <section class="addons-repos-section">
              <h2 class="addons-subtitle">Plugin Repositories</h2>
              <button type="button"
                      class="addons-large-row addons-focusable"
                      data-zone="content"
                      data-row="${addonRows.nextRow}"
                      data-col="0"
                      data-action-id="add_repository"
                      tabindex="-1">
                <span class="addons-large-row-icon material-icons" aria-hidden="true">add_circle_outline</span>
                <span class="addons-large-row-copy">
                  <strong>Add Repository</strong>
                  <small>Enter a plugin repository URL for scraper plugins</small>
                </span>
              </button>
              ${repositoryRows.html}
            </section>
          </div>
        </main>
      </div>
    `;
    this.pluginRouteEnterPending = false;

    bindRootSidebarEvents(this.container, {
      currentRoute: "plugin",
      onSelectedAction: () => this.closeSidebarToContent(),
      onExpandSidebar: () => this.openSidebar()
    });
    this.bindContentEvents();
    this.normalizeFocus();
    this.applyFocus();
  },

  applyFocus() {
    this.container.querySelectorAll(".addons-focusable.focused, .focusable.focused").forEach((node) => node.classList.remove("focused"));

    if (this.focusZone === "sidebar") {
      const sidebarNodes = this.layoutPrefs?.modernSidebar ? getModernSidebarNodes(this.container) : getLegacySidebarNodes(this.container);
      const node = sidebarNodes[this.sidebarFocusIndex]
        || (this.layoutPrefs?.modernSidebar ? getModernSidebarSelectedNode(this.container) : getLegacySidebarSelectedNode(this.container));
      if (node) {
        node.classList.add("focused");
        node.focus();
        if (!this.layoutPrefs?.modernSidebar) {
          setLegacySidebarExpanded(this.container, true);
        }
        return;
      }
      this.focusZone = "content";
    }

    if (!this.layoutPrefs?.modernSidebar) {
      setLegacySidebarExpanded(this.container, false);
    }
    const target = this.container.querySelector(
      `.addons-focusable[data-zone="content"][data-row="${this.contentRow}"][data-col="${this.contentCol}"]`
    ) || this.container.querySelector(
      `.addons-focusable[data-zone="content"][data-row="${this.contentRow}"][data-col="0"]`
    ) || this.container.querySelector(".addons-focusable[data-zone='content']");

    if (target) {
      target.classList.add("focused");
      this.ensureMainVisibility(target);
      target.focus();
    }
  },

  moveContent(deltaRow, deltaCol = 0) {
    if (deltaCol !== 0) {
      const cols = this.getAvailableCols(this.contentRow);
      const currentIndex = Math.max(0, cols.indexOf(this.contentCol));
      this.contentCol = cols[clamp(currentIndex + deltaCol, 0, cols.length - 1)];
      this.applyFocus();
      return;
    }

    const rows = this.getAvailableRows();
    const currentIndex = Math.max(0, rows.indexOf(this.contentRow));
    this.contentRow = rows[clamp(currentIndex + deltaRow, 0, rows.length - 1)] || 0;
    const cols = this.getAvailableCols(this.contentRow);
    this.contentCol = cols.includes(this.contentCol) ? this.contentCol : cols[0];
    this.applyFocus();
  },

  moveSidebar(delta) {
    const sidebarNodes = this.layoutPrefs?.modernSidebar ? getModernSidebarNodes(this.container) : getLegacySidebarNodes(this.container);
    this.sidebarFocusIndex = clamp(this.sidebarFocusIndex + delta, 0, Math.max(0, sidebarNodes.length - 1));
    this.applyFocus();
  },

  async openSidebar() {
    const sidebarNodes = this.layoutPrefs?.modernSidebar ? getModernSidebarNodes(this.container) : getLegacySidebarNodes(this.container);
    const selected = this.layoutPrefs?.modernSidebar ? getModernSidebarSelectedNode(this.container) : getLegacySidebarSelectedNode(this.container);
    this.sidebarFocusIndex = Math.max(0, sidebarNodes.indexOf(selected));
    if (this.layoutPrefs?.modernSidebar && !this.sidebarExpanded) {
      this.sidebarExpanded = true;
      this.focusZone = "sidebar";
      setModernSidebarExpanded(this.container, true);
      this.applyFocus();
      return;
    }
    this.focusZone = "sidebar";
    this.applyFocus();
  },

  async closeSidebarToContent() {
    this.focusZone = "content";
    if (this.layoutPrefs?.modernSidebar && this.sidebarExpanded) {
      this.sidebarExpanded = false;
      setModernSidebarExpanded(this.container, false);
      this.applyFocus();
      return;
    }
    this.applyFocus();
  },

  async activateFocused() {
    const current = this.container.querySelector(".addons-focusable.focused, .focusable.focused");
    if (!current) {
      return;
    }

    if (isRootSidebarNode(current)) {
      activateLegacySidebarAction(String(current.dataset.action || ""), "plugin");
      if (isSelectedSidebarAction(String(current.dataset.action || ""), "plugin")) {
        await this.closeSidebarToContent();
      }
      return;
    }

    const action = this.actionMap.get(String(current.dataset.actionId || ""));
    if (!action) {
      return;
    }
    await action();
    if (Router.getCurrent() === "plugin") {
      this.normalizeFocus();
      this.applyFocus();
    }
  },

  consumeBackRequest() {
    return false;
  },

  async onKeyDown(event) {
    const activeElement = document.activeElement;
    const code = Number(event?.keyCode || 0);
    if (activeElement?.matches?.(".addons-install-input")) {
      if (code === 13) {
        event?.preventDefault?.();
        this.installDraft = String(activeElement.value || "");
        await this.installAddonFromInput();
        return;
      }
      if (![37, 38, 39, 40].includes(code) && !Platform.isBackEvent(event)) {
        return;
      }
    }

    if (Platform.isBackEvent(event)) {
      event?.preventDefault?.();
      if (this.focusZone === "sidebar") {
        Platform.exitApp();
      } else {
        await this.openSidebar();
      }
      return;
    }

    if (this.layoutPrefs?.modernSidebar && !this.sidebarExpanded) {
      if (code === 40) {
        this.pillIconOnly = true;
        setModernSidebarPillIconOnly(this.container, true);
      } else if (code === 38) {
        this.pillIconOnly = false;
        setModernSidebarPillIconOnly(this.container, false);
      }
    }

    if (code === 38 || code === 40 || code === 37 || code === 39) {
      event?.preventDefault?.();
      if (this.focusZone === "sidebar") {
        if (code === 38) this.moveSidebar(-1);
        else if (code === 40) this.moveSidebar(1);
        else if (code === 39) {
          this.focusZone = "content";
          if (this.layoutPrefs?.modernSidebar) {
            this.sidebarExpanded = false;
            setModernSidebarExpanded(this.container, false);
            this.applyFocus();
            return;
          }
          this.applyFocus();
        }
        return;
      }

      if (code === 38) this.moveContent(-1);
      else if (code === 40) this.moveContent(1);
      else if (code === 37) {
        if (this.contentCol > 0) {
          this.moveContent(0, -1);
        } else {
          const nodes = this.layoutPrefs?.modernSidebar ? getModernSidebarNodes(this.container) : getLegacySidebarNodes(this.container);
          const selected = this.layoutPrefs?.modernSidebar ? getModernSidebarSelectedNode(this.container) : getLegacySidebarSelectedNode(this.container);
          this.focusZone = "sidebar";
          this.sidebarFocusIndex = Math.max(0, nodes.indexOf(selected));
          if (this.layoutPrefs?.modernSidebar && !this.sidebarExpanded) {
            this.sidebarExpanded = true;
            setModernSidebarExpanded(this.container, true);
            this.applyFocus();
          } else {
            this.applyFocus();
          }
        }
      } else if (code === 39) {
        this.moveContent(0, 1);
      }
      return;
    }

    if (code === 13) {
      await this.activateFocused();
    }
  },

  cleanup() {
    ScreenUtils.hide(this.container);
  }

};
