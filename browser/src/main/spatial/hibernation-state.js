'use strict';

// True 0 MB hibernation state for the Spatial warm pool (Phase 3, spec step 2).
//
// When the warm pool quiets a tab through Blanc's own sleepTab (renderer
// discarded, ~148 MB reclaimed), the page's scroll position, a playing
// media's currentTime and a short text excerpt would otherwise die with the
// renderer. The spec orders exactly this recovery tuple:
//
//   serialize { scrollX, scrollY, mediaTime, excerpt } via preload,
//   destroy/quiet the renderer, and on wake show the cached WebP cover
//   instantly while restoring scroll position on did-finish-load.
//
// This module holds the page-side scripts and the validation of what comes
// back as PURE, unit-testable logic — no Electron imports, no IPC, no disk:
//   - collectHibernationScript()  runs in the live page right BEFORE the
//     renderer is discarded (executeJavaScript; the preload surface cannot
//     observe it, so the runtime collects through the tab's webContents);
//   - normalizeHibernationState() shapes the returned record — a hostile or
//     half-broken page answer degrades to null, never to absurd magnitudes,
//     and a private node never keeps an excerpt (the noCapture class);
//   - restoreHibernationScript()  runs on the woken view after
//     did-finish-load (scroll restore; a media element is seeked, never
//     force-played);
//   - nextAudioImmunity()/isAudioImmune() implement the 2.5 s
//     audio-state-changed debounce so a brief media pause never lets the
//     pool evict an active video/audio tab.

/** How long a tab stays eviction-immune after an audio-state-changed event. */
const AUDIO_DEBOUNCE_MS = 2500;
/** Excerpt ceiling in characters (a search seed, not the page itself). */
const MAX_EXCERPT_CHARS = 2048;
/** Scroll magnitudes are clamped like every graph coordinate. */
const MAX_SCROLL_COORD = 1_000_000;
/** A media seek below this is indistinguishable from the start. */
const MIN_MEDIA_SEEK_S = 0.5;
/** Longest we wait for the woken view's did-finish-load before restoring. */
const RESTORE_LOAD_TIMEOUT_MS = 4000;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * The page-side collector. A self-contained IIFE string for
 * `webContents.executeJavaScript`: reads the scroll offsets, the first
 * PLAYING media element's currentTime and a bounded plain-text excerpt of
 * the document. Never throws — a broken page returns null and wake falls
 * back to Blanc's own navigationHistory pageState restore.
 */
function collectHibernationScript() {
  return '(function () { try {' +
    'var doc = document;' +
    'var root = doc.scrollingElement || doc.documentElement || doc.body;' +
    'var scrollX = Math.round((window.scrollX || 0) || (root ? root.scrollLeft : 0) || 0);' +
    'var scrollY = Math.round((window.scrollY || 0) || (root ? root.scrollTop : 0) || 0);' +
    'var mediaTime = null;' +
    'var media = doc.querySelectorAll("video, audio");' +
    'for (var i = 0; i < media.length; i++) {' +
    '  var m = media[i];' +
    '  if (!m.paused && !m.ended && m.currentTime > 0) { mediaTime = m.currentTime; break; }' +
    '}' +
    'var excerpt = "";' +
    'var skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1 };' +
    'var walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT, {' +
    '  acceptNode: function (node) {' +
    '    if (!node || !node.parentNode) return NodeFilter.FILTER_REJECT;' +
    '    if (skip[node.parentNode.nodeName]) return NodeFilter.FILTER_REJECT;' +
    '    var value = node.nodeValue || "";' +
    '    return value.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;' +
    '  }' +
    '});' +
    'var chunk = "";' +
    'while (excerpt.length < 2048 && (chunk = walker.nextNode())) {' +
    '  excerpt += (excerpt ? " " : "") + chunk.nodeValue.replace(/\\s+/g, " ").trim();' +
    '}' +
    'return { scrollX: scrollX, scrollY: scrollY, mediaTime: mediaTime, excerpt: excerpt };' +
    '} catch (error) { return null; } })()';
}

