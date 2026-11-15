'use strict';

// §B.10 — Toggleable Studio Plugins, PURE model (Phase 3.6).
//
// Everything that needs no Electron, no IPC and no disk lives here so it is
// unit-testable in isolation:
//   - the plugin catalog (ids mirror app/src/lib/plugins.ts — the shell owns
//     labels/descriptions, main owns identity);
//   - the in-page instrumentation scripts for Plugin A (X-Ray) and Plugin C
//     (Shader & Motion HUD), executed via `executeJavaScript` ONLY while the
//     plugin is active (the §B.9 zapper posture — never a page-context
//     preload, so a deactivated plugin leaves zero code in any document);
//   - the media-clip cache policy (Plugin B/C): URL/MIME/size allowlists and
//     extension resolution for `userData/media/` writes;
//   - the device-emulation breakpoint policy (Plugin D).
//
// The Electron-side owner is ./studio-plugins.js; the wiring seam lives in
// spatial-runtime.js initSpatial().

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

const PLUGIN_IDS = Object.freeze(['xray', 'media-clip', 'shader-hud', 'split-compare']);

const isPluginId = (value) => typeof value === 'string' && PLUGIN_IDS.includes(value);

/* ------------------------------------------------------------------ */
/* Plugin D — breakpoint emulation policy                              */
/* ------------------------------------------------------------------ */

const EMULATE_WIDTHS = Object.freeze([1440, 1024, 768, 375]);

/** `null` disables emulation; otherwise only the four preset widths pass. */
function normalizeEmulateWidth(width) {
  if (width === null || width === undefined) return null;
  const value = Math.round(Number(width));
  if (!Number.isFinite(value) || !EMULATE_WIDTHS.includes(value)) return undefined; // undefined = rejected
  return value;
}

/* ------------------------------------------------------------------ */
/* Plugin B/C — media cache policy (userData/media/)                   */
/* ------------------------------------------------------------------ */

const MEDIA_CACHE_MAX_BYTES = 25 * 1024 * 1024;
const MEDIA_MARKUP_MAX_BYTES = 2 * 1024 * 1024;

/** mime → { ext, kind }; first matching prefix wins. */
const MEDIA_MIME_TABLE = Object.freeze([
  { prefix: 'image/png', ext: 'png', kind: 'image' },
  { prefix: 'image/jpeg', ext: 'jpg', kind: 'image' },
  { prefix: 'image/webp', ext: 'webp', kind: 'image' },
  { prefix: 'image/gif', ext: 'gif', kind: 'image' },
  { prefix: 'image/svg', ext: 'svg', kind: 'svg' },
  { prefix: 'video/webm', ext: 'webm', kind: 'video' },
  { prefix: 'video/mp4', ext: 'mp4', kind: 'video' },
]);

const MEDIA_URL_MAX = 4096;

/**
 * Validate a Drag-to-Clip request from the shell. Either:
 *   - a remote source URL (http/https) whose response MIME must be
 *     allow-listed at fetch time; or
 *   - inline SVG markup (no src) captured from an `<svg>` drag, stored as-is
 *     (capped, string-scanned for basic sanity — main writes it as `.svg`).
 * Returns `{ ok, req }` or `{ ok: false, error }`.
 */
function normalizeClipRequest(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'shape' };
  const mediaKind = typeof input.mediaKind === 'string' ? input.mediaKind : null;
  if (mediaKind !== 'image' && mediaKind !== 'video' && mediaKind !== 'svg') return { ok: false, error: 'kind' };

  const src = typeof input.src === 'string' && input.src.length <= MEDIA_URL_MAX ? input.src.trim() : '';
  let sourcePageUrl = typeof input.sourcePageUrl === 'string' && input.sourcePageUrl.length <= MEDIA_URL_MAX
    ? input.sourcePageUrl.trim()
    : null;
  if (sourcePageUrl === '') sourcePageUrl = null;

  if (src !== '') {
    let parsed;
    try {
      parsed = new URL(src);
    } catch {
      return { ok: false, error: 'src-url' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'src-protocol' };
    return { ok: true, req: { kind: mediaKind, src, sourcePageUrl, markup: null } };
  }

  // No src: only inline SVG drags may carry their own markup.
  if (mediaKind !== 'svg') return { ok: false, error: 'src' };
  const markup = typeof input.markup === 'string' ? input.markup : '';
  const bytes = Buffer.byteLength(markup, 'utf8');
  if (markup === '' || bytes > MEDIA_MARKUP_MAX_BYTES) return { ok: false, error: 'markup' };
  if (!/<svg[\s>]/i.test(markup) || /<script[\s>]/i.test(markup)) return { ok: false, error: 'markup-shape' };
  return { ok: true, req: { kind: mediaKind, src: '', sourcePageUrl, markup } };
}

