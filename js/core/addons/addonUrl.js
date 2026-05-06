export function normalizeAddonInstallUrl(input) {
  let candidate = String(input || "").trim();
  if (!candidate) {
    return "";
  }

  if (/^stremio:\/\//i.test(candidate)) {
    candidate = candidate.replace(/^stremio:\/\//i, "https://");
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return "";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "";
  }

  let normalized = parsed.href.replace(/\/+$/, "");
  if (normalized.endsWith("/manifest.json")) {
    normalized = normalized.slice(0, -"/manifest.json".length);
  }

  return normalized.replace(/\/+$/, "");
}
