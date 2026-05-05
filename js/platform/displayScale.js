const MIN_UI_SCALE_PERCENT = 75;
const MAX_UI_SCALE_PERCENT = 150;
const DEFAULT_UI_SCALE_PERCENT = 100;
const DESKTOP_DESIGN_WIDTH = 1600;
const DESKTOP_DESIGN_HEIGHT = 1000;
const DESKTOP_MIN_AUTO_SCALE_PERCENT = 75;

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeUiScalePercent(value, fallback = DEFAULT_UI_SCALE_PERCENT) {
  const number = toFiniteNumber(value, fallback);
  return clamp(Math.round(number || fallback), MIN_UI_SCALE_PERCENT, MAX_UI_SCALE_PERCENT);
}

export function calculateDesktopDisplayScalePercent(viewport = {}) {
  const width = toFiniteNumber(viewport.width);
  const height = toFiniteNumber(viewport.height);
  if (width <= 0 || height <= 0) {
    return DEFAULT_UI_SCALE_PERCENT;
  }

  const widthScale = width / DESKTOP_DESIGN_WIDTH;
  const heightScale = height / DESKTOP_DESIGN_HEIGHT;
  const autoScale = Math.min(widthScale, heightScale) * 100;
  return clamp(Math.round(autoScale), DESKTOP_MIN_AUTO_SCALE_PERCENT, DEFAULT_UI_SCALE_PERCENT);
}

export function calculateTvDisplayScalePercent(viewport = {}) {
  const width = toFiniteNumber(viewport.screenWidth || viewport.width);
  if (width <= 1920) {
    return DEFAULT_UI_SCALE_PERCENT;
  }
  return Math.round((width / 1920) * 100);
}

export function combineDisplayScalePercent({ platformScalePercent, userScalePercent } = {}) {
  const platformScale = toFiniteNumber(platformScalePercent, DEFAULT_UI_SCALE_PERCENT);
  const userScale = normalizeUiScalePercent(userScalePercent);
  return Math.round((platformScale * userScale) / DEFAULT_UI_SCALE_PERCENT);
}