/** mime → on-disk extension via the allowlist; null when the mime is refused. */
function extForMime(mime) {
  const value = String(mime || '').toLowerCase().split(';')[0].trim();
  for (const entry of MEDIA_MIME_TABLE) {
    if (value.startsWith(entry.prefix)) return entry.ext;
  }
  return null;
}

/** kind implied by an extension (cross-check against the shell's declared kind). */
function kindForExt(ext) {
  const value = String(ext || '').toLowerCase();
  for (const entry of MEDIA_MIME_TABLE) {
    if (entry.ext === value) return entry.kind;
  }
  return null;
}

const WEBM_PREVIEW_BYTES_MAX = 20 * 1024 * 1024;

/** Validate a Plugin C WebM preview store request (base64 payload). */
function normalizeWebmStoreRequest(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'shape' };
  const base64 = typeof input.bytes === 'string' ? input.bytes : '';
  if (base64 === '' || base64.length > Math.ceil((WEBM_PREVIEW_BYTES_MAX * 4) / 3) + 4) {
    return { ok: false, error: 'bytes' };
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return { ok: false, error: 'base64' };
  let sourcePageUrl = typeof input.sourcePageUrl === 'string' && input.sourcePageUrl.length <= MEDIA_URL_MAX
    ? input.sourcePageUrl.trim()
    : null;
  if (sourcePageUrl === '') sourcePageUrl = null;
  return { ok: true, req: { base64, sourcePageUrl } };
}

/* ------------------------------------------------------------------ */
/* Plugin A — X-Ray in-page scripts                                    */
/* ------------------------------------------------------------------ */

const XRAY_FLAG = '__spatialXrayArmed';
const XRAY_RESULT = '__spatialXrayResult';
const XRAY_STYLE_ID = '__spatial_xray_style';
const XRAY_HUD_ID = '__spatial_xray_hud';

/**
 * Arm the X-Ray on one document: hover → matte HUD pill (#18181C, 1px
 * hairline) with the resolved @font-face family, weight/size/line-height/
 * letter-spacing, text+background colors in HEX and OKLCH, and the computed
 * transition/cubic-bezier. Click-to-capture stores the snapshot in
 * `window.__spatialXrayResult` (consumed by `xrayAwaitScript`, which main
 * resolves and forwards to the shell → StickyNote). Idempotent per document.
 */
