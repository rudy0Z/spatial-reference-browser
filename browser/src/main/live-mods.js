'use strict';

// §B.9 — Zero-Extension "Live Mods" engine (main-process wiring).
//
// Pure policy lives in ./spatial/live-mods-model.js (domain matching, the
// compiled-CSS shape, resilient zap selectors, the in-page zapper scripts).
// This file owns:
//   - persistence: mod records ride the SAME spatial-graph JsonStore the
//     node graph persists to (`data.mods`) — mod state survives restarts
//     with the graph, exactly as §B.9 asks;
//   - trust-gated IPC: every `spatial:mods:*` / `spatial:zap:*` channel is
//     registered through main.js's chromeHandle/chromeOn registrars — no
//     mod state ever crosses a raw ipcMain surface;
//   - per-view injection: on `dom-ready` and `did-navigate-in-page` of an
//     attached WebContentsView the enabled, domain-matching mods are
//     compiled and injected with `insertCSS(compiled, { cssOrigin: 'user'
//     })`; toggling off (or removing a mod) removes exactly its stylesheets
//     via `removeInsertedCSS(key)`;
//   - the armed Element Zapper: /zap arms the ACTIVE view (hover outline +
//     Alt+Shift+Click capture, installed by executeJavaScript — never a
//     preload); each click's descriptor is compiled into a resilient
//     selector and saved to the domain's zapSelectors[].
//
// §B.0 zero-cost law: with the zapper disarmed and mods toggled off there
// are no timers, no preloads and no injected stylesheets — only the reactive
// dom-ready/did-navigate-in-page listeners that keep armed views covered.

const {
  MAX_CSS_LENGTH,
  MAX_MODS,
  MAX_ZAP_SELECTORS,
  normalizeModRecord,
  normalizeDomainPattern,
  domainPatternMatches,
  hostnameOf,
  sanitizeSelector,
  sanitizeCssText,
  buildResilientSelector,
  compileModCss,
  zapModId,
  cssModId,
  presetModId,
  presetCss,
  presetName,
  PRESETS,
  zapArmScript,
  zapDisarmScript,
  zapAwaitScript,
} = require('./spatial/live-mods-model');

// The in-page zap waiter re-arms on this cadence while the zapper stays
// armed; a timed-out waiter resolves null and the loop simply re-awaits.
const ZAP_WAIT_MS = 120_000;
// Macrotask yield between zap waits (microtask-famine guard, see zapLoop).
const ZAP_LOOP_YIELD_MS = 50;

// Mod ids are model-validated, but the IPC layer gates the raw string first.
const MOD_ID_PATTERN = /^[a-z][\w:@.\-]{0,79}$/i;

/**
 * Build the Live Mods engine.
 *
 * @param {object} deps
 * @param {(channel: string, handler: Function) => void} deps.chromeHandle  invoke registrar (trust-gated)
 * @param {(channel: string, handler: Function) => void} deps.chromeOn     fire-and-forget registrar (trust-gated)
 * @param {object} deps.store          the spatial-graph JsonStore (shared persistence)
 * @param {() => {tabId: number, wc: object} | null} deps.getActiveView  the focused runtime's active live view
 * @param {() => Array<{tabId: number, wc: object}>} deps.iterViews     every live view across runtimes
 * @param {(channel: string, payload: object) => void} deps.notifyShell  push to every spatial shell document
 */
