# In-App Addons Manager Design

## Context

The Addons route currently presents addon management as a disabled phone-oriented flow. The lower part of the route exposes plugin repository controls, but the actual Stremio-compatible addon list is only manageable through repository APIs, deep links, sync, or the separate remote addon page.

For the desktop app, addon management must be standalone. Users should not be redirected to a phone, QR flow, or remote manager to add, remove, reorder, or refresh addons.

## Goals

- Manage Stremio-compatible addon URLs directly inside the app.
- Preserve existing addon repository behavior used by Home, Search, Detail, Stream, subtitles, and sync.
- Keep plugin repository management available, but make it secondary to addon management.
- Avoid any Addons route copy or interaction that tells desktop users to continue on a phone.
- Keep keyboard/remote navigation and mouse activation working consistently.

## Non-Goals

- Building an addon marketplace or curated directory.
- Replacing plugin repository scrapers.
- Changing the addon manifest/network protocol.
- Reworking auth or profile sync beyond using the existing push path after addon changes.

## User Experience

The Addons screen becomes a full manager:

- Header: title, brief standalone management copy, and installed addon count.
- Install card: URL input plus an Add button. It accepts addon base URLs and `manifest.json` URLs.
- Installed addons list: one card per addon with name, version, description, base URL, resources, catalog count, and action buttons.
- Addon actions:
  - Refresh manifest.
  - Move up.
  - Move down.
  - Remove.
- Home Catalogs button: navigates to the existing `catalogOrder` route for catalog row ordering and enable/disable.
- Plugin Repositories section: remains below addon management for scraper repositories.

Empty state:

- If no addons are installed, show an in-app prompt to install an addon by URL.
- Default addons should still initialize through `addonRepository.getInstalledAddonUrls()` unless the user removes/reorders them.

Errors:

- Invalid URL: show a clear inline message.
- Duplicate addon: show a clear inline message.
- Manifest fetch failure: show the repository/API message if available, otherwise a concise fallback.
- Remove/refresh failures: keep the user on the screen and show an inline status/error.

## Architecture

### Addon Screen Model

`PluginScreen.collectModel()` should load:

- Installed addon URLs.
- Installed addon manifests through `addonRepository.getInstalledAddons()`.
- Plugin repositories and scrapers through `PluginManager`.
- Home catalog item count through `buildOrderedCatalogItems()`.

The screen should keep local view state for:

- Install input value.
- Install/operation status.
- Focus row/column.
- Expanded repository id.

### Repository Actions

Use existing `addonRepository` methods:

- `addAddon(url)`
- `removeAddon(url)`
- `refreshAddon(url)`
- `setAddonOrder(urls)`
- `getInstalledAddons()`
- `getInstalledAddonUrls()`

For add/refresh, validate the manifest before presenting success. If a user adds a URL already installed, do not mutate storage.

After add/remove/reorder, call `LibrarySyncService.push()` when authenticated so existing addon sync behavior remains the source of truth.

### Navigation and Input

Continue using the Addons route row/column focus pattern:

- Add input row.
- Add button row/column.
- Home Catalogs row.
- Installed addon rows with action columns.
- Plugin repository rows.

Mouse clicks should continue through the existing click binding on `.addons-focusable[data-action-id]`. Text input should focus normally and submit on Enter.

### Phone/QR Removal

Remove Addons route QR overlay rendering, phone manager URL generation, and disabled phone CTA from the desktop Addons screen.

The remote addon page may remain in the codebase for hosted/wrapper compatibility, but the desktop app should not route users to it from the Addons route.

## Testing

Add focused Node tests for the Addons route source:

- The Addons route renders in-app install controls.
- The Addons route does not render phone/QR manager copy or `manage_from_phone`.
- Installed addon actions include refresh, move up, move down, and remove.
- The screen wires add/remove/reorder actions through `addonRepository`.
- The Home Catalogs button navigates to `catalogOrder`.

Run existing verification:

- `node --test tests/displayScale.test.mjs tests/authManager.test.mjs tests/mouseNavigation.test.mjs`
- New Addons route test file.
- `git diff --check`
- `npm run tauri:build:local`

## Rollout

Implement in one feature commit after tests are red/green:

1. Add Addons route tests and verify they fail for the current phone-oriented route.
2. Refactor `PluginScreen` to expose in-app addon controls.
3. Add sync push after addon mutations.
4. Remove phone CTA/QR overlay from the route.
5. Re-run tests, build, and live desktop smoke test.
