export const desktopAdapter = {
  name: "desktop",

  init() {},

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