function createLiveMods({ chromeHandle, chromeOn, store, getActiveView, iterViews, notifyShell }) {
  if (typeof chromeHandle !== 'function' || typeof chromeOn !== 'function') {
    throw new TypeError('createLiveMods: chromeHandle and chromeOn are required registrars');
  }
  if (!store || typeof store.update !== 'function') {
    throw new TypeError('createLiveMods: a JsonStore is required');
  }
  if (typeof getActiveView !== 'function' || typeof notifyShell !== 'function') {
    throw new TypeError('createLiveMods: getActiveView and notifyShell are required');
  }
  const iter = typeof iterViews === 'function' ? iterViews : () => [];

  /* ---- persistence (shared spatial-graph store, `data.mods`) ---- */

  const readMods = () => {
    const raw = Array.isArray(store.data?.mods) ? store.data.mods : [];
    const out = [];
    for (const item of raw) {
      const mod = normalizeModRecord(item);
      if (mod) out.push(mod);
    }
    return out;
  };
  const writeMods = (mods) => {
    store.update((data) => { data.mods = mods; });
  };
  const broadcastMods = () => {
    notifyShell('spatial:mods:updated', { mods: readMods(), zapArmed: zap.armed });
  };
  const notifyZap = () => {
    notifyShell('spatial:zap:changed', { armed: zap.armed });
  };

  /* ---- attached views & stylesheet bookkeeping ---- */

  const views = new Map(); // tabId → { tabId, wc, keysByModId: Map, zapLoopRunning }
  const zap = { armed: false };

  const wcAlive = (view) => !!view.wc && !view.wc.isDestroyed?.();
  const currentUrl = (view) => {
    try { return view.wc.getURL() || ''; } catch { return ''; }
  };

  /** Inject one compiled mod stylesheet; its key is tracked for removal. */
  function injectModIntoView(view, mod) {
    if (!wcAlive(view)) return;
    const compiled = compileModCss(mod);
    if (!compiled) return;
    view.wc.insertCSS(compiled, { cssOrigin: 'user' })
      .then((key) => {
        if (typeof key === 'string' && key) {
          const keys = view.keysByModId.get(mod.id) ?? [];
          keys.push(key);
          view.keysByModId.set(mod.id, keys);
        }
      })
      .catch(() => { /* renderer navigated mid-insert */ });
  }

  /** Remove exactly one mod's stylesheets from one view. */
  function removeModKeys(view, modId) {
    const keys = view.keysByModId.get(modId);
    if (!keys) return;
    view.keysByModId.delete(modId);
    for (const key of keys) {
      try { view.wc.removeInsertedCSS(key).catch(() => {}); } catch { /* dead renderer */ }
    }
  }

  const removeAllKeys = (view) => {
    for (const modId of [...view.keysByModId.keys()]) removeModKeys(view, modId);
  };

  const matchingModsFor = (url) => (url
    ? readMods().filter((m) => m.enabled && domainPatternMatches(m.domainPattern, url))
    : []);

  /**
   * Bring one view's injected stylesheets in line with the enabled mods
   * matching its CURRENT url. `fresh` (dom-ready: new document) drops every
   * tracked key first; otherwise (did-navigate-in-page: same document) only
   * the delta moves, so an SPA route change never flickers zapped elements.
   */
  function reinjectView(view, { fresh }) {
    if (!wcAlive(view)) { views.delete(view.tabId); return; }
    const matching = matchingModsFor(currentUrl(view));
    const keep = new Set(matching.map((m) => m.id));
    for (const modId of [...view.keysByModId.keys()]) {
      if (fresh || !keep.has(modId)) removeModKeys(view, modId);
    }
    for (const mod of matching) {
      if (!view.keysByModId.has(mod.id)) injectModIntoView(view, mod);
    }
  }

  /** Push one mod record's current compile into every attached view. */
  function applyModToViews(mod) {
    for (const view of views.values()) {
      if (!wcAlive(view)) { views.delete(view.tabId); continue; }
      if (mod.enabled && domainPatternMatches(mod.domainPattern, currentUrl(view))) {
        removeModKeys(view, mod.id);
        injectModIntoView(view, mod);
      } else {
        removeModKeys(view, mod.id);
      }
    }
  }

  /**
   * Register a live view for injection + zap coverage. Called by the spatial
   * runtime when a view is created (wireGraphNodeSync) or woken
   * (ensureLiveView wake path). Injects immediately: the page may already be
   * loaded. Dead views are pruned lazily on every pass.
   */
  function attachView(tabId, wc) {
    if (!wc || tabId == null) return; // tab ids are UUID strings in this fork
    let view = views.get(tabId);
    if (view && view.wc === wc) return; // already wired
    if (view) view.wc = wc; // tab's webContents was recreated after wake
    else {
      view = { tabId, wc, keysByModId: new Map(), zapLoopRunning: false };
      views.set(tabId, view);
    }
    view.wc.on('dom-ready', () => {
      reinjectView(view, { fresh: true }); // §B.9 — survives reload
      if (zap.armed) armView(view);
    });
    view.wc.on('did-navigate-in-page', () => reinjectView(view, { fresh: false }));
    reinjectView(view, { fresh: true });
  }

  /** Drop a view's tracking and stylesheets (tab closing or discarded). */
  function forgetView(tabId) {
    const view = views.get(tabId);
    if (!view) return;
    removeAllKeys(view);
    views.delete(tabId);
  }

  /* ---- Element Zapper (§B.9) ---- */

  function armView(view) {
    if (!wcAlive(view)) return;
    view.wc.executeJavaScript(zapArmScript(), true).catch(() => {});
    if (!view.zapLoopRunning) {
      view.zapLoopRunning = true;
      void zapLoop(view);
    }
  }

  /**
   * One waiter per armed view: resolves with a captured descriptor on every
   * Alt+Shift+Click, null on disarm/timeout, and ends when the renderer dies
   * (a navigation destroys the JS context; dom-ready re-arms while armed).
   */
  async function zapLoop(view) {
    while (zap.armed && wcAlive(view)) {
      try {
        const descriptor = await view.wc.executeJavaScript(zapAwaitScript(ZAP_WAIT_MS), true);
        if (!zap.armed) break;
        if (descriptor && typeof descriptor === 'object') {
          const selector = buildResilientSelector(descriptor);
          if (selector) saveZapSelector(currentUrl(view), selector);
        }
        // Yield to macrotasks between waits: a same-tick resolution must
        // never turn this loop into a microtask famine (timers, IPC, saves).
        await new Promise((resolve) => setTimeout(resolve, ZAP_LOOP_YIELD_MS));
      } catch { break; }
    }
    view.zapLoopRunning = false;
  }

  /** Append a zap selector to the domain's zap record; hide it everywhere. */
  function saveZapSelector(url, selector) {
    const domain = hostnameOf(url);
    if (!domain) return;
    const mods = readMods();
    let mod = mods.find((m) => m.id === zapModId(domain));
    if (!mod) {
      if (mods.length >= MAX_MODS) return;
      mod = normalizeModRecord({
        id: zapModId(domain),
        domainPattern: domain,
        name: 'Element zaps',
        enabled: true,
        css: '',
        zapSelectors: [],
      });
      if (!mod) return;
      mods.push(mod);
    }
    if (!mod.zapSelectors.includes(selector)) {
      if (mod.zapSelectors.length >= MAX_ZAP_SELECTORS) mod.zapSelectors.shift();
      mod.zapSelectors.push(selector);
    }
    writeMods(mods);
    applyModToViews(mod); // hide immediately in every matching view
    broadcastMods();
  }

  /** /zap toggle — arms the ACTIVE view's Alt+Shift+Click capture. */
  function armZapper() {
    if (zap.armed) return { ok: true, armed: true };
    const target = getActiveView();
    if (!target?.wc || target.wc.isDestroyed?.()) return { ok: false, error: 'no-view' };
    zap.armed = true;
    let view = views.get(target.tabId);
    if (!view) {
      attachView(target.tabId, target.wc);
      view = views.get(target.tabId);
    }
    if (view) armView(view);
    notifyZap();
    return { ok: true, armed: true };
  }

  function disarmZapper() {
    if (!zap.armed) return { ok: true, armed: false };
    zap.armed = false;
    for (const view of views.values()) {
      view.zapLoopRunning = false; // the waiter exits via the disarm flag
      if (wcAlive(view)) {
        view.wc.executeJavaScript(zapDisarmScript(), true).catch(() => {});
      }
    }
    notifyZap();
    return { ok: true, armed: false };
  }

  /* ---- mod mutations ---- */

  function setModEnabled(id, enabled) {
    const mods = readMods();
    const mod = mods.find((m) => m.id === id);
    if (!mod) return { ok: false, error: 'missing' };
    mod.enabled = enabled === true;
    writeMods(mods);
    applyModToViews(mod);
    broadcastMods();
    return { ok: true };
  }

  /** Upsert the domain-scoped CSS scratchpad record (`css:<domain>`). */
  function setDomainCss(domain, cssText) {
    const pattern = normalizeDomainPattern(domain);
    if (!pattern) return { ok: false, error: 'domain' };
    const css = sanitizeCssText(cssText);
    const id = cssModId(pattern);
    const mods = readMods();
    let mod = mods.find((m) => m.id === id);
    if (!mod) {
      if (mods.length >= MAX_MODS) return { ok: false, error: 'limit' };
      mod = normalizeModRecord({
        id,
        domainPattern: pattern,
        name: 'Custom CSS',
        enabled: true,
        css,
        zapSelectors: [],
      });
      if (!mod) return { ok: false, error: 'invalid' };
      mods.push(mod);
    } else {
      mod.css = css;
    }
    writeMods(mods);
    applyModToViews(mod);
    broadcastMods();
    return { ok: true };
  }

  /** Upsert a one-click preset record for a domain (`preset:<id>:<domain>`). */
  function applyPreset(domain, presetId, variant) {
    const pattern = normalizeDomainPattern(domain);
    if (!pattern) return { ok: false, error: 'domain' };
    const css = presetCss(presetId, variant);
    if (!css) return { ok: false, error: 'preset' };
    const id = presetModId(presetId, pattern);
    if (!id) return { ok: false, error: 'preset' };
    const mods = readMods();
    let mod = mods.find((m) => m.id === id);
    if (!mod) {
      if (mods.length >= MAX_MODS) return { ok: false, error: 'limit' };
      mod = normalizeModRecord({
        id,
        domainPattern: pattern,
        name: presetName(presetId) ?? 'Preset',
        enabled: true,
        css,
        zapSelectors: [],
      });
      if (!mod) return { ok: false, error: 'invalid' };
      mods.push(mod);
    } else {
      mod.css = css;
      mod.enabled = true;
    }
    writeMods(mods);
    applyModToViews(mod);
    broadcastMods();
    return { ok: true };
  }

  function removeMod(id) {
    const mods = readMods();
    const index = mods.findIndex((m) => m.id === id);
    if (index === -1) return { ok: false, error: 'missing' };
    mods.splice(index, 1);
    writeMods(mods);
    for (const view of views.values()) removeModKeys(view, id);
    broadcastMods();
    return { ok: true };
  }

  /** Drop one zap selector; the record dies with its last content. */
  function removeZapSelector(id, selector) {
    const mods = readMods();
    const mod = mods.find((m) => m.id === id);
    if (!mod) return { ok: false, error: 'missing' };
    const cleaned = sanitizeSelector(selector);
    if (!cleaned || !mod.zapSelectors.includes(cleaned)) return { ok: false, error: 'invalid' };
    mod.zapSelectors = mod.zapSelectors.filter((s) => s !== cleaned);
    if (!mod.zapSelectors.length && !mod.css) mods.splice(mods.indexOf(mod), 1);
    writeMods(mods);
    const alive = mods.includes(mod);
    if (alive) applyModToViews(mod);
    else for (const view of views.values()) removeModKeys(view, id);
    broadcastMods();
    return { ok: true };
  }

  /* ---- trust-gated IPC surface ---- */

  const modIdOr = (value) => (typeof value === 'string' && MOD_ID_PATTERN.test(value) ? value : null);
  const domainArg = (payload) => {
    const raw = payload && typeof payload.domain === 'string' ? payload.domain : '';
    return normalizeDomainPattern(raw);
  };

  const register = () => {
    chromeHandle('spatial:mods:list', () => ({
      ok: true,
      mods: readMods(),
      zapArmed: zap.armed,
      presets: PRESETS.map(({ id, name, description, variants }) => ({
        id,
        name,
        description,
        variants: variants ? Object.keys(variants) : null,
      })),
    }));

    chromeHandle('spatial:mods:set-enabled', (...args) => {
      const payload = args[1];
      const id = payload ? modIdOr(payload.id) : null;
      if (!id) return { ok: false, error: 'invalid' };
      return setModEnabled(id, payload?.enabled === true);
    });

    chromeHandle('spatial:mods:set-css', (...args) => {
      const payload = args[1];
      const domain = domainArg(payload);
      if (!domain) return { ok: false, error: 'domain' };
      const css = payload && typeof payload.css === 'string' ? payload.css : null;
      if (css == null || css.length > MAX_CSS_LENGTH) return { ok: false, error: 'invalid' };
      return setDomainCss(domain, css);
    });

    chromeHandle('spatial:mods:apply-preset', (...args) => {
      const payload = args[1];
      const domain = domainArg(payload);
      const presetId = payload && typeof payload.presetId === 'string' ? payload.presetId : '';
      const variant = payload && typeof payload.variant === 'string' ? payload.variant : null;
      if (!domain) return { ok: false, error: 'domain' };
      return applyPreset(domain, presetId, variant);
    });

    chromeHandle('spatial:mods:remove', (...args) => {
      const payload = args[1];
      const id = payload ? modIdOr(payload.id) : null;
      if (!id) return { ok: false, error: 'invalid' };
      return removeMod(id);
    });

    chromeHandle('spatial:mods:zap-remove', (...args) => {
      const payload = args[1];
      const id = payload ? modIdOr(payload.id) : null;
      const selector = payload && typeof payload.selector === 'string' ? payload.selector : null;
      if (!id || !selector) return { ok: false, error: 'invalid' };
      return removeZapSelector(id, selector);
    });

    chromeHandle('spatial:zap:arm', () => armZapper());
    chromeHandle('spatial:zap:disarm', () => disarmZapper());
  };

  return {
    register,
    attachView,
    forgetView,
    reinjectAll: () => {
      for (const view of views.values()) reinjectView(view, { fresh: false });
    },
  };
}

module.exports = { createLiveMods, ZAP_WAIT_MS };
