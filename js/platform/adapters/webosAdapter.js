import { normalizeKeyEvent, isBackEvent } from "../sharedKeys.js";
import { WebOSPlayerExtensions } from "../webos/webosPlayerExtensions.js";

function getAvplayApi() {
  const webapis = globalThis.webapis;
  const avplay = webapis?.avplay || webapis?.avPlay || globalThis.avplay || null;
  if (!avplay || typeof avplay.open !== "function") {
    return null;
  }
  return avplay;
}

export const webosAdapter = {
  name: "webos",

  init() {
    const screenWidth = globalThis.screen?.width || globalThis.innerWidth || 0;
    if (screenWidth > 1920) {
      const scale = screenWidth / 1920;
      document.documentElement.style.setProperty("zoom", `${scale * 100}%`);
    }
  },

  exitApp() {
    if (globalThis.webOSSystem && typeof globalThis.webOSSystem.close === "function") {
      globalThis.webOSSystem.close();
    }
  },

  isBackEvent(event) {
    return isBackEvent(event, [461, 27, 8]);
  },

  normalizeKey(event) {
    return normalizeKeyEvent(event, [461, 27, 8]);
  },

  getDeviceLabel() {
    return "webOS TV";
  },

  getCapabilities() {
    return {
      hlsJs: Boolean(globalThis.Hls?.isSupported?.()),
      dashJs: Boolean(globalThis.dashjs?.MediaPlayer),
      nativeVideo: true,
      webosAvplay: Boolean(getAvplayApi()),
      tizenAvplay: false
    };
  },

  prepareVideoElement(videoElement) {
    WebOSPlayerExtensions.apply(videoElement);
  }
};
