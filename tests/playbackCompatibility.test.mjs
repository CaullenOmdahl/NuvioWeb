import assert from "node:assert/strict";
import test from "node:test";

test("playback engine ordering keeps source-compatible native engines ahead on legacy webOS", async () => {
  const moduleUrl = new URL(`../js/core/player/playbackEngineOrder.js?test=${Date.now()}`, import.meta.url);
  const { orderPlaybackEngineCandidates } = await import(moduleUrl);

  assert.deepEqual(
    orderPlaybackEngineCandidates(
      ["hls.js", "native-hls", "webos-avplay"],
      ["native-hls", "native-dash", "native-file", "hls.js", "dash.js", "platform-avplay"],
      "webos-avplay"
    ),
    ["native-hls", "hls.js", "webos-avplay"]
  );

  assert.deepEqual(
    orderPlaybackEngineCandidates(
      ["dash.js", "native-dash", "webos-avplay"],
      ["native-hls", "native-dash", "native-file", "hls.js", "dash.js", "platform-avplay"],
      "webos-avplay"
    ),
    ["native-dash", "dash.js", "webos-avplay"]
  );
});

test("streaming library loader times out stalled CDN script loads", async () => {
  const originalDocument = globalThis.document;
  const originalHls = globalThis.Hls;
  const originalDashjs = globalThis.dashjs;
  const originalWarn = console.warn;
  const appendedScripts = [];

  try {
    console.warn = () => {};
    delete globalThis.Hls;
    delete globalThis.dashjs;
    globalThis.document = {
      createElement(tagName) {
        assert.equal(tagName, "script");
        return {};
      },
      head: {
        appendChild(script) {
          appendedScripts.push(script);
        }
      }
    };

    const moduleUrl = new URL(`../js/runtime/loadStreamingLibs.js?test=${Date.now()}`, import.meta.url);
    const { loadStreamingLibs } = await import(moduleUrl);
    const result = await Promise.race([
      loadStreamingLibs({ timeoutMs: 5 }).then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 80))
    ]);

    assert.equal(result, "resolved");
    assert.equal(appendedScripts.length, 2);
    assert.ok(appendedScripts.every((script) => script.async === true));
  } finally {
    globalThis.document = originalDocument;
    globalThis.Hls = originalHls;
    globalThis.dashjs = originalDashjs;
    console.warn = originalWarn;
  }
});
