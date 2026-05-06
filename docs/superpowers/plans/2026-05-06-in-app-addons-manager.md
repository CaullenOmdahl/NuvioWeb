# In-App Addons Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build standalone in-app addon management so desktop users can install, refresh, reorder, remove, and manage home catalogs without a phone or QR handoff.

**Architecture:** Reuse the existing `PluginScreen` row/column navigation and `addonRepository` storage contract. Extract addon URL normalization into a shared helper, then wire `PluginScreen` actions to existing repository and sync services while keeping plugin repository controls as a secondary section.

**Tech Stack:** Vanilla ES modules, Node `node:test`, localStorage-backed repositories, existing Tauri/web build.

---

### Task 1: Add Failing Tests

**Files:**
- Create: `tests/addonUrl.test.mjs`
- Create: `tests/addonsManager.test.mjs`

- [x] **Step 1: Write the failing URL normalization test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAddonInstallUrl } from "../js/core/addons/addonUrl.js";

test("normalizes addon base and manifest URLs", () => {
  assert.equal(normalizeAddonInstallUrl(" https://example.com/manifest.json "), "https://example.com");
  assert.equal(normalizeAddonInstallUrl("https://example.com/addon/"), "https://example.com/addon");
});

test("normalizes stremio addon links to https URLs", () => {
  assert.equal(normalizeAddonInstallUrl("stremio://example.com/manifest.json"), "https://example.com");
});

