import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);

function readRepoFile(path) {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

function extractCssRule(source, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] || "";
}

test("mouse engine routes desktop clicks through the current screen", () => {
  const source = readRepoFile("js/ui/navigation/mouseEngine.js");

  assert.match(source, /\.focusable,\s*\[data-mouse-action\]/);
  assert.match(source, /Router\.getCurrentScreen\(\)/);
  assert.match(source, /onMouseActivate/);
});

test("nested media screens expose a desktop mouse back control", () => {
  const detailSource = readRepoFile("js/ui/screens/detail/metaDetailsScreen.js");
  const streamSource = readRepoFile("js/ui/screens/stream/streamScreen.js");
  const playerSource = readRepoFile("js/ui/screens/player/playerScreen.js");
  const castSource = readRepoFile("js/ui/screens/cast/castDetailScreen.js");
  const catalogSource = readRepoFile("js/ui/screens/catalog/catalogSeeAllScreen.js");
  const catalogOrderSource = readRepoFile("js/ui/screens/plugin/catalogOrderScreen.js");
  const cssSource = readRepoFile("css/components.css");
  const baseBackRule = extractCssRule(cssSource, ".desktop-route-back");
  const desktopBackRule = extractCssRule(cssSource, ".platform-desktop .desktop-route-back");
  const playerPointerRule = extractCssRule(cssSource, ".platform-desktop .player-controls-overlay");

  assert.match(detailSource, /class="desktop-route-back"/);
  assert.match(streamSource, /class="desktop-route-back"/);
  assert.match(playerSource, /class="desktop-route-back"/);
  assert.match(castSource, /class="desktop-route-back"/);
  assert.match(catalogSource, /class="desktop-route-back"/);
  assert.match(catalogOrderSource, /class="desktop-route-back"/);
  assert.match(detailSource, /data-mouse-action="goBack"/);
  assert.match(streamSource, /data-mouse-action="goBack"/);
  assert.match(playerSource, /data-mouse-action="goBack"/);
  assert.match(castSource, /data-mouse-action="goBack"/);
  assert.match(catalogSource, /data-mouse-action="goBack"/);
  assert.match(catalogOrderSource, /data-mouse-action="goBack"/);
  assert.match(baseBackRule, /display\s*:\s*none/);
  assert.match(desktopBackRule, /display\s*:\s*inline-flex/);
  assert.match(playerPointerRule, /pointer-events\s*:\s*auto/);
});

test("nested media screens opt into mouse activation", () => {
  const detailSource = readRepoFile("js/ui/screens/detail/metaDetailsScreen.js");
  const streamSource = readRepoFile("js/ui/screens/stream/streamScreen.js");
  const playerSource = readRepoFile("js/ui/screens/player/playerScreen.js");
  const castSource = readRepoFile("js/ui/screens/cast/castDetailScreen.js");
  const catalogSource = readRepoFile("js/ui/screens/catalog/catalogSeeAllScreen.js");
  const catalogOrderSource = readRepoFile("js/ui/screens/plugin/catalogOrderScreen.js");

  assert.match(detailSource, /onMouseActivate\(target,\s*event\)/);
  assert.match(streamSource, /onMouseActivate\(target,\s*event\)/);
  assert.match(playerSource, /onMouseActivate\(target,\s*event\)/);
  assert.match(castSource, /onMouseActivate\(target,\s*event\)/);
  assert.match(catalogSource, /onMouseActivate\(target,\s*event\)/);
  assert.match(catalogOrderSource, /onMouseActivate\(target,\s*event\)/);
  assert.match(detailSource, /activateFocusedWithMouse\(event\)/);
  assert.match(streamSource, /activateFocusedWithMouse\(event\)/);
  assert.match(playerSource, /performControlAction/);
  assert.match(castSource, /activateFocusedWithMouse\(event\)/);
  assert.match(catalogSource, /activateFocusedWithMouse\(event\)/);
  assert.match(catalogOrderSource, /activateFocusedWithMouse\(event\)/);
});

test("account and settings screens opt into desktop mouse activation", () => {
  const accountSource = readRepoFile("js/ui/screens/account/accountScreen.js");
  const syncCodeSource = readRepoFile("js/ui/screens/account/syncCodeScreen.js");
  const accountSettingsContentSource = readRepoFile("js/ui/screens/account/accountSettingsContent.js");
  const settingsSource = readRepoFile("js/ui/screens/settings/settingsScreen.js");

  assert.match(accountSource, /onMouseActivate\(target,\s*event\)/);
  assert.match(accountSource, /activateAction\(String\(actionTarget\.dataset\.action/);
  assert.match(accountSource, /Platform\.isDesktop\(\)\s*\?\s*"authSignIn"\s*:\s*"authQrSignIn"/);
  assert.match(syncCodeSource, /onMouseActivate\(target,\s*event\)/);
  assert.match(syncCodeSource, /activateAction\(String\(actionTarget\.dataset\.action/);
  assert.match(accountSettingsContentSource, /addEventListener\("click"/);
  assert.match(settingsSource, /onMouseActivate\(target,\s*event\)/);
  assert.match(settingsSource, /activateFocused\(\)/);
});
