'use strict';

// Pure layout math for the Spatial chrome document (Phase 3, spec steps 2–3).
//
// The spatial shell is the window chrome: BrowserTopBar (48px) across the top,
// ZenRail (224px open / 0px collapsed) down the left, and the remaining
// viewport area is the only region a live WebContentsView may occupy in
// Mode A ("reading"). Mode B ("canvas") hides every live view; the canvas is
// the whole window document.
//
// No Electron imports: this module must stay unit-testable with `node --test`
// (the same rule as tab-sleep.js and split-layout.js).

const TOP_BAR_HEIGHT = 48;
const RAIL_WIDTH_OPEN = 224;
const RAIL_WIDTH_COLLAPSED = 0;
// Mode B thumbnail size (spec Phase 3 step 2: 640×400 captures per node).
const MODE_B_THUMB = Object.freeze({ width: 640, height: 400 });
// Renderer-measured viewport rects are trusted only within these bounds, so a
// runaway DOM report can never place a view off-window or swallow the chrome.
const MAX_TOP_BAR = 120;
const MAX_RAIL_WIDTH = 400;
const MIN_VIEW_WIDTH = 320;
const MIN_VIEW_HEIGHT = 240;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Round a rect onto whole device pixels; WebContentsView bounds are ints. */
function roundRect(rect) {
  if (!rect || !isFiniteNumber(rect.x) || !isFiniteNumber(rect.y)
    || !isFiniteNumber(rect.width) || !isFiniteNumber(rect.height)) return null;
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  return {
    x,
    y,
    width: Math.round(rect.x + rect.width) - x,
    height: Math.round(rect.y + rect.height) - y,
  };
}

/** Structural check for a renderer-reported viewport rect. */
function isUsableRect(rect) {
  return !!rect
    && isFiniteNumber(rect.x) && isFiniteNumber(rect.y)
    && isFiniteNumber(rect.width) && isFiniteNumber(rect.height)
    && rect.width >= MIN_VIEW_WIDTH && rect.height >= MIN_VIEW_HEIGHT;
}

/**
 * The Mode A ("reading") bounds for a live WebContentsView: below
 * BrowserTopBar and right of ZenRail. A renderer-measured `viewportRect`
 * (window content coordinates, i.e. the DOM viewport container's
 * getBoundingClientRect) wins when structurally usable — that keeps native
 * views and the chrome DOM in lockstep even when rail/top-bar sizing changes.
 * Otherwise the default geometry is derived from the reported bar sizes.
 * Returns null when nothing usable fits (view stays hidden).
 */
function modeAViewBounds({
  windowWidth,
  windowHeight,
  railWidth = RAIL_WIDTH_OPEN,
  topBarHeight = TOP_BAR_HEIGHT,
  viewportRect = null,
} = {}) {
  if (!isFiniteNumber(windowWidth) || !isFiniteNumber(windowHeight)
    || windowWidth <= 0 || windowHeight <= 0) return null;
  if (isUsableRect(viewportRect)) {
    const clamped = clampRectToWindow(viewportRect, windowWidth, windowHeight);
    return clamped && clamped.width >= MIN_VIEW_WIDTH && clamped.height >= MIN_VIEW_HEIGHT
      ? clamped
      : null;
  }
  const rail = clampNumber(railWidth, RAIL_WIDTH_COLLAPSED, MAX_RAIL_WIDTH);
  const top = clampNumber(topBarHeight, 0, MAX_TOP_BAR);
  return roundRect({
    x: rail,
    y: top,
    width: windowWidth - rail,
    height: windowHeight - top,
  });
}

/** Clamp a rect into the window; null when it falls entirely outside. */
function clampRectToWindow(rect, windowWidth, windowHeight) {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const width = Math.min(rect.width, windowWidth - left);
  const height = Math.min(rect.height, windowHeight - top);
  if (width <= 0 || height <= 0) return null;
  return roundRect({ x: left, y: top, width, height });
}

const clampNumber = (value, min, max) =>
  Math.min(max, Math.max(min, isFiniteNumber(value) ? value : min));

/**
 * Validate a renderer-reported chrome layout before main caches it:
 * `{ topBarHeight, railWidth, mode, viewportRect? }`. Invalid fields fall
 * back to defaults rather than being trusted; an unknown mode falls back to
 * 'reading' so an untrusted payload can never park views hidden forever.
 */
function sanitizeChromeLayout(layout) {
  const source = layout && typeof layout === 'object' ? layout : {};
  const railRaw = isFiniteNumber(source.railWidth) ? source.railWidth : RAIL_WIDTH_OPEN;
  const topRaw = isFiniteNumber(source.topBarHeight) ? source.topBarHeight : TOP_BAR_HEIGHT;
  const mode = source.mode === 'canvas' ? 'canvas' : 'reading';
  return {
    topBarHeight: clampNumber(topRaw, 0, MAX_TOP_BAR),
    railWidth: clampNumber(railRaw, RAIL_WIDTH_COLLAPSED, MAX_RAIL_WIDTH),
    mode,
    ...(isUsableRect(source.viewportRect)
      ? { viewportRect: roundRect(source.viewportRect) }
      : {}),
  };
}

const isCanvasMode = (mode) => mode === 'canvas';

module.exports = {
  TOP_BAR_HEIGHT,
  RAIL_WIDTH_OPEN,
  RAIL_WIDTH_COLLAPSED,
  MODE_B_THUMB,
  MIN_VIEW_WIDTH,
  MIN_VIEW_HEIGHT,
  roundRect,
  modeAViewBounds,
  sanitizeChromeLayout,
  isCanvasMode,
  isUsableRect,
};