function xrayArmScript() {
  return `(function () {
  if (window[${JSON.stringify(XRAY_FLAG)}] === true) return true;
  window[${JSON.stringify(XRAY_FLAG)}] = true;
  delete window[${JSON.stringify(XRAY_RESULT)}];

  var STYLE_ID = ${JSON.stringify(XRAY_STYLE_ID)};
  var HUD_ID = ${JSON.stringify(XRAY_HUD_ID)};
  var style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.documentElement.appendChild(style);
  }
  style.textContent = '#' + HUD_ID + '{position:fixed;z-index:2147483646;pointer-events:none;'
    + 'max-width:340px;padding:8px 10px;border-radius:10px;'
    + 'background:#18181C;border:1px solid rgba(255,255,255,0.10);'
    + 'box-shadow:0 8px 24px rgba(0,0,0,0.35);'
    + "font:400 11px/1.45 -apple-system,'Segoe UI',Inter,sans-serif;"
    + 'color:#E8E8EA;letter-spacing:0;white-space:nowrap;overflow:hidden;'
    + 'transition:opacity 120ms ease;opacity:0;}'
    + '#' + HUD_ID + ' .row{display:flex;gap:6px;align-items:baseline;}'
    + '#' + HUD_ID + ' .k{color:#9A9AA2;min-width:64px;}'
    + '#' + HUD_ID + ' .v{color:#E8E8EA;font-variant-numeric:tabular-nums;}'
    + '#' + HUD_ID + ' .hint{display:block;margin-top:4px;color:#9A9AA2;}';

  var hud = document.getElementById(HUD_ID);
  if (!hud) {
    hud = document.createElement('div');
    hud.id = HUD_ID;
    document.documentElement.appendChild(hud);
  }

  function faceFamilies() {
    var names = new Set();
    try {
      for (var i = 0; i < document.styleSheets.length; i++) {
        var rules;
        try { rules = document.styleSheets[i].cssRules; } catch (e) { continue; }
        if (!rules) continue;
        for (var r = 0; r < rules.length; r++) {
          var rule = rules[r];
          if (rule && rule.type === 5 /* CSSFontFaceRule */ && rule.style && rule.style.getPropertyValue('font-family')) {
            names.add(rule.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '').toLowerCase());
          }
        }
      }
    } catch (e) { /* cross-origin sheets are simply absent */ }
    return names;
  }
  var faces = faceFamilies();
  try { document.fonts && document.fonts.ready && document.fonts.ready.then(function () { faces = faceFamilies(); }); } catch (e) {}

  function rgbToOklch(r, g, b) {
    function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    var rl = lin(r), gl = lin(g), bl = lin(b);
    var l_ = 0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl;
    var m_ = 0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl;
    var s_ = 0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl;
    var l = Math.cbrt(l_), m = Math.cbrt(m_), s = Math.cbrt(s_);
    var L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    var A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    var B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    var C = Math.sqrt(A * A + B * B);
    var H = Math.atan2(B, A) * 180 / Math.PI;
    if (H < 0) H += 360;
    return { L: L, C: C, H: H };
  }
  function toHex(r, g, b) {
    function hx(c) { return Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0'); }
    return '#' + hx(r) + hx(g) + hx(b);
  }
  function colorPair(css) {
    if (!css || css === 'transparent') return css;
    var m = /rgba?\\(\\s*([\\d.]+)[\\s,]+([\\d.]+)[\\s,]+([\\d.]+)(?:[\\s,\\/]+([\\d.]+))?\\s*\\)/.exec(css);
    if (!m) return css;
    var r = +m[1], g = +m[2], b = +m[3], a = m[4] !== undefined ? +m[4] : 1;
    var ok = rgbToOklch(r, g, b);
    var okStr = 'oklch(' + (ok.L * 100).toFixed(1) + '% ' + ok.C.toFixed(4) + ' ' + ok.H.toFixed(1) + ')'
      + (a < 1 ? ' / ' + a.toFixed(2) : '');
    return toHex(r, g, b) + ' · ' + okStr;
  }
  function shortSelector(el) {
    var out = el.tagName.toLowerCase();
    if (el.id) return out + '#' + el.id;
    if (el.classList && el.classList.length) out += '.' + String(el.classList[0]).slice(0, 24);
    return out;
  }

  var current = null, pending = false;
  function render(el, x, y) {
    var cs = getComputedStyle(el);
    var stack = cs.fontFamily || '';
    var resolved = null;
    var first = stack.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
    if (first && faces.has(first)) resolved = first;
    else {
      for (var part of stack.split(',')) {
        var name = part.trim().replace(/^["']|["']$/g, '').toLowerCase();
        if (faces.has(name)) { resolved = name; break; }
      }
    }
    var bez = /cubic-bezier\\([^)]*\\)/.exec(cs.transition || '');
    var rows = [
      ['family', (resolved ? '"' + resolved + '"' : stack.split(',')[0])],
      ['weight', cs.fontWeight + ' · ' + cs.fontSize + ' / ' + cs.lineHeight],
      ['spacing', cs.letterSpacing === 'normal' ? 'normal' : cs.letterSpacing],
      ['text', colorPair(cs.color)],
      ['bg', colorPair(cs.backgroundColor)],
      ['motion', cs.transition === 'none' || !cs.transition ? 'none' : (bez ? cs.transition + ' — ' + bez[0] : cs.transition)],
    ];
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      html += '<div class="row"><span class="k">' + rows[i][0] + '</span><span class="v">' + String(rows[i][1]).slice(0, 60) + '</span></div>';
    }
    html += '<span class="hint">' + shortSelector(el) + ' — click to capture</span>';
    hud.innerHTML = html;
    var w = hud.offsetWidth || 280, h = hud.offsetHeight || 96;
    var px = Math.min(x + 14, window.innerWidth - w - 8);
    var py = Math.min(y + 14, window.innerHeight - h - 8);
    hud.style.left = Math.max(8, px) + 'px';
    hud.style.top = Math.max(8, py) + 'px';
    hud.style.opacity = '1';

    current = {
      selector: shortSelector(el),
      fontFamily: stack,
      resolvedFamily: resolved,
      fontWeight: cs.fontWeight,
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      transition: cs.transition || 'none',
      easing: bez ? bez[0] : null,
      url: location.href,
    };
  }

  function onMove(event) {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      var el = event && event.target && event.target.nodeType === 1 ? event.target : null;
      if (!el || el === hud) { hud.style.opacity = '0'; current = null; return; }
      render(el, event.clientX, event.clientY);
    });
  }
  function onLeave() { hud.style.opacity = '0'; }
  function onClick(event) {
    if (!current) return;
    event.preventDefault();
    event.stopPropagation();
    window[${JSON.stringify(XRAY_RESULT)}] = current;
    hud.style.opacity = '0';
    current = null;
  }
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseleave', onLeave, true);
  document.addEventListener('click', onClick, true);
  window[${JSON.stringify(XRAY_FLAG)}] = true;
  window.__spatialXrayTeardown = function () {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseleave', onLeave, true);
    document.removeEventListener('click', onClick, true);
    var s = document.getElementById(STYLE_ID); if (s) s.remove();
    var h = document.getElementById(HUD_ID); if (h) h.remove();
    delete window[${JSON.stringify(XRAY_FLAG)}];
    delete window[${JSON.stringify(XRAY_RESULT)}];
    delete window.__spatialXrayTeardown;
  };
  return true;
})()`;
}

