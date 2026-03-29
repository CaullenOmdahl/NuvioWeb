/**
 * cheerioCompat.js
 *
 * Lightweight cheerio-compatible HTML parsing library for use inside Web Workers.
 * Provides the jQuery-like API surface that scrapers written for the Android TV
 * app expect.  Uses DOMParser (available in Workers) — no external dependencies.
 *
 * Export: cheerioLoad(html) → $ function
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONTAINS_RE = /:contains\((['"])(.*?)\1\)/g;

/**
 * Native querySelectorAll does not support the :contains(text) pseudo-selector.
 * We split any selector that uses it into (a) the part before the first
 * :contains(), and (b) one or more :contains() filters that we apply manually.
 *
 * Returns { baseSelector, textFilters[] } where textFilters may be empty.
 */
function parseContains(selector) {
  if (typeof selector !== "string") {
    return { baseSelector: selector, textFilters: [] };
  }
  const textFilters = [];
  let match;
  CONTAINS_RE.lastIndex = 0;
  while ((match = CONTAINS_RE.exec(selector)) !== null) {
    textFilters.push(match[2]);
  }
  if (textFilters.length === 0) {
    return { baseSelector: selector, textFilters: [] };
  }
  const baseSelector = selector.replace(CONTAINS_RE, "").trim() || "*";
  return { baseSelector, textFilters };
}

/**
 * Query elements under `root` honouring :contains() if present.
 */
function querySelectorAll(root, selector) {
  if (!root || typeof selector !== "string" || selector.trim() === "") {
    return [];
  }

  const { baseSelector, textFilters } = parseContains(selector);
  let elements;
  try {
    elements = Array.from(root.querySelectorAll(baseSelector));
  } catch (_e) {
    // Invalid selector — return empty set rather than throwing.
    return [];
  }

  if (textFilters.length === 0) {
    return elements;
  }

  return elements.filter((el) => {
    const text = el.textContent || "";
    return textFilters.every((filter) => text.indexOf(filter) !== -1);
  });
}

/**
 * Check whether a single element matches a selector string (with :contains
 * support).
 */
function matchesSelector(el, selector) {
  if (!el || typeof selector !== "string") {
    return false;
  }

  const { baseSelector, textFilters } = parseContains(selector);

  let baseMatch = true;
  if (baseSelector && baseSelector !== "*") {
    try {
      baseMatch = el.matches(baseSelector);
    } catch (_e) {
      return false;
    }
  }
  if (!baseMatch) {
    return false;
  }

  if (textFilters.length > 0) {
    const text = el.textContent || "";
    return textFilters.every((filter) => text.indexOf(filter) !== -1);
  }
  return true;
}

// ---------------------------------------------------------------------------
// CheerioSelection
// ---------------------------------------------------------------------------

class CheerioSelection {
  constructor(elements) {
    const els = Array.isArray(elements) ? elements : [];
    this._elements = els;
    this.length = els.length;

    // Expose numeric indices so sel[0] etc. work like jQuery/cheerio.
    for (let i = 0; i < els.length; i++) {
      this[i] = els[i];
    }
  }

  // -- Traversal -----------------------------------------------------------

  find(selector) {
    if (!selector) {
      return new CheerioSelection([]);
    }
    const results = [];
    for (const el of this._elements) {
      const found = querySelectorAll(el, selector);
      for (const f of found) {
        if (results.indexOf(f) === -1) {
          results.push(f);
        }
      }
    }
    return new CheerioSelection(results);
  }

  filter(selectorOrFn) {
    if (typeof selectorOrFn === "function") {
      const fn = selectorOrFn;
      const filtered = this._elements.filter((el, i) => fn.call(el, i, el));
      return new CheerioSelection(filtered);
    }
    if (typeof selectorOrFn === "string") {
      const filtered = this._elements.filter((el) =>
        matchesSelector(el, selectorOrFn)
      );
      return new CheerioSelection(filtered);
    }
    return new CheerioSelection([]);
  }

  children(selector) {
    const results = [];
    for (const el of this._elements) {
      const kids = Array.from(el.children || []);
      for (const kid of kids) {
        if (!selector || matchesSelector(kid, selector)) {
          if (results.indexOf(kid) === -1) {
            results.push(kid);
          }
        }
      }
    }
    return new CheerioSelection(results);
  }

