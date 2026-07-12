import assert from "node:assert/strict";
import test from "node:test";
import postcss from "postcss";

import {
  collectLegacyCustomProperties,
  legacyWebosCssCompat
} from "../scripts/legacyCssCompat.mjs";

test("legacy CSS compatibility expands variables and modern sizing functions", async () => {
  const globals = collectLegacyCustomProperties([`
    :root {
      --card-bg: #1a1c20;
      --safe-width: min(92vw, 1120px);
      --title-size: clamp(42px, 3vw, 60px);
    }
  `]);

  const result = await postcss([
    legacyWebosCssCompat({ customProperties: globals })
  ]).process(`
    .panel {
      width: var(--safe-width);
      background: var(--card-bg);
      font-size: var(--title-size);
      color: rgb(245 248 252 / 0.16);
    }
  `, { from: undefined });

  assert.match(result.css, /width:\s*92vw/);
  assert.match(result.css, /background:\s*#1a1c20/);
  assert.match(result.css, /font-size:\s*42px/);
  assert.match(result.css, /color:\s*rgba\(245,\s*248,\s*252,\s*0\.16\)/);
  assert.doesNotMatch(result.css, /var\(/);
  assert.doesNotMatch(result.css, /clamp\(/);
  assert.doesNotMatch(result.css, /\bmin\(/);
});

test("legacy CSS compatibility leaves flex fallback before unsupported grid and adds gap fallback", async () => {
  const result = await postcss([
    legacyWebosCssCompat()
  ]).process(`
    .tiles {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 24px;
    }
  `, { from: undefined });

  assert.match(result.css, /display:\s*flex/);
  assert.match(result.css, /flex-wrap:\s*wrap/);
  assert.doesNotMatch(result.css, /display:\s*grid/);
  assert.doesNotMatch(result.css, /grid-template-columns/);
  assert.doesNotMatch(result.css, /\bgap:/);
  assert.match(result.css, /\.tiles\s*>\s*\*\s*\+\s*\*\s*\{[^}]*margin-left:\s*24px/);
});

test("legacy CSS compatibility does not corrupt minmax and scopes comma selector gap fallbacks", async () => {
  const result = await postcss([
    legacyWebosCssCompat()
  ]).process(`
    .one, .two {
      display: grid;
      grid-template-columns: repeat(2, minmax(320px, 1fr));
      gap: 20px 16px;
    }
  `, { from: undefined });

  assert.doesNotMatch(result.css, /minmax\(320px,\s*1fr\)/);
  assert.doesNotMatch(result.css, /min320px/);
  assert.match(result.css, /\.one\s*>\s*\*\s*\+\s*\*,\s*\.two\s*>\s*\*\s*\+\s*\*/);
  assert.match(result.css, /margin-left:\s*16px/);
});

test("legacy CSS compatibility removes unsupported declarations after fallbacks", async () => {
  const globals = collectLegacyCustomProperties([`
    :root { --gap-size: 12px; }
  `]);

  const result = await postcss([
    legacyWebosCssCompat({ customProperties: globals })
  ]).process(`
    .grid {
      --local-size: 20px;
      display: grid;
      grid-template-columns: repeat(2, minmax(320px, 1fr));
      gap: var(--gap-size);
      inset: 0 auto 12px 4px;
      width: max-content;
      aspect-ratio: 2 / 3;
      object-fit: cover;
      backdrop-filter: blur(8px);
      scroll-padding-top: 24px;
      scroll-margin-top: 24px;
      scrollbar-color: transparent transparent;
      position: sticky;
    }

    .field:focus-within,
    .button:focus-visible {
      color: white;
    }

    .field::placeholder {
      color: gray;
    }

    .label {
      word-break: break-word;
    }
  `, { from: undefined });

  assert.match(result.css, /display:\s*flex/);
  assert.match(result.css, /flex-wrap:\s*wrap/);
  assert.match(result.css, /top:\s*0/);
  assert.match(result.css, /right:\s*auto/);
  assert.match(result.css, /bottom:\s*12px/);
  assert.match(result.css, /left:\s*4px/);
  assert.match(result.css, /width:\s*auto/);
  assert.match(result.css, /position:\s*relative/);
  assert.match(result.css, /\.field:focus,\s*\.button:focus/);
  assert.match(result.css, /word-wrap:\s*break-word/);
  assert.match(result.css, /overflow-wrap:\s*break-word/);
  assert.doesNotMatch(result.css, /--local-size/);
  assert.doesNotMatch(result.css, /display:\s*grid/);
  assert.doesNotMatch(result.css, /grid-template-columns/);
  assert.doesNotMatch(result.css, /\bgap:/);
  assert.doesNotMatch(result.css, /inset:/);
  assert.doesNotMatch(result.css, /aspect-ratio/);
  assert.doesNotMatch(result.css, /object-fit/);
  assert.doesNotMatch(result.css, /backdrop-filter/);
  assert.doesNotMatch(result.css, /scroll-padding/);
  assert.doesNotMatch(result.css, /scroll-margin/);
  assert.doesNotMatch(result.css, /scrollbar-color/);
  assert.doesNotMatch(result.css, /position:\s*sticky/);
  assert.doesNotMatch(result.css, /:focus-within|:focus-visible/);
  assert.doesNotMatch(result.css, /::placeholder/);
  assert.doesNotMatch(result.css, /word-break/);
});