/** One waiter: resolves the captured snapshot on click, null on timeout/disarm. */
function xrayAwaitScript(timeoutMs) {
  const limit = Number.isFinite(timeoutMs) ? Math.max(1000, Math.round(timeoutMs)) : 120000;
  return `(async function () {
  var FLAG = ${JSON.stringify(XRAY_RESULT)};
  var ARMED = ${JSON.stringify(XRAY_FLAG)};
  var deadline = Date.now() + ${limit};
  while (Date.now() < deadline) {
    if (window[ARMED] !== true) return null; // disarmed while waiting
    if (window[FLAG]) {
      var snap = window[FLAG];
      delete window[FLAG];
      return snap || null;
    }
    await new Promise(function (r) { setTimeout(r, 120); });
  }
  return null;
})()`;
}

function xrayTeardownScript() {
  return `(function () {
  if (typeof window.__spatialXrayTeardown === 'function') { window.__spatialXrayTeardown(); return true; }
  var s = document.getElementById(${JSON.stringify(XRAY_STYLE_ID)}); if (s) s.remove();
  var h = document.getElementById(${JSON.stringify(XRAY_HUD_ID)}); if (h) h.remove();
  delete window[${JSON.stringify(XRAY_FLAG)}];
  delete window[${JSON.stringify(XRAY_RESULT)}];
  return true;
})()`;
}

/* ------------------------------------------------------------------ */
/* Plugin C — Shader & Motion HUD in-page scripts                      */
/* ------------------------------------------------------------------ */

const SHADER_FLAG = '__spatialShaderHudArmed';
const SHADER_PANEL_ID = '__spatial_shader_hud';

/**
 * Arm the Shader & Motion HUD on one document: a matte panel enumerating
 * every `<canvas>` with context type (2d/webgl2/webgl/webgpu), pixel
 * resolution and CSS size, plus a shared rAF frame-time probe (ms + fps)
 * refreshed every 2.5 s while armed. Torn down by `shaderHudTeardownScript`.
 */
