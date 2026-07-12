import postcss from "postcss";

function splitTopLevelArgs(value) {
  const args = [];
  let current = "";
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    }

    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    args.push(current.trim());
  }
  return args;
}

function findFunctionEnd(value, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function replaceCssFunction(value, name, replacement) {
  let output = "";
  let cursor = 0;
  const needle = `${name}(`;

  while (cursor < value.length) {
    const start = value.indexOf(needle, cursor);
    if (start === -1) {
      output += value.slice(cursor);
      break;
    }

    const previousChar = start > 0 ? value[start - 1] : "";
    if (previousChar && /[A-Za-z0-9_-]/.test(previousChar)) {
      output += value.slice(cursor, start + needle.length);
      cursor = start + needle.length;
      continue;
    }

    const openIndex = start + name.length;
    const end = findFunctionEnd(value, openIndex);
    if (end === -1) {
      output += value.slice(cursor);
      break;
    }

    output += value.slice(cursor, start);
    output += replacement(value.slice(openIndex + 1, end));
    cursor = end + 1;
  }

  return output;
}

function normalizeFunctionalSizes(value) {
  let normalized = value;
  for (let pass = 0; pass < 4; pass += 1) {
    const previous = normalized;
    normalized = replaceCssFunction(normalized, "clamp", (argsText) => splitTopLevelArgs(argsText)[0] || argsText);
    normalized = replaceCssFunction(normalized, "min", (argsText) => splitTopLevelArgs(argsText)[0] || argsText);
    normalized = replaceCssFunction(normalized, "max", (argsText) => splitTopLevelArgs(argsText)[0] || argsText);
    if (normalized === previous) {
      break;
    }
  }
  return normalized;
}

function normalizeModernRgb(value) {
  return value.replace(
    /rgb\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\/\s*([0-9.]+%?)\s*\)/g,
    "rgba($1, $2, $3, $4)"
  );
}

function normalizeIntrinsicSizing(value) {
  return String(value || "").replace(/\b(max-content|min-content|fit-content)\b/g, "auto");
}

function parseVarExpression(expression) {
  const args = splitTopLevelArgs(expression);
  return {
    name: String(args[0] || "").trim(),
    fallback: args.slice(1).join(",").trim()
  };
}

export function collectLegacyCustomProperties(cssTexts) {
  const customProperties = new Map();

  for (const cssText of cssTexts) {
    const root = postcss.parse(cssText);
    root.walkDecls((declaration) => {
      if (!declaration.prop.startsWith("--") || customProperties.has(declaration.prop)) {
        return;
      }
      customProperties.set(declaration.prop, declaration.value);
    });
  }

  return customProperties;
}

export function resolveLegacyCssValue(value, customProperties = new Map(), stack = []) {
  let resolved = String(value || "");

  for (let pass = 0; pass < 12; pass += 1) {
    const previous = resolved;
    resolved = replaceCssFunction(resolved, "var", (argsText) => {
      const { name, fallback } = parseVarExpression(argsText);
      if (!name.startsWith("--") || stack.includes(name)) {
        return fallback || "";
      }

      if (customProperties.has(name)) {
        return resolveLegacyCssValue(customProperties.get(name), customProperties, [...stack, name]);
      }

      return fallback || "";
    });

    if (resolved === previous) {
      break;
    }
  }

  resolved = normalizeFunctionalSizes(resolved);
  resolved = normalizeModernRgb(resolved);
  resolved = normalizeIntrinsicSizing(resolved);
  return resolved;
}

function findRuleGap(rule, customProperties) {
  let gap = "";
  let isColumn = false;
  let hasFlexOrGrid = false;

  rule.walkDecls((declaration) => {
    if (declaration.prop === "display" && /^(flex|grid)$/.test(declaration.value.trim())) {
      hasFlexOrGrid = true;
    }
    if (declaration.prop === "flex-direction" && declaration.value.trim() === "column") {
      isColumn = true;
    }
    if (declaration.prop === "gap" && !gap) {
      gap = resolveLegacyCssValue(declaration.value, customProperties);
    }
  });

  return { gap, isColumn, hasFlexOrGrid };
}

function splitTopLevelSelectors(selector) {
  return splitTopLevelArgs(selector).filter(Boolean);
}