test("rejects unsupported addon install URLs", () => {
  assert.equal(normalizeAddonInstallUrl(""), "");
  assert.equal(normalizeAddonInstallUrl("ftp://example.com/manifest.json"), "");
  assert.equal(normalizeAddonInstallUrl("not a url"), "");
});
```

- [x] **Step 2: Write the failing Addons route source test**

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);

function readRepoFile(path) {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

test("addons route exposes in-app addon management controls", () => {
  const source = readRepoFile("js/ui/screens/plugin/pluginScreen.js");

  assert.match(source, /addons-install-card/);
  assert.match(source, /data-action-id="install_addon"/);
  assert.match(source, /data-action-id="open_catalog_order"/);
  assert.match(source, /addon_refresh_/);
  assert.match(source, /addon_move_up_/);
  assert.match(source, /addon_move_down_/);
  assert.match(source, /addon_remove_/);
});

test("addons route wires addon actions through repositories and sync", () => {
  const source = readRepoFile("js/ui/screens/plugin/pluginScreen.js");

  assert.match(source, /normalizeAddonInstallUrl/);
  assert.match(source, /addonRepository\.fetchAddon/);
  assert.match(source, /addonRepository\.addAddon/);
  assert.match(source, /addonRepository\.refreshAddon/);
  assert.match(source, /addonRepository\.removeAddon/);
  assert.match(source, /addonRepository\.setAddonOrder/);
  assert.match(source, /LibrarySyncService\.push/);
  assert.match(source, /Router\.navigate\("catalogOrder"/);
});

test("addons route does not send desktop users to a phone manager", () => {
  const source = readRepoFile("js/ui/screens/plugin/pluginScreen.js");

  assert.doesNotMatch(source, /manage_from_phone/);
  assert.doesNotMatch(source, /phoneManagerUrl/);
  assert.doesNotMatch(source, /addons-qr-overlay/);
  assert.doesNotMatch(source, /qr_code_2/);
  assert.doesNotMatch(source, /from your phone/i);
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `node --test tests/addonUrl.test.mjs tests/addonsManager.test.mjs`

Expected: FAIL because `js/core/addons/addonUrl.js` does not exist and `PluginScreen` still contains phone-manager code.

### Task 2: Implement URL Normalization

**Files:**
- Create: `js/core/addons/addonUrl.js`
- Modify: `js/data/repository/addonRepository.js`
- Modify: `js/bootstrap/renderAddonRemotePage.js`
- Test: `tests/addonUrl.test.mjs`

- [x] **Step 1: Create the shared helper**

```js
export function normalizeAddonInstallUrl(input) {
  let trimmed = String(input || "").trim();
  if (!trimmed) {
    return "";
  }
  if (/^stremio:\/\//i.test(trimmed)) {
    trimmed = trimmed.replace(/^stremio:\/\//i, "https://");
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return "";
  }
  if (trimmed.endsWith("/manifest.json")) {
    trimmed = trimmed.slice(0, -"/manifest.json".length);
  }
  return trimmed.replace(/\/+$/, "");
}
```

- [x] **Step 2: Use the helper in `addonRepository.canonicalizeUrl()`**

Replace the body with:

```js
const normalized = normalizeAddonInstallUrl(url);
return normalized || String(url || "").trim().replace(/\/+$/, "");
```

- [x] **Step 3: Use the helper in `renderAddonRemotePage.js`**

Import `normalizeAddonInstallUrl` from `../core/addons/addonUrl.js` and remove the duplicate local `normalizeAddonUrl()` function. Update the add flow to call `normalizeAddonInstallUrl(this.addonDraft)`.

- [x] **Step 4: Run URL tests**

Run: `node --test tests/addonUrl.test.mjs`

Expected: PASS.

### Task 3: Refactor Addons Route Into In-App Manager

**Files:**
- Modify: `js/ui/screens/plugin/pluginScreen.js`
- Test: `tests/addonsManager.test.mjs`

- [x] **Step 1: Replace phone imports with addon management imports**

Remove `QrCodeGenerator`, `ADDON_REMOTE_BASE_URL`, and `PUBLIC_APP_URL` imports. Add:

```js
import { AuthManager } from "../../../core/auth/authManager.js";
import { LibrarySyncService } from "../../../core/profile/librarySyncService.js";
import { HomeCatalogStore } from "../../../data/local/homeCatalogStore.js";
import { buildOrderedCatalogItems } from "../../../core/addons/homeCatalogs.js";
import { normalizeAddonInstallUrl } from "../../../core/addons/addonUrl.js";
```

- [x] **Step 2: Remove phone manager helpers and QR overlay state**

Delete `isLoopbackHostname`, `buildPhoneManagerUrl`, `detectLanHost`, `getPhoneManagerUrl`, `renderQrCode`, `openQrOverlay`, `closeQrOverlay`, and QR overlay rendering.

- [x] **Step 3: Collect addon model data**

Make `collectModel()` return addon URLs, addon manifests, catalog item count, repositories, and scrapers:

```js
const [addons, catalogPrefs] = await Promise.all([
  addonRepository.getInstalledAddons(),
  Promise.resolve(HomeCatalogStore.get())
]);
const catalogItems = buildOrderedCatalogItems(addons, catalogPrefs.order, catalogPrefs.disabled);
return {
  addonUrls: addonRepository.getInstalledAddonUrls(),
  addonCount: addons.length,
  addons,
  catalogCount: catalogItems.length,
  repositories,
  scrapers
};
```

- [x] **Step 4: Add addon action methods**

Add methods for `syncAddonChanges()`, `installAddonFromInput()`, `refreshAddon(index)`, `removeAddon(index)`, and `moveAddon(index, delta)`. Each mutating method should update `this.operationMessage` or `this.installError`, call existing `addonRepository` methods, call `LibrarySyncService.push()` when authenticated, and re-render.

- [x] **Step 5: Render in-app controls**

Render:

- `.addons-install-card` with input action `install_input` and button action `install_addon`.
- `.addons-large-row` action `open_catalog_order`.
- `.addons-installed-list` with cards and action IDs `addon_refresh_${index}`, `addon_move_up_${index}`, `addon_move_down_${index}`, `addon_remove_${index}`.
- Existing plugin repository section below installed addons.

- [x] **Step 6: Bind input events**

Attach `input` and `keydown` listeners to the install input. Enter should call `installAddonFromInput()`.

- [x] **Step 7: Run Addons route tests**

Run: `node --test tests/addonsManager.test.mjs`

Expected: PASS.

### Task 4: Verify Existing Behavior

**Files:**
- Test only.

- [x] **Step 1: Run focused test suite**

Run: `node --test tests/addonUrl.test.mjs tests/addonsManager.test.mjs tests/desktopStandalone.test.mjs tests/displayScale.test.mjs tests/authManager.test.mjs tests/mouseNavigation.test.mjs`

Expected: all tests pass.

- [x] **Step 2: Run whitespace audit**

Run: `git diff --check`

Expected: no output and exit 0.

- [x] **Step 3: Build desktop app**

Run: `npm run tauri:build:local`

Expected: build finishes and emits `src-tauri/target/release/bundle/macos/Nuvio TV.app`.

### Task 5: Live Desktop Smoke Test

**Files:**
- No source changes unless smoke test reveals a defect.

- [x] **Step 1: Launch the built app**

Run:

```bash
pkill -f "Nuvio TV.app/Contents/MacOS/nuvio-tv-desktop" || true
open -na "/Users/caullen/Documents/GitHub/NuvioWeb/src-tauri/target/release/bundle/macos/Nuvio TV.app"
```

- [x] **Step 2: Verify Addons in app**

Use Computer Use to open Addons. Confirm:

- No phone/QR manager CTA appears.
- The add URL input appears.
- Installed addons appear with refresh/reorder/remove actions.
- Home Catalogs opens `catalogOrder`.
- `catalogOrder` exposes a clickable desktop Back control.
- The screen remains desktop-sized.

### Task 6: Commit Implementation

**Files:**
- Stage implementation and tests.

- [x] **Step 1: Review diff**

Run: `git diff --stat && git diff --name-only`

- [x] **Step 2: Commit**

Run:

```bash
git add README.md css/components.css js/core/addons/addonUrl.js js/data/repository/addonRepository.js js/bootstrap/renderAddonRemotePage.js js/i18n/index.js js/ui/screens/account/accountSettingsContent.js js/ui/screens/account/authSignInScreen.js js/ui/screens/plugin/catalogOrderScreen.js js/ui/screens/plugin/pluginScreen.js tests/addonUrl.test.mjs tests/addonsManager.test.mjs tests/desktopStandalone.test.mjs tests/mouseNavigation.test.mjs docs/superpowers/plans/2026-05-06-in-app-addons-manager.md
git commit -m "Implement in-app addons manager" -m "Replace the phone-oriented Addons route with standalone addon URL install, installed addon actions, catalog management navigation, and sync-backed addon mutations."
```
