import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const cssFiles = [
  "dist/css/base.css",
  "dist/css/layout.css",
  "dist/css/components.css",
  "dist/css/themes.css"
];

const disallowedValuePatterns = [
  ["css var()", /var\(/],
  ["css clamp()", /clamp\(/],
  ["css min()", /\bmin\(/],
  ["css max()", /\bmax\(/],
  ["modern rgb slash alpha", /rgb\([0-9.]+\s+[0-9.]+\s+[0-9.]+\s*\//],
  ["intrinsic sizing keyword", /\b(?:max-content|min-content|fit-content)\b/]
];

const disallowedProperties = new Set([
  "aspect-ratio",
  "object-fit",
  "object-position",
  "backdrop-filter",
  "-webkit-backdrop-filter",
  "scrollbar-width",
  "overscroll-behavior",
  "scroll-behavior",
  "scroll-margin",
  "scroll-margin-block",
  "scroll-margin-block-end",
  "scroll-margin-block-start",
  "scroll-margin-bottom",
  "scroll-margin-inline",
  "scroll-margin-inline-end",
  "scroll-margin-inline-start",
  "scroll-margin-left",
  "scroll-margin-right",
  "scroll-margin-top",
  "scroll-padding",
  "scroll-padding-block",
  "scroll-padding-block-end",
  "scroll-padding-block-start",
  "scroll-padding-bottom",
  "scroll-padding-inline",
  "scroll-padding-inline-end",
  "scroll-padding-inline-start",
  "scroll-padding-left",
  "scroll-padding-right",
  "scroll-padding-top",
  "scroll-snap-align",
  "scroll-snap-coordinate",
  "scroll-snap-destination",
  "scroll-snap-points-x",
  "scroll-snap-points-y",
  "scroll-snap-stop",
  "scroll-snap-type",
  "scrollbar-color",
  "contain",
  "isolation",
  "will-change",
  "mask-repeat",
  "mask-position",
  "mask-size",
  "appearance",
  "word-break",
  "-ms-overflow-style",
  "-webkit-overflow-scrolling",
  "gap",
  "row-gap",
  "column-gap",
  "inset"
]);

function addIssue(issues, file, node, message) {
  const line = node?.source?.start?.line || 1;
  issues.push(`${file}:${line}: ${message}`);
}

async function checkCssFile(file) {
  const fullPath = path.join(rootDir, file);
  const css = await readFile(fullPath, "utf8");
  const issues = [];

  for (const [label, pattern] of disallowedValuePatterns) {
    if (pattern.test(css)) {
      issues.push(`${file}:1: found ${label}`);
    }
  }

  const root = postcss.parse(css, { from: fullPath });
  root.walkRules((rule) => {
    if (rule.selector.includes(":focus-visible") || rule.selector.includes(":focus-within")) {
      addIssue(issues, file, rule, `unsupported selector ${rule.selector}`);
    }
    if (rule.selector.includes("::placeholder") && !rule.selector.includes("::-webkit-input-placeholder")) {
      addIssue(issues, file, rule, `unsupported selector ${rule.selector}`);
    }
  });
  root.walkDecls((declaration) => {
    if (declaration.prop.startsWith("--")) {
      addIssue(issues, file, declaration, `custom property declaration ${declaration.prop}`);
    }
    if (declaration.prop === "display" && declaration.value.trim() === "grid") {
      addIssue(issues, file, declaration, "display:grid remains in legacy CSS");
    }
    if (declaration.prop === "grid" || declaration.prop.startsWith("grid-")) {
      addIssue(issues, file, declaration, `grid property ${declaration.prop}`);
    }
    if (declaration.prop === "position" && declaration.value.trim() === "sticky") {
      addIssue(issues, file, declaration, "position:sticky remains in legacy CSS");
    }
    if (disallowedProperties.has(declaration.prop)) {
      addIssue(issues, file, declaration, `unsupported property ${declaration.prop}`);
    }
  });

  return issues;
}

async function main() {
  const issueGroups = await Promise.all(cssFiles.map(checkCssFile));
  const issues = issueGroups.flat();

  if (issues.length) {
    console.error("Legacy webOS compatibility check failed:");
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    process.exit(1);
  }

  console.log("Legacy webOS compatibility check passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
