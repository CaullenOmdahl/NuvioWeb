import { calculateDesktopDisplayScalePercent } from "../displayScale.js";

function hasNativeDisplayZoom() {
  return typeof globalThis.__TAURI_INTERNALS__?.invoke === "function";
}

function applyNativeDisplayScale(userScalePercent) {
  const invoke = globalThis.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") {
    return false;
  }

  invoke("set_desktop_display_zoom", {
    userScalePercent: Number(userScalePercent || 100)
  })
    .then((result) => {
      const platformScale = Number(result?.platformScalePercent ?? result?.platform_scale_percent ?? 100);
      const effectiveScale = Number(result?.effectiveScalePercent ?? result?.effective_scale_percent ?? 100);
      if (Number.isFinite(platformScale)) {
        document.documentElement.classList.toggle("desktop-display-compact", platformScale < 100);
      }
      if (Number.isFinite(effectiveScale)) {
        document.documentElement.dataset.displayScale = String(effectiveScale);
        document.documentElement.style.setProperty("--nuvio-display-scale", String(effectiveScale / 100));
      }
    })
    .catch((error) => {
      console.warn("Failed to apply desktop display scale:", error);
    });
  return true;
}

export const desktopAdapter = {
  name: "desktop",

  init() {
    document.documentElement.classList.add("platform-desktop");
  },

  getDisplayScalePercent() {
    if (hasNativeDisplayZoom()) {
      return 100;
    }
    return calculateDesktopDisplayScalePercent({
      width: globalThis.outerWidth || globalThis.innerWidth,
      height: globalThis.outerHeight || globalThis.innerHeight
    });
  },

  applyDisplayScalePercent(_scalePercent, options = {}) {
    return applyNativeDisplayScale(options.userScalePercent);
  },

  getDeviceLabel() {
    return "Desktop";
  },

  getCapabilities() {
    return {
      hlsJs: true,
      dashJs: true,
      nativeVideo: true
    };
  },

  isBackEvent(event) {
    return event?.keyCode === 27 || event?.keyCode === 8;
  },

  normalizeKey(event) {
    return event;
  },

  exitApp() {
    window.close();
  }
};
