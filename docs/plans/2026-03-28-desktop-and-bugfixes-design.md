# Desktop Support + Bug Fixes Design

## 1. Hybrid Mouse Input Support

Add `js/ui/navigation/mouseEngine.js` alongside `focusEngine.js`. On `click`, find closest `.focusable` ancestor, apply `.focused` class, trigger the element's action. On `mouseenter`, set focus without activating. Both input methods coexist — last input method wins. Benefits all platforms (TV users with USB mice too).

Changes: new `mouseEngine.js`, init from `focusEngine.js`. No per-screen changes needed — existing click handlers already work.

## 2. Watched Flag Episodes (#19)

Root cause: `watchedItemsRepository.isWatched()` defaults `allowEpisodeEntries: false`, filtering out episode-level watched entries. `getAll()` works correctly but dynamic updates through `isWatched()` don't reflect episode state.

Fix: pass `{ allowEpisodeEntries: true }` in metaDetailsScreen where episode context is known.

## 3. Stretch/Fit/Fill Display Mode (#46)

Root cause: `aspectModeIndex` in playerScreen.js is a local variable that resets to 0 every time the screen is created. No persistence to `PlayerSettingsStore`.

Fix: add `displayMode` field to `PlayerSettingsStore` defaults, save on cycle, restore on init.

## 4. QR Login on Web (#49)

Root cause: web uses `window.location.origin` as redirect URL which may not match Supabase allowed redirects. Duplicate implementations between `qrLoginService.js` and `authManager.js` with inconsistent error handling.

Fix: improve error messaging, validate redirect URL config, consolidate duplicate code paths.

## 5. Tizen Search Input (#44)

Root cause: Tizen virtual keyboard may not fire standard `input` events reliably. Code only listens to `input` and `keydown`.

Fix: add `change` and `compositionend` event listeners. Add polling fallback that periodically checks `input.value` when on Tizen.

## 6. UI Scaling Setting

Add `uiScale` (default 1.0) to `layoutPreferences.js`. Apply via CSS variable `--ui-scale` through `ThemeManager` using `transform: scale()` on the app container. Settings UI: dropdown with 80%/90%/100%/110%/120% options using existing `openOptionDialog` pattern.

## 7. TV-Specific Issues (#20, #27, #42, #26)

Platform-specific rendering/codec issues. Investigate each, focus fixes on reproducible issues. #42 partially addressed by UI scaling feature.

## 8. REST API for Addon Install (#10)

Feature request. On desktop, Tauri can expose deep link handler for addon URLs. Lower priority.