function buildGapFallbackSelector(selector) {
  return splitTopLevelSelectors(selector)
    .map((part) => `${part} > * + *`)
    .join(", ");
}

function pickGapMargin(gap, isColumn) {
  const parts = String(gap || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return isColumn ? parts[0] : parts[1];
  }
  return parts[0] || "";
}

function parseInsetValues(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  const [top, right = top, bottom = top, left = right] = parts;
  return { top, right, bottom, left };
}

function expandInsetDeclaration(declaration) {
  const values = parseInsetValues(declaration.value);
  if (!values) {
    declaration.remove();
    return;
  }

  declaration.cloneBefore({ prop: "top", value: values.top });
  declaration.cloneBefore({ prop: "right", value: values.right });
  declaration.cloneBefore({ prop: "bottom", value: values.bottom });
  declaration.cloneBefore({ prop: "left", value: values.left });
  declaration.remove();
}

const REMOVED_LEGACY_UNSUPPORTED_PROPERTIES = new Set([
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
  "-webkit-overflow-scrolling"
]);

function shouldRemoveLegacyUnsupportedDeclaration(declaration) {
  const prop = declaration.prop;
  if (prop.startsWith("--")) {
    return true;
  }
  if (prop === "display" && declaration.value.trim() === "grid") {
    return true;
  }
  if (prop === "gap" || prop === "row-gap" || prop === "column-gap") {
    return true;
  }
  if (prop === "grid" || prop.startsWith("grid-")) {
    return true;
  }
  if (REMOVED_LEGACY_UNSUPPORTED_PROPERTIES.has(prop)) {
    return true;
  }
  return false;
}

export function legacyWebosCssCompat({ customProperties = new Map() } = {}) {
  return {
    postcssPlugin: "legacy-webos-css-compat",
    Declaration(declaration) {
      if (declaration.prop === "display" && declaration.value.trim() === "grid") {
        declaration.cloneBefore({ prop: "display", value: "flex" });
        declaration.cloneBefore({ prop: "flex-wrap", value: "wrap" });
      }

      if (declaration.prop === "inset") {
        declaration.value = resolveLegacyCssValue(declaration.value, customProperties);
        expandInsetDeclaration(declaration);
        return;
      }

      if (declaration.value.includes("var(")
        || declaration.value.includes("clamp(")
        || declaration.value.includes("min(")
        || declaration.value.includes("max(")
        || declaration.value.includes("rgb(")
        || declaration.value.includes("max-content")
        || declaration.value.includes("min-content")
        || declaration.value.includes("fit-content")) {
        declaration.value = resolveLegacyCssValue(declaration.value, customProperties);
      }

      if (declaration.prop === "position" && declaration.value.trim() === "sticky") {
        declaration.value = "relative";
      }

      if (declaration.prop === "word-break") {
        declaration.cloneBefore({ prop: "word-wrap", value: "break-word" });
        declaration.cloneBefore({ prop: "overflow-wrap", value: "break-word" });
      }

      if (shouldRemoveLegacyUnsupportedDeclaration(declaration)) {
        declaration.remove();
      }
    },
    Rule(rule) {
      if (rule.selector.includes("::placeholder") && !rule.selector.includes("::-webkit-input-placeholder")) {
        rule.remove();
        return;
      }

      if (rule.selector.includes(":focus-visible") || rule.selector.includes(":focus-within")) {
        rule.selector = rule.selector
          .replace(/:focus-visible/g, ":focus")
          .replace(/:focus-within/g, ":focus");
      }

      if (rule.raws.legacyGapFallback || rule.selector.includes("> * + *")) {
        return;
      }

      const { gap, isColumn, hasFlexOrGrid } = findRuleGap(rule, customProperties);
      if (!gap || !hasFlexOrGrid || rule.selector.includes("::")) {
        return;
      }

      const fallbackValue = pickGapMargin(gap, isColumn);
      if (!fallbackValue) {
        return;
      }

      const fallbackRule = postcss.rule({ selector: buildGapFallbackSelector(rule.selector) });
      fallbackRule.raws.legacyGapFallback = true;
      fallbackRule.append({
        prop: isColumn ? "margin-top" : "margin-left",
        value: fallbackValue
      });
      rule.after(fallbackRule);
    }
  };
}

legacyWebosCssCompat.postcss = true;
