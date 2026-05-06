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
  assert.equal(normalizeAddonInstallUrl("https://bad host/manifest.json"), "");
});
