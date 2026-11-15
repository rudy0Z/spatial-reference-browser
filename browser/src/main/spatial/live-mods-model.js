'use strict';

// Pure policy for the §B.9 Zero-Extension "Live Mods" engine.
//
// Everything here is a pure function over plain data — no Electron, no I/O,
// no module state — so `node --test` (browser/tests/spatial-live-mods
// .test.mjs) pins the exact contract the main-process wiring
// (../live-mods.js) and the in-page zapper scripts rely on:
//   - domain-pattern matching (mod records are domain-keyed),
//   - compiled-CSS shape (spec: zapSelectors.join(', ') + ' { display: none
//     !important; }' + '\n' + css, injected with cssOrigin: 'user'),
//   - resilient zap-selector generation (data-testid / id preferred,
//     structural fallback),
//   - the armed Element-Zapper in-page scripts (hover outline, Alt+Shift+Click,
//     descriptor capture) as ready-to-executeJavaScript strings.

/* ------------------------------------------------------------------ */
/* Limits (the wiring enforces; the model clamps defensively)           */
/* ------------------------------------------------------------------ */

const MAX_CSS_LENGTH = 65_536;
const MAX_SELECTOR_LENGTH = 256;
const MAX_ZAP_SELECTORS = 128;
const MAX_MODS = 64;
// Ancestor chain captured by the in-page zapper (self + up to 5 ancestors).
const MAX_CHAIN_DEPTH = 6;
// Structural path length when no stability attribute anchors the selector.
const MAX_STRUCTURAL_SEGMENTS = 3;

/* ------------------------------------------------------------------ */
/* URLs & domain patterns                                               */
/* ------------------------------------------------------------------ */

