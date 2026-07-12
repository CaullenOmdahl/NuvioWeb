const STREAMING_LIBS = [
  {
    kind: "hls",
    src: "https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js",
    isLoaded: () => Boolean(globalThis.Hls)
  },
  {
    kind: "dash",
    src: "https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js",
    isLoaded: () => Boolean(globalThis.dashjs)
  }
];

const streamingLibPromises = new Map();
let streamingLibsWarmupScheduled = false;

function normalizeRequestedKinds(value) {
  if (!Array.isArray(value) || !value.length) {
    return [];
  }
  return value.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean);
}

function getRequestedLibs(kinds) {
  const requestedKinds = normalizeRequestedKinds(kinds);
  if (!requestedKinds.length) {
    return STREAMING_LIBS;
  }
  return STREAMING_LIBS.filter((entry) => requestedKinds.includes(entry.kind));
}

function loadScript(src, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    if (!globalThis.document?.head || typeof document.createElement !== "function") {
      reject(new Error("Document head is not available"));
      return;
    }
    const script = document.createElement("script");
    let settled = false;
    let timeoutId = null;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      callback(value);
    };
    script.src = src;
    script.async = true;
    script.onload = () => finish(resolve);
    script.onerror = () => finish(reject, new Error(`Script failed to load: ${src}`));
    const normalizedTimeoutMs = Math.max(1, Number(timeoutMs || 2500));
    timeoutId = setTimeout(() => {
      finish(reject, new Error(`Script load timed out: ${src}`));
    }, normalizedTimeoutMs);
    document.head.appendChild(script);
  });
}

export async function loadStreamingLibs(options = {}) {
  const libs = getRequestedLibs(options?.kinds);
  if (!libs.length || libs.every((entry) => entry.isLoaded())) {
    return;
  }
  for (const entry of libs) {
    if (entry.isLoaded()) {
      continue;
    }
    if (!streamingLibPromises.has(entry.kind)) {
      const loadPromise = loadScript(entry.src, options?.timeoutMs)
        .catch((error) => {
          console.warn("Streaming library failed to load", entry.src, error);
        })
        .finally(() => {
          streamingLibPromises.delete(entry.kind);
        });
      streamingLibPromises.set(entry.kind, loadPromise);
    }
    await streamingLibPromises.get(entry.kind);
  }
}

export function warmStreamingLibs(options = {}) {
  const libs = getRequestedLibs(options?.kinds);
  if (streamingLibsWarmupScheduled || !libs.length || libs.every((entry) => entry.isLoaded())) {
    return;
  }
  streamingLibsWarmupScheduled = true;
  const delayMs = Math.max(0, Number(options?.delayMs || 1200));
  const startWarmup = () => {
    streamingLibsWarmupScheduled = false;
    void loadStreamingLibs(options);
  };
  if (typeof globalThis.requestIdleCallback === "function") {
    globalThis.requestIdleCallback(startWarmup, { timeout: Math.max(2000, delayMs + 1200) });
    return;
  }
  setTimeout(startWarmup, delayMs);
}
