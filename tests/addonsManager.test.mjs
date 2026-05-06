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