  next() {
    const results = [];
    for (const el of this._elements) {
      const sib = el.nextElementSibling;
      if (sib && results.indexOf(sib) === -1) {
        results.push(sib);
      }
    }
    return new CheerioSelection(results);
  }

  prev() {
    const results = [];
    for (const el of this._elements) {
      const sib = el.previousElementSibling;
      if (sib && results.indexOf(sib) === -1) {
        results.push(sib);
      }
    }
    return new CheerioSelection(results);
  }

  first() {
    return new CheerioSelection(
      this._elements.length > 0 ? [this._elements[0]] : []
    );
  }

  last() {
    return new CheerioSelection(
      this._elements.length > 0
        ? [this._elements[this._elements.length - 1]]
        : []
    );
  }

  eq(index) {
    const i = index < 0 ? this._elements.length + index : index;
    const el = this._elements[i];
    return new CheerioSelection(el ? [el] : []);
  }

  // -- Iteration -----------------------------------------------------------

  each(callback) {
    for (let i = 0; i < this._elements.length; i++) {
      const ret = callback.call(this._elements[i], i, this._elements[i]);
      if (ret === false) {
        break;
      }
    }
    return this;
  }

  map(callback) {
    const results = [];
    for (let i = 0; i < this._elements.length; i++) {
      results.push(callback.call(this._elements[i], i, this._elements[i]));
    }
    return results;
  }

  // -- Data extraction -----------------------------------------------------

  text() {
    return this._elements.map((el) => el.textContent || "").join("");
  }

  html() {
    if (this._elements.length === 0) {
      return null;
    }
    return this._elements[0].innerHTML || null;
  }

  attr(name) {
    if (this._elements.length === 0 || !name) {
      return undefined;
    }
    const el = this._elements[0];
    if (!el.hasAttribute || !el.hasAttribute(name)) {
      return undefined;
    }
    return el.getAttribute(name);
  }

  // -- Raw access ----------------------------------------------------------

  get(index) {
    if (index === undefined || index === null) {
      return this._elements.slice();
    }
    const i = index < 0 ? this._elements.length + index : index;
    return this._elements[i];
  }

  toArray() {
    return this._elements.slice();
  }
}

// ---------------------------------------------------------------------------
// cheerioLoad
// ---------------------------------------------------------------------------

/**
 * Parse an HTML string and return a jQuery-like `$` function.
 *
 * @param {string} html  Raw HTML markup
 * @returns {Function}   $ selector function with .html() helper
 */
export function cheerioLoad(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");

  /**
   * $(selector)          — query against the whole document
   * $(selector, context) — query within a context element or CheerioSelection
   * $(element)           — wrap a raw DOM element
   */
  function $(selectorOrElement, context) {
    // Wrap a raw DOM element / node.
    if (
      selectorOrElement &&
      typeof selectorOrElement === "object" &&
      selectorOrElement.nodeType
    ) {
      return new CheerioSelection([selectorOrElement]);
    }

    // Wrap an existing CheerioSelection (no-op pass through).
    if (selectorOrElement instanceof CheerioSelection) {
      return selectorOrElement;
    }

    if (typeof selectorOrElement !== "string") {
      return new CheerioSelection([]);
    }

    // Determine root to search from.
    let root = doc;
    if (context) {
      if (context instanceof CheerioSelection) {
        // Search within all context elements and dedupe.
        const results = [];
        for (const ctxEl of context._elements) {
          const found = querySelectorAll(ctxEl, selectorOrElement);
          for (const f of found) {
            if (results.indexOf(f) === -1) {
              results.push(f);
            }
          }
        }
        return new CheerioSelection(results);
      }
      if (context.nodeType) {
        root = context;
      }
    }

    return new CheerioSelection(querySelectorAll(root, selectorOrElement));
  }

  /**
   * $.html(selection?) — serialize HTML.
   * Without args: returns the full document HTML.
   * With a CheerioSelection: returns outerHTML of the first matched element.
   */
  $.html = function (selection) {
    if (!selection) {
      return doc.documentElement ? doc.documentElement.outerHTML : "";
    }
    if (selection instanceof CheerioSelection) {
      if (selection._elements.length === 0) {
        return null;
      }
      return selection._elements[0].outerHTML || null;
    }
    // If passed a raw element.
    if (selection && selection.outerHTML) {
      return selection.outerHTML;
    }
    return null;
  };

  return $;
}
