const DEFAULT_PLAYBACK_ORDER = [
  "native-hls",
  "native-dash",
  "native-file",
  "hls.js",
  "dash.js",
  "platform-avplay"
];

function normalizeEngineName(value, platformAvplayEngineName = "webos-avplay") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "platform-avplay" || normalized === "avplay") {
    return String(platformAvplayEngineName || "").trim() || "webos-avplay";
  }
  if (normalized === "native") {
    return "native-file";
  }
  return normalized;
}

function uniqueEngineNames(values, platformAvplayEngineName) {
  const seen = new Set();
  const result = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const normalized = normalizeEngineName(value, platformAvplayEngineName);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

export function orderPlaybackEngineCandidates(candidates, preferredOrder = [], platformAvplayEngineName = "webos-avplay") {
  const uniqueCandidates = uniqueEngineNames(candidates, platformAvplayEngineName);
  if (uniqueCandidates.length <= 1) {
    return uniqueCandidates;
  }

  const order = uniqueEngineNames(
    Array.isArray(preferredOrder) && preferredOrder.length ? preferredOrder : DEFAULT_PLAYBACK_ORDER,
    platformAvplayEngineName
  );
  const candidateSet = new Set(uniqueCandidates);
  const ordered = [];

  order.forEach((engineName) => {
    if (candidateSet.has(engineName) && !ordered.includes(engineName)) {
      ordered.push(engineName);
    }
  });

  uniqueCandidates.forEach((engineName) => {
    if (!ordered.includes(engineName)) {
      ordered.push(engineName);
    }
  });

  return ordered;
}