function shaderHudArmScript() {
  return `(function () {
  if (window[${JSON.stringify(SHADER_FLAG)}] === true) return true;
  window[${JSON.stringify(SHADER_FLAG)}] = true;

  var PANEL_ID = ${JSON.stringify(SHADER_PANEL_ID)};
  var style = document.createElement('style');
  style.id = PANEL_ID + '_style';
  style.textContent = '#' + PANEL_ID + '{position:fixed;left:12px;bottom:12px;z-index:2147483646;'
    + 'min-width:220px;max-width:320px;padding:8px 10px;border-radius:10px;'
    + 'background:#18181C;border:1px solid rgba(255,255,255,0.10);box-shadow:0 8px 24px rgba(0,0,0,0.35);'
    + "font:400 11px/1.5 -apple-system,'Segoe UI',Inter,sans-serif;color:#E8E8EA;}"
    + '#' + PANEL_ID + ' h6{margin:0 0 4px;font-size:10px;font-weight:500;color:#9A9AA2;letter-spacing:0.02em;}'
    + '#' + PANEL_ID + ' .row{display:flex;gap:6px;justify-content:space-between;font-variant-numeric:tabular-nums;}'
    + '#' + PANEL_ID + ' .row span:first-child{color:#E8E8EA;}'
    + '#' + PANEL_ID + ' .row span:last-child{color:#9A9AA2;}'
    + '#' + PANEL_ID + ' .empty{color:#9A9AA2;}';
  document.documentElement.appendChild(style);

  var panel = document.createElement('div');
  panel.id = PANEL_ID;
  document.documentElement.appendChild(panel);

  function detectContext(c) {
    var kinds = [['2d', '2d'], ['webgl2', 'webgl2'], ['webgl', 'webgl1'], ['webgpu', 'webgpu']];
    for (var i = 0; i < kinds.length; i++) {
      try { if (c.getContext(kinds[i][0])) return kinds[i][1]; } catch (e) { /* context lost / denied */ }
    }
    return 'none';
  }
  function snapshot() {
    var canvases = Array.prototype.slice.call(document.querySelectorAll('canvas'));
    return {
      canvases: canvases.slice(0, 12).map(function (c) {
        var rect = c.getBoundingClientRect();
        return {
          w: c.width, h: c.height,
          cssW: Math.round(rect.width), cssH: Math.round(rect.height),
          ctx: detectContext(c),
        };
      }),
      frameMs: lastProbeMs, fps: lastProbeFps,
      url: location.href,
    };
  }
  var lastProbeMs = null, lastProbeFps = null;
  function probe() {
    var samples = [], last = performance.now(), n = 0;
    function tick(now) {
      samples.push(now - last); last = now;
      if (++n < 12) requestAnimationFrame(tick);
      else {
        var avg = samples.slice(1).reduce(function (a, b) { return a + b; }, 0) / Math.max(1, samples.length - 1);
        lastProbeMs = avg;
        lastProbeFps = avg > 0 ? Math.min(240, Math.round(1000 / avg)) : null;
      }
    }
    requestAnimationFrame(tick);
  }
  function render() {
    var data = snapshot();
    var html = '<h6>Shader & Motion HUD</h6>';
    html += '<div class="row"><span>frame</span><span>' + (data.frameMs != null ? data.frameMs.toFixed(2) + ' ms · ' + data.fps + ' fps' : 'probing…') + '</span></div>';
    if (!data.canvases.length) {
      html += '<div class="empty">No canvas elements on this page.</div>';
    } else {
      for (var i = 0; i < data.canvases.length; i++) {
        var c = data.canvases[i];
        html += '<div class="row"><span>' + c.ctx + ' · ' + c.w + '×' + c.h + 'px</span><span>' + c.cssW + '×' + c.cssH + ' css</span></div>';
      }
    }
    panel.innerHTML = html;
  }
  function schedule() { render(); probe(); }
  schedule();
  var timer = setInterval(schedule, 2500);
  window.__spatialShaderHudTeardown = function () {
    clearInterval(timer);
    panel.remove();
    style.remove();
    delete window[${JSON.stringify(SHADER_FLAG)}];
    delete window.__spatialShaderHudTeardown;
  };
  return true;
})()`;
}

function shaderHudTeardownScript() {
  return `(function () {
  if (typeof window.__spatialShaderHudTeardown === 'function') { window.__spatialShaderHudTeardown(); return true; }
  var p = document.getElementById(${JSON.stringify(SHADER_PANEL_ID)}); if (p) p.remove();
  var s = document.getElementById(${JSON.stringify(SHADER_PANEL_ID)} + '_style'); if (s) s.remove();
  delete window[${JSON.stringify(SHADER_FLAG)}];
  return true;
})()`;
}

module.exports = {
  PLUGIN_IDS,
  isPluginId,
  EMULATE_WIDTHS,
  normalizeEmulateWidth,
  MEDIA_CACHE_MAX_BYTES,
  MEDIA_MARKUP_MAX_BYTES,
  normalizeClipRequest,
  normalizeWebmStoreRequest,
  extForMime,
  kindForExt,
  xrayArmScript,
  xrayAwaitScript,
  xrayTeardownScript,
  shaderHudArmScript,
  shaderHudTeardownScript,
};