/**
 * Validate a collector answer into the persisted record. Rules:
 *   - scroll offsets clamp to ±MAX_SCROLL_COORD (same clamp as the graph);
 *   - mediaTime survives only when finite and within [0, 1e5] seconds;
 *   - the excerpt is whitespace-collapsed, trimmed and character-capped;
 *   - a PRIVATE node keeps no excerpt (the noCapture class — the text is
 *     page content; scroll/media are UI state and stay).
 * Returns null when nothing useful survived (nothing to restore, nothing to
 * keep), so the runtime never stores empty records.
 */
function normalizeHibernationState(raw, { private: isPrivate = false, maxExcerptChars = MAX_EXCERPT_CHARS } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const clampCoord = (value) => {
    if (!isFiniteNumber(value)) return 0;
    return Math.max(-MAX_SCROLL_COORD, Math.min(MAX_SCROLL_COORD, Math.round(value)));
  };
  const scrollX = clampCoord(raw.scrollX);
  const scrollY = clampCoord(raw.scrollY);
  let mediaTime = null;
  if (isFiniteNumber(raw.mediaTime) && raw.mediaTime >= 0 && raw.mediaTime <= 100_000) {
    mediaTime = Math.round(raw.mediaTime * 1000) / 1000;
  }
  let excerpt = '';
  if (!isPrivate && typeof raw.excerpt === 'string') {
    excerpt = raw.excerpt.replace(/\s+/g, ' ').trim().slice(0, Math.max(0, maxExcerptChars));
  }
  const moved = scrollX !== 0 || scrollY !== 0;
  if (!moved && mediaTime === null && !excerpt) return null;
  return { scrollX, scrollY, mediaTime, excerpt, at: Date.now() };
}

/**
 * The page-side restorer for the woken view, run after did-finish-load with
 * the normalized record JSON-stringified in. Restores scroll unconditionally;
 * seeks the first seekable media element to mediaTime when the record kept
 * one — it never calls play(), so a page wakes exactly as quiet as it slept.
 */
function restoreHibernationScript(state) {
  const safe = state && typeof state === 'object' ? state : {};
  const payload = JSON.stringify({
    scrollX: clampCoordJson(safe.scrollX),
    scrollY: clampCoordJson(safe.scrollY),
    mediaTime: isFiniteNumber(safe.mediaTime) ? safe.mediaTime : null,
  });
  return '(function () { try {' +
    `var s = ${payload};` +
    'window.scrollTo(s.scrollX, s.scrollY);' +
    'if (s.mediaTime != null && s.mediaTime > 0.5) {' +
    'var media = document.querySelectorAll("video, audio");' +
    'for (var i = 0; i < media.length; i++) {' +
    '  var m = media[i];' +
    '  if (m.seekable && m.seekable.length && s.mediaTime <= m.seekable.end(m.seekable.length - 1)) {' +
    '    try { m.currentTime = s.mediaTime; } catch (e) {}' +
    '    break;' +
    '  }' +
    '}' +
    '}' +
    'return true;' +
    '} catch (error) { return false; } })()';
}

const clampCoordJson = (value) => {
  if (!isFiniteNumber(value)) return 0;
  return Math.max(-MAX_SCROLL_COORD, Math.min(MAX_SCROLL_COORD, Math.round(value)));
};

/**
 * Stamp the audio-immunity deadline after an audio-state-changed event:
 * every transition (start OR pause) renews the window, so a pause shorter
 * than AUDIO_DEBOUNCE_MS can never hand the tab to the evictor mid-glitch.
 */
function nextAudioImmunity(now, { debounceMs = AUDIO_DEBOUNCE_MS } = {}) {
  const at = isFiniteNumber(now) ? now : Date.now();
  return at + Math.max(0, debounceMs);
}

/**
 * Eviction immunity predicate: an actually-audible tab is immune outright,
 * and a tab within its 2.5 s debounce window is immune too — that window is
 * exactly the "brief media pause" the spec protects.
 */
function isAudioImmune(entry, now) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.audible === true) return true;
  const until = entry.audioImmuneUntil;
  if (!isFiniteNumber(until)) return false;
  return until > (isFiniteNumber(now) ? now : Date.now());
}

module.exports = {
  AUDIO_DEBOUNCE_MS,
  MAX_EXCERPT_CHARS,
  MAX_SCROLL_COORD,
  MIN_MEDIA_SEEK_S,
  RESTORE_LOAD_TIMEOUT_MS,
  collectHibernationScript,
  normalizeHibernationState,
  restoreHibernationScript,
  nextAudioImmunity,
  isAudioImmune,
};