/** Lower-case hostname of an http(s)/ws(s) URL, or null. Ports stripped. */
function hostnameOf(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:'
      && parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    const host = parsed.hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

/** Normalize a domain pattern ('*.example.com', 'EXAMPLE.com/path:8080').
 *  Returns a lower-case host pattern with an optional '*.' prefix, or null. */
function normalizeDomainPattern(value) {
  if (typeof value !== 'string') return null;
  let v = value.trim().toLowerCase();
  const schemeSplit = v.indexOf('://');
  if (schemeSplit !== -1) v = v.slice(schemeSplit + 3);
  const pathCut = v.search(/[/?#]/);
  if (pathCut !== -1) v = v.slice(0, pathCut);
  const portCut = v.indexOf(':');
  if (portCut !== -1) v = v.slice(0, portCut);
  v = v.replace(/^\*{2,}\./, '*.').replace(/^\.+|\.+$/g, '');
  if (!v) return null;
  if (!/^(\*\.)?[a-z0-9][a-z0-9.\-]*$/.test(v)) return null;
  if (/\.\./.test(v)) return null; // empty labels ('example..com')
  // A single label is only a scoping target for localhost dev servers.
  if (!v.includes('.') && v !== 'localhost') return null;
  return v;
}

/**
 * Does a mod's domainPattern apply to this URL? The apex matches its own
 * subdomains ('example.com' matches 'example.com' and 'www.example.com');
 * an explicit '*.' pattern matches subdomains only.
 */
function domainPatternMatches(pattern, url) {
  const p = normalizeDomainPattern(pattern);
  const host = hostnameOf(url);
  if (!p || !host) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return host.endsWith('.' + suffix);
  }
  return host === p || host.endsWith('.' + p);
}

/* ------------------------------------------------------------------ */
/* Sanitizers                                                           */
/* ------------------------------------------------------------------ */

/**
 * A zap selector must stay inside one CSS complex selector: only characters
 * that can break out of a rule context are banned ({ } ; @), plus control
 * characters. Combinators (>, +, ~) and backslashes stay legal — the
 * structural fallback composes `>`-joined paths and escaped attribute
 * values like [id="a\"b"].
 */
function sanitizeSelector(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > MAX_SELECTOR_LENGTH) return null;
  if (/[{};@]/.test(s)) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

/** Mod CSS text: normalized newlines, control chars dropped, length capped. */
function sanitizeCssText(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return cleaned.length > MAX_CSS_LENGTH ? cleaned.slice(0, MAX_CSS_LENGTH) : cleaned;
}

/** One validated §B.9 mod record, or null when the shape is unusable. */
function normalizeModRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' && /^[a-z][\w:@.\-]{0,79}$/i.test(raw.id) ? raw.id : null;
  const domainPattern = normalizeDomainPattern(raw.domainPattern);
  if (!id || !domainPattern) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Mod';
  const enabled = raw.enabled === true;
  const css = sanitizeCssText(raw.css);
  const zapSelectors = Array.isArray(raw.zapSelectors)
    ? [...new Set(raw.zapSelectors.map(sanitizeSelector).filter(Boolean))].slice(0, MAX_ZAP_SELECTORS)
    : [];
  return { id, domainPattern, name, enabled, css, zapSelectors };
}

/* ------------------------------------------------------------------ */
/* Compiled CSS (the spec §B.9 injection shape)                         */
/* ------------------------------------------------------------------ */

/** `sel1, sel2 { display: none !important; }` — '' when no selectors. */
function buildZapRule(selectors) {
  const list = (Array.isArray(selectors) ? selectors : [])
    .map(sanitizeSelector)
    .filter(Boolean);
  if (!list.length) return '';
  return list.join(', ') + ' { display: none !important; }';
}

/**
 * Compiled stylesheet for ONE mod record: the zap hide-rule first, then the
 * mod's own CSS. Disabled or empty mods compile to '' (nothing injected —
 * the §B.0 zero-cost law).
 */
function compileModCss(mod) {
  const m = normalizeModRecord(mod);
  if (!m || !m.enabled) return '';
  const rule = buildZapRule(m.zapSelectors);
  if (rule && m.css) return rule + '\n' + m.css;
  return rule || m.css;
}

/** Combined compile across records (order preserved; empties skipped). */
function compileEnabledCss(mods) {
  return (Array.isArray(mods) ? mods : [])
    .map(compileModCss)
    .filter(Boolean)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Mod ids                                                              */
/* ------------------------------------------------------------------ */

const zapModId = (domain) => {
  const p = normalizeDomainPattern(domain);
  return p ? `zap:${p}` : null;
};
const cssModId = (domain) => {
  const p = normalizeDomainPattern(domain);
  return p ? `css:${p}` : null;
};
const presetModId = (presetId, domain) => {
  const p = normalizeDomainPattern(domain);
  if (!p || typeof presetId !== 'string' || !/^[a-z][a-z0-9\-]{0,63}$/.test(presetId)) return null;
  return `preset:${presetId}:${p}`;
};

/* ------------------------------------------------------------------ */
/* Resilient zap-selector generation                                    */
/* ------------------------------------------------------------------ */

// Attributes the in-page zapper reports, in stability-preference order.
const ZAP_ATTRS = ['data-testid', 'data-test', 'data-qa'];

const escAttrValue = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Classes that look framework-generated (emotion/css-*, sc-*, hash runs). */
function looksHashedClass(cls) {
  return /[0-9a-f]{6,}/i.test(cls)
    || /(?:^|[\-_])\d{3,}(?:[\-_]|$)/.test(cls)
    // css-/sc-/jss-/ch- prefixed names are framework-generated by convention
    // (emotion, styled-components), digits or not.
    || /^(css|sc|jss|ch)[\-_][\w-]*$/i.test(cls);
}

/** First authored-looking class, or null when every class looks generated. */
function stableClass(classes) {
  if (!Array.isArray(classes)) return null;
  for (const cls of classes) {
    if (typeof cls === 'string' && /^[A-Za-z_][\w-]*$/.test(cls)
      && cls.length <= 64 && !looksHashedClass(cls)) return cls;
  }
  return null;
}

/** `#clean-id`, or the attribute form for ids that are not clean idents. */
function idSelector(id) {
  if (typeof id !== 'string' || !id) return null;
  if (/^-?[A-Za-z_][\w-]*$/.test(id)) return '#' + id;
  return `[id="${escAttrValue(id)}"]`;
}

/** Stability-attribute selector for one chain segment, or null. */
function preferredAttrSelector(seg) {
  for (const attr of ZAP_ATTRS) {
    const value = attr === 'data-testid' ? seg.testId
      : attr === 'data-test' ? seg.dataTest
        : seg.dataQa;
    if (typeof value === 'string' && value) return `[${attr}="${escAttrValue(value)}"]`;
  }
  return null;
}

/** One structural path segment: tag(.stable-class)?:nth-of-type(n). */
function structuralSegment(seg, withClass) {
  const cls = withClass ? stableClass(seg.classes) : null;
  const nth = Number.isInteger(seg.nth) && seg.nth > 0 ? `:nth-of-type(${seg.nth})` : '';
  return seg.tag.toLowerCase() + (cls ? '.' + cls : '') + nth;
}

/**
 * Resilient CSS selector for a clicked element, from the descriptor the
 * in-page zapper captured ({ chain: [{ tag, id, testId, dataTest, dataQa,
 * classes, nth }, ...ancestors…] }).
 *
 *  1. data-testid / data-test / data-qa ON THE CLICKED ELEMENT (attribute
 *     selectors on ancestors would hide whole containers);
 *  2. its id (#clean form, [id="…"] attribute form otherwise);
 *  3. a structural path anchored at the nearest ancestor that carries a
 *     stability attribute or id, `>`-joined tail of ≤ 3 class/nth segments;
 *  4. last resort: a full path from the outermost captured ancestor
 *     (≤ MAX_CHAIN_DEPTH segments, classes on the clicked element only).
 *
 * Returns null when nothing sane can be built.
 */
function buildResilientSelector(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return null;
  const chain = Array.isArray(descriptor.chain)
    ? descriptor.chain.filter((seg) => seg && typeof seg.tag === 'string'
      && /^[a-z][a-z0-9]*$/i.test(seg.tag)).slice(0, MAX_CHAIN_DEPTH)
    : [];
  if (!chain.length) return null;
  const self = chain[0];

  // 1–2: stability attributes on the clicked element itself.
  const attrSel = preferredAttrSelector(self);
  if (attrSel) return sanitizeSelector(attrSel) ? attrSel : null;
  const idSel = idSelector(self.id);
  if (idSel) return sanitizeSelector(idSel) ? idSel : null;

  // 3: structural path anchored at the nearest stable ancestor.
  let anchorIndex = -1;
  for (let i = 1; i < chain.length; i++) {
    if (preferredAttrSelector(chain[i]) || idSelector(chain[i].id)) { anchorIndex = i; break; }
  }
  if (anchorIndex > 0) {
    const anchorSeg = chain[anchorIndex];
    const anchor = preferredAttrSelector(anchorSeg) ?? idSelector(anchorSeg.id);
    const tail = [];
    for (let i = anchorIndex - 1; i >= 1; i--) tail.unshift(structuralSegment(chain[i], true));
    tail.push(structuralSegment(self, true));
    const sel = anchor + ' ' + tail.slice(-MAX_STRUCTURAL_SEGMENTS).join(' > ');
    return sanitizeSelector(sel) ? sel : null;
  }

  // 4: full path from the outermost captured ancestor (stable classes on
  // every segment — generated ones are skipped by stableClass).
  const parts = [];
  for (let i = chain.length - 1; i >= 0; i--) parts.push(structuralSegment(chain[i], true));
  const sel = parts.slice(-MAX_CHAIN_DEPTH).join(' > ');
  return sanitizeSelector(sel) ? sel : null;
}

/* ------------------------------------------------------------------ */
/* One-click presets (§B.9)                                             */
/* ------------------------------------------------------------------ */

const MATTE_READER_CSS = `/* Matte Reader — strip the chrome around the content, give text room */
aside, [role="complementary"], [role="banner"], [role="navigation"],
[class*="sidebar" i], [id*="sidebar" i], [class*="advert" i], [id*="advert" i],
[class*="-ads" i], [class*="ads-" i], [class*="advert" i],
ins.adsbygoogle, iframe[src*="doubleclick"], iframe[src*="googlesyndication"] {
  display: none !important;
}
main, article, [role="main"] {
  max-width: 65ch !important;
  margin-inline: auto !important;
  padding-inline: 24px !important;
  float: none !important;
}
body {
  font-size: 17px !important;
  line-height: 1.6 !important;
  letter-spacing: 0.01em !important;
}`;

const DESATURATE_CSS = `/* Desaturate Chrome — the noisy frame fades to a whisper until hovered */
header, nav, aside, footer,
[class*="banner" i], [class*="cookie" i], [class*="newsletter" i],
[class*="promo" i], [class*="popup" i], [class*="modal" i] {
  opacity: 0.3 !important;
  transition: opacity 140ms ease !important;
}
header:hover, nav:hover, aside:hover, footer:hover,
[class*="banner" i]:hover, [class*="cookie" i]:hover, [class*="newsletter" i]:hover,
[class*="promo" i]:hover, [class*="popup" i]:hover, [class*="modal" i]:hover {
  opacity: 1 !important;
}`;

const PAPER_CSS = `/* Force Paper — a warm sheet for pages that never styled themselves */
:root { color-scheme: light !important; }
html, body {
  background: #f4f1ea !important;
  color: #201e19 !important;
}
html *, body * {
  background-color: transparent !important;
  border-color: rgba(31, 28, 22, 0.14) !important;
}
a { color: #6e5a2e !important; }`;

const GRAPHITE_CSS = `/* Graphite Surface — the same override, matte dark */
:root { color-scheme: dark !important; }
html, body {
  background: #121215 !important;
  color: #f3f3f5 !important;
}
html *, body * {
  background-color: transparent !important;
  border-color: rgba(255, 255, 255, 0.09) !important;
}
a { color: #b9b9c4 !important; }`;

/**
 * Three one-click presets. 'surface' is the Force Paper / Graphite Surface
 * pair — one preset, two clean variants (paper is the default).
 */
const PRESETS = [
  {
    id: 'matte-reader',
    name: 'Matte Reader',
    description: 'Strip sidebars and ads, 65ch measure, clean type.',
    variants: null,
    css: MATTE_READER_CSS,
  },
  {
    id: 'desaturate-chrome',
    name: 'Desaturate Chrome',
    description: 'Dims noisy UI until you hover it.',
    variants: null,
    css: DESATURATE_CSS,
  },
  {
    id: 'surface',
    name: 'Force Paper / Graphite Surface',
    description: 'Clean dark or warm-paper override for unstyled docs.',
    variants: {
      paper: { label: 'Paper', css: PAPER_CSS },
      graphite: { label: 'Graphite', css: GRAPHITE_CSS },
    },
    css: PAPER_CSS,
  },
];

/** Preset CSS for an id + optional variant name, or null. */
function presetCss(presetId, variant) {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;
  if (!preset.variants) return preset.css;
  return (preset.variants[variant === 'graphite' ? 'graphite' : 'paper'] ?? preset.variants.paper).css;
}

/** Display name for a preset id, or null. */
function presetName(presetId) {
  return PRESETS.find((p) => p.id === presetId)?.name ?? null;
}

/* ------------------------------------------------------------------ */
/* Element-Zapper in-page scripts (armed state, no preload involved)     */
/* ------------------------------------------------------------------ */

// Hover outline — the exact §B.9 value, pinned by tests.
const ZAP_OUTLINE = '1px solid rgba(255,255,255,0.35)';

/**
 * Arm script: installs the hover outline and the Alt+Shift+Click capture.
 * Runs in the PAGE (executeJavaScript) — no preload, no background Node
 * timers; the document reload clears everything by itself. Idempotent.
 */
function zapArmScript() {
  return `(function () {
  if (window.__spatialZapArmed === true) return true;
  window.__spatialZapArmed = true;
  window.__spatialZapDisarmed = false;
  delete window.__spatialZapResult;
  var OUTLINE = ${JSON.stringify(ZAP_OUTLINE)};
  var style = document.getElementById('__spatial_zap_style');
  if (!style) {
    style = document.createElement('style');
    style.id = '__spatial_zap_style';
    document.documentElement.appendChild(style);
  }
  style.textContent = '.__spatial-zap-hover{outline:' + OUTLINE
    + ' !important;outline-offset:-1px !important;}'
    + 'html.__spatial-zap-armed *{cursor:crosshair !important;}';
  document.documentElement.classList.add('__spatial-zap-armed');
  var hovered = null;
  var clearHover = function () {
    if (hovered) {
      hovered.classList.remove('__spatial-zap-hover');
      hovered = null;
    }
  };
  var onOver = function (event) {
    var el = event.target;
    if (!el || el.nodeType !== 1) return;
    clearHover();
    hovered = el;
    el.classList.add('__spatial-zap-hover');
  };
  var onOut = function (event) {
    var el = event.target;
    if (el && el.nodeType === 1) el.classList.remove('__spatial-zap-hover');
    if (hovered === el) hovered = null;
  };
  var nthOfType = function (el) {
    if (!el.parentElement) return 1;
    var n = 0;
    for (var i = 0; i < el.parentElement.children.length; i++) {
      if (el.parentElement.children[i].tagName === el.tagName) {
        n++;
        if (el.parentElement.children[i] === el) return n;
      }
    }
    return n;
  };
  var describe = function (el) {
    var chain = [];
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && depth < ${MAX_CHAIN_DEPTH}; depth++, node = node.parentElement) {
      chain.push({
        tag: String(node.tagName || '').toLowerCase(),
        id: typeof node.id === 'string' && node.id ? node.id : null,
        testId: node.getAttribute('data-testid'),
        dataTest: node.getAttribute('data-test'),
        dataQa: node.getAttribute('data-qa'),
        classes: Array.prototype.slice.call(node.classList || []),
        nth: nthOfType(node),
      });
    }
    return { chain: chain };
  };
  var onClick = function (event) {
    if (!(event.altKey === true && event.shiftKey === true)) return;
    var el = event.target;
    if (!el || el.nodeType !== 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    el.style.setProperty('display', 'none', 'important');
    window.__spatialZapResult = describe(el);
  };
  window.addEventListener('mouseover', onOver, true);
  window.addEventListener('mouseout', onOut, true);
  window.addEventListener('click', onClick, true);
  window.__spatialZapTeardown = function () {
    window.removeEventListener('mouseover', onOver, true);
    window.removeEventListener('mouseout', onOut, true);
    window.removeEventListener('click', onClick, true);
    clearHover();
    var st = document.getElementById('__spatial_zap_style');
    if (st) st.remove();
    document.documentElement.classList.remove('__spatial-zap-armed');
    window.__spatialZapArmed = false;
    window.__spatialZapDisarmed = true;
    delete window.__spatialZapTeardown;
    return true;
  };
  return true;
})()`;
}

/** Disarm script: tears the armed listeners down (also unblocks the waiter). */
function zapDisarmScript() {
  return `(function () {
  if (typeof window.__spatialZapTeardown === 'function') return window.__spatialZapTeardown();
  window.__spatialZapDisarmed = true;
  window.__spatialZapArmed = false;
  return true;
})()`;
}

/**
 * Wait script: resolves with the captured descriptor of the next zap, or
 * null on disarm/timeout. The only timer is the in-page poll below, and it
 * exists strictly while the zapper is armed — never in the toggled-off state.
 */
function zapAwaitScript(timeoutMs) {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 120_000;
  return `(function () {
  return new Promise(function (resolve) {
    var started = Date.now();
    var tick = function () {
      if (window.__spatialZapDisarmed === true || window.__spatialZapArmed !== true) return resolve(null);
      if (window.__spatialZapResult) {
        var result = window.__spatialZapResult;
        delete window.__spatialZapResult;
        return resolve(result);
      }
      if (Date.now() - started >= ${timeout}) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
})()`;
}

module.exports = {
  MAX_CSS_LENGTH,
  MAX_SELECTOR_LENGTH,
  MAX_ZAP_SELECTORS,
  MAX_MODS,
  MAX_CHAIN_DEPTH,
  MAX_STRUCTURAL_SEGMENTS,
  ZAP_OUTLINE,
  ZAP_ATTRS,
  hostnameOf,
  normalizeDomainPattern,
  domainPatternMatches,
  sanitizeSelector,
  sanitizeCssText,
  normalizeModRecord,
  buildZapRule,
  compileModCss,
  compileEnabledCss,
  zapModId,
  cssModId,
  presetModId,
  PRESETS,
  presetCss,
  presetName,
  looksHashedClass,
  stableClass,
  idSelector,
  buildResilientSelector,
  zapArmScript,
  zapDisarmScript,
  zapAwaitScript,
};
