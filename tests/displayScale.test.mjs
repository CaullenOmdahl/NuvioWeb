import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  calculateDesktopDisplayScalePercent,
  combineDisplayScalePercent,
  normalizeUiScalePercent
} from "../js/platform/displayScale.js";
import { desktopAdapter } from "../js/platform/adapters/desktopAdapter.js";

const repoRoot = new URL("../", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);

function readRepoFile(path) {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

function listRepoFiles(dir, extensions) {
  const entries = readdirSync(new URL(`${dir}/`, repoRoot), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return listRepoFiles(entryPath, extensions);
    }
    return extensions.has(extname(entry.name)) ? [entryPath] : [];
  });
}

function findMatches(path, pattern) {
  const source = readRepoFile(path);
  return Array.from(source.matchAll(pattern), (match) => ({
    path,
    line: source.slice(0, match.index).split("\n").length,
    value: match[0]
  }));
}

function extractCssRule(source, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] || "";
}

function extractCssRules(source, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(
    source.matchAll(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`, "g")),
    (match) => match[1]
  );
}

function readCssPx(rule, property) {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = rule.match(new RegExp(`${escapedProperty}\\s*:\\s*([0-9.]+)px`));
  return match ? Number(match[1]) : NaN;
}

test("desktop display scale shrinks the TV layout for the default desktop window", () => {
  assert.equal(calculateDesktopDisplayScalePercent({ width: 1280, height: 800 }), 80);
});

test("desktop display scale keeps large desktop windows at native scale", () => {
  assert.equal(calculateDesktopDisplayScalePercent({ width: 1920, height: 1080 }), 100);
  assert.equal(calculateDesktopDisplayScalePercent({ width: 2560, height: 1440 }), 100);
});

test("desktop display scale never drops below a readable floor", () => {
  assert.equal(calculateDesktopDisplayScalePercent({ width: 900, height: 560 }), 75);
});

test("desktop display scale falls back to native scale when viewport data is missing", () => {
  assert.equal(calculateDesktopDisplayScalePercent({ width: 0, height: 800 }), 100);
  assert.equal(calculateDesktopDisplayScalePercent({ width: 1280, height: 0 }), 100);
});

test("UI scale normalization clamps settings values to the supported range", () => {
  assert.equal(normalizeUiScalePercent(40), 75);
  assert.equal(normalizeUiScalePercent(117.4), 117);
  assert.equal(normalizeUiScalePercent(190), 150);
  assert.equal(normalizeUiScalePercent("not a number"), 100);
});

test("effective display scale combines platform DPI scale with user preference", () => {
  assert.equal(combineDisplayScalePercent({ platformScalePercent: 80, userScalePercent: 100 }), 80);
  assert.equal(combineDisplayScalePercent({ platformScalePercent: 80, userScalePercent: 125 }), 100);
  assert.equal(combineDisplayScalePercent({ platformScalePercent: 200, userScalePercent: 75 }), 150);
});

test("desktop native zoom is initialized before the web route paints", () => {
  const source = readRepoFile("src-tauri/src/main.rs");

  assert.match(source, /fn apply_desktop_display_zoom\(/);
  assert.match(source, /\.setup\(\|app\|[\s\S]*apply_desktop_display_zoom\(&webview,\s*100\.0\)/);
});

test("desktop native zoom exposes compact density to CSS", async () => {
  const previousDocument = globalThis.document;
  const previousTauriInternals = globalThis.__TAURI_INTERNALS__;
  const classNames = new Set(["platform-desktop"]);
  const styleProperties = new Map();

  globalThis.document = {
    documentElement: {
      dataset: {},
      classList: {
        add(value) {
          classNames.add(value);
        },
        toggle(value, enabled) {
          if (enabled) {
            classNames.add(value);
          } else {
            classNames.delete(value);
          }
        }
      },
      style: {
        setProperty(property, value) {
          styleProperties.set(property, value);
        }
      }
    }
  };
  globalThis.__TAURI_INTERNALS__ = {
    invoke() {
      return Promise.resolve({ platform_scale_percent: 75, effective_scale_percent: 75 });
    }
  };

  try {
    assert.equal(desktopAdapter.applyDisplayScalePercent(100, { userScalePercent: 100 }), true);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(globalThis.document.documentElement.dataset.displayScale, "75");
    assert.equal(styleProperties.get("--nuvio-display-scale"), "0.75");
    assert.equal(classNames.has("desktop-display-compact"), true);
  } finally {
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
    if (previousTauriInternals === undefined) {
      delete globalThis.__TAURI_INTERNALS__;
    } else {
      globalThis.__TAURI_INTERNALS__ = previousTauriInternals;
    }
  }
});

test("web app applies display scale before routes are initialized", () => {
  const source = readRepoFile("js/app.js");
  const bootstrapIndex = source.indexOf("async function bootstrapApp()");
  const scaleApplyIndex = source.indexOf("ThemeManager.apply();", bootstrapIndex);
  const routeInitIndex = source.indexOf("Router.init();", bootstrapIndex);

  assert.ok(bootstrapIndex >= 0, "bootstrapApp() should exist");
  assert.ok(scaleApplyIndex >= 0, "ThemeManager.apply() should exist in bootstrap");
  assert.ok(routeInitIndex >= 0, "Router.init() should exist in bootstrap");
  assert.ok(
    scaleApplyIndex < routeInitIndex,
    "Theme/user display scale should be applied before any route can render"
  );
});

test("route code cannot take ownership of app display zoom", () => {
  const jsFiles = listRepoFiles("js", new Set([".js", ".mjs"]));
  const cssFiles = listRepoFiles("css", new Set([".css"]));
  const matches = [
    ...jsFiles.flatMap((path) => findMatches(path, /\.style\.zoom|setProperty\(\s*["']zoom["']/g)),
    ...cssFiles.flatMap((path) => findMatches(path, /^\s*zoom\s*:/gm))
  ];
  const offenders = matches
    .filter((match) => match.path !== "js/ui/theme/themeManager.js")
    .map((match) => `${relative(repoRootPath, fileURLToPath(new URL(match.path, repoRoot)))}:${match.line}`);

  assert.deepEqual(offenders, []);
});

test("desktop stream chooser uses compact selection controls", () => {
  const source = readRepoFile("css/components.css");
  const desktopCardRule = extractCssRule(source, ".platform-desktop .series-stream-card");
  const desktopTitleRule = extractCssRule(source, ".platform-desktop .series-stream-title");
  const desktopFilterRule = extractCssRule(source, ".platform-desktop .series-stream-filter");
  const desktopTagRule = extractCssRule(source, ".platform-desktop .series-stream-tag");

  assert.ok(desktopCardRule.includes("padding:"), "desktop stream cards should override TV padding");
  assert.ok(readCssPx(desktopTitleRule, "font-size") <= 16, "desktop stream titles should be compact");
  assert.ok(readCssPx(desktopFilterRule, "height") <= 38, "desktop filter pills should be compact");
  assert.ok(readCssPx(desktopTagRule, "height") <= 20, "desktop stream tags should be compact");
  assert.equal(
    [
      ...extractCssRules(source, ".platform-desktop .series-stream-left"),
      ...extractCssRules(source, ".platform-desktop.desktop-display-compact .series-stream-left")
    ].some((rule) => /display\s*:\s*none/.test(rule)),
    false,
    "desktop compact stream chooser should keep the artwork column"
  );
});

test("desktop stream route uses compact selection controls", () => {
  const source = readRepoFile("css/components.css");
  const desktopCardRule = extractCssRule(source, ".platform-desktop .stream-route-card");
  const desktopHeadingRule = extractCssRule(source, ".platform-desktop .stream-route-card-heading");
  const desktopChipRule = extractCssRule(source, ".platform-desktop .stream-route-chip");
  const desktopBadgeRule = extractCssRule(source, ".platform-desktop .stream-route-addon-badge");

  assert.ok(readCssPx(desktopCardRule, "min-height") <= 118, "desktop stream route cards should be compact");
  assert.ok(readCssPx(desktopHeadingRule, "font-size") <= 16, "desktop stream route headings should be compact");
  assert.ok(readCssPx(desktopChipRule, "min-height") <= 38, "desktop stream route filters should be compact");
  assert.ok(readCssPx(desktopBadgeRule, "width") <= 42, "desktop addon badges should be compact");
  assert.equal(
    [
      ...extractCssRules(source, ".platform-desktop .stream-route-left"),
      ...extractCssRules(source, ".platform-desktop.desktop-display-compact .stream-route-left")
    ].some((rule) => /display\s*:\s*none/.test(rule)),
    false,
    "desktop compact stream route should keep the artwork column"
  );
});

test("desktop compact density shrinks search controls", () => {
  const source = readRepoFile("css/components.css");
  const discoverRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .search-discover-btn");
  const voiceRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .search-voice-btn");
  const inputRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .search-input-field");
  const iconRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .search-action-icon");

  assert.ok(readCssPx(discoverRule, "height") <= 76, "desktop search discover button should not use TV height");
  assert.ok(readCssPx(voiceRule, "height") <= 76, "desktop search voice button should not use TV height");
  assert.ok(readCssPx(inputRule, "height") <= 76, "desktop search input should not use TV height");
  assert.ok(readCssPx(inputRule, "font-size") <= 24, "desktop search input text should be compact");
  assert.ok(readCssPx(iconRule, "font-size") <= 36, "desktop search icon should be compact");
});

test("desktop compact density shrinks QR pairing fallback", () => {
  const source = readRepoFile("css/components.css");
  const layoutRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .qr-layout");
  const titleRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .qr-title");
  const cardRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .qr-card");
  const frameRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .qr-code-frame");
  const actionRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .qr-action-btn");

  assert.ok(layoutRule.includes("padding:"), "desktop QR fallback should override TV page padding");
  assert.ok(readCssPx(titleRule, "font-size") <= 42, "desktop QR title should be compact");
  assert.ok(readCssPx(cardRule, "padding") <= 34, "desktop QR card should not use TV padding");
  assert.ok(readCssPx(frameRule, "width") <= 280, "desktop QR code should not use TV size");
  assert.ok(readCssPx(actionRule, "height") <= 58, "desktop QR actions should be compact");
});

test("desktop compact density shrinks library controls", () => {
  const source = readRepoFile("css/components.css");
  const pickerRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .library-picker-anchor");
  const valueRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .library-picker-value");
  const optionRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .library-picker-option");
  const actionRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .library-action-button");

  assert.ok(readCssPx(pickerRule, "min-height") <= 82, "desktop library pickers should not use TV height");
  assert.ok(readCssPx(valueRule, "font-size") <= 28, "desktop library picker values should be compact");
  assert.ok(readCssPx(optionRule, "min-height") <= 64, "desktop library picker options should be compact");
  assert.ok(readCssPx(actionRule, "min-height") <= 50, "desktop library action buttons should be compact");
});

test("desktop compact density shrinks settings controls", () => {
  const source = readRepoFile("css/components.css");
  const workspaceRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .settings-workspace");
  const navRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .settings-nav-item");
  const titleRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .settings-title");
  const actionRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .settings-action-row");
  const themeRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .settings-theme-card");
  const layoutRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .settings-layout-card");

  assert.ok(workspaceRule.includes("grid-template-columns"), "desktop settings should override TV columns");
  assert.ok(readCssPx(navRule, "min-height") <= 82, "desktop settings nav rows should be compact");
  assert.ok(readCssPx(titleRule, "font-size") <= 40, "desktop settings title should be compact");
  assert.ok(readCssPx(actionRule, "min-height") <= 82, "desktop settings action rows should be compact");
  assert.ok(readCssPx(themeRule, "min-height") <= 180, "desktop settings theme cards should be compact");
  assert.ok(readCssPx(layoutRule, "min-height") <= 160, "desktop settings layout cards should be compact");
});

test("desktop compact density shrinks addon management controls", () => {
  const source = readRepoFile("css/components.css");
  const mainRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .addons-main");
  const titleRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .addons-title");
  const rowRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .addons-large-row");
  const installRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .addons-install-btn");
  const actionRule = extractCssRule(source, ".platform-desktop.desktop-display-compact .addons-action-btn");

  assert.ok(mainRule.includes("padding:"), "desktop addons should override TV page padding");
  assert.ok(readCssPx(titleRule, "font-size") <= 36, "desktop addons title should be compact");
  assert.ok(readCssPx(rowRule, "min-height") <= 104, "desktop addon rows should not use TV height");
  assert.ok(readCssPx(installRule, "min-height") <= 60, "desktop addon install buttons should be compact");
  assert.ok(readCssPx(actionRule, "min-height") <= 58, "desktop addon action buttons should be compact");
});
