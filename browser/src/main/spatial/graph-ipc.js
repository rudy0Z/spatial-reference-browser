'use strict';

// IPC seam for the Spatial graph (Phase 3, spec steps 2–3).
//
// Every `spatial:*` channel is registered through Blanc's trust-wrapped
// `chromeHandle`/`chromeOn` registrars (main.js:11370-11401), which derive
// the window runtime from the sender and refuse unregistered/untrusted
// surfaces — the same gate every chrome:* channel uses. This module is the
// wiring shape only: it takes its registrars and its effect callbacks as
// injected dependencies, so `node --test` can exercise the full contract
// (channel names, payload validation, ordering) without Electron.

const { sanitizeChromeLayout } = require('./canvas-layout');

// Op types the graph model accepts (node-model.applyOp). The IPC layer does a
// shallow type check only; the model remains the authority on semantics.
const OP_TYPES = Object.freeze(new Set([
  'add', 'move', 'patch', 'remove', 'connect', 'activate',
]));

const applyOpShapeCheck = (op) =>
  op && typeof op === 'object' && OP_TYPES.has(op.type)
    ? { ok: true }
    : { ok: false };

const GRAPH_SERVICES = Object.freeze([
  'graph:load',
  'graph:mutate',
  'node:open',
  'node:close',
  'node:navigate',
  'mode:set',
  'chrome:layout',
  'zorder:engage',
  'zorder:release',
  'thumb:store',
]);

/**
 * Build the spatial IPC surface.
 *
 * @param {object} deps
 * @param {(channel: string, handler: Function) => void} deps.chromeHandle  invoke registrar
 * @param {(channel: string, handler: Function) => void} deps.chromeOn     fire-and-forget registrar
 * @param {object} deps.handlers  effect callbacks, each returning a value/promise:
 *   load(), mutate(ops), openNode(uuid), closeNode(uuid), navigate(url),
 *   setMode(mode), setChromeLayout(layout), engageGuard(), releaseGuard(),
 *   storeThumb(uuid, dataUrl)
 * @returns {{ register: () => void, CHANNELS: string[] }}
 */
function createGraphIpc({ chromeHandle, chromeOn, handlers }) {
  if (typeof chromeHandle !== 'function' || typeof chromeOn !== 'function') {
    throw new TypeError('createGraphIpc: chromeHandle and chromeOn are required registrars');
  }
  const h = handlers && typeof handlers === 'object' ? handlers : {};

  // main.js's registrars call handler(event, ...args) — the first argument
  // is the IPC event, the renderer payload is args[1].
  const invoke = (channel, name, validate, effect) => {
    chromeHandle(channel, async (...args) => {
      const payload = args[1];
      if (validate) {
        const checked = validate(payload);
        if (!checked.ok) return { ok: false, error: checked.error ?? 'invalid' };
        return effect ? effect(checked.value) : { ok: true };
      }
      return effect ? effect(payload) : { ok: true };
    });
    void name;
  };

  const send = (channel, validate, effect) => {
    chromeOn(channel, (...args) => {
      const payload = args[1];
      const checked = validate ? validate(payload) : { ok: true, value: payload };
      if (!checked.ok) return;
      if (effect) effect(checked.value);
    });
  };

  // Strict uuid shape (node-model.UUID_PATTERN): hostile or malformed ids
  // never reach the model.
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uuidOr = (value) =>
    (typeof value === 'string' && UUID_PATTERN.test(value) ? value : null);

  const validateOps = (ops) => {
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > 256) {
      return { ok: false, error: 'ops' };
    }
    for (const op of ops) {
      if (!applyOpShapeCheck(op).ok) return { ok: false, error: 'op' };
    }
    return { ok: true, value: ops };
  };

  const validateMode = (payload) => {
    const mode = payload && typeof payload === 'object' ? payload.mode : null;
    if (mode !== 'reading' && mode !== 'canvas') return { ok: false, error: 'mode' };
    return { ok: true, value: mode };
  };

  const validateUuid = (payload) => {
    const uuid = payload && typeof payload === 'object' ? uuidOr(payload.uuid) : null;
    if (!uuid) return { ok: false, error: 'uuid' };
    return { ok: true, value: uuid };
  };

  const validateUrl = (payload) => {
    const url = payload && typeof payload === 'object'
      && typeof payload.url === 'string' && payload.url.length > 0 && payload.url.length <= 4096
      ? payload.url
      : null;
    if (!url) return { ok: false, error: 'url' };
    return { ok: true, value: url };
  };

  const validateLayout = (payload) => {
    const layout = sanitizeChromeLayout(payload);
    return { ok: true, value: layout };
  };

  const validateThumb = (payload) => {
    const uuid = payload && typeof payload === 'object' ? uuidOr(payload.uuid) : null;
    // Chromium encodes canvas WebP as `data:image/webp;quality=0.8;base64,…`
    // — accept the image/webp family with any parameter suffix.
    const dataUrl = payload && typeof payload.dataUrl === 'string'
      && payload.dataUrl.startsWith('data:image/webp')
      && payload.dataUrl.length <= 512 * 1024
      ? payload.dataUrl
      : null;
    if (!uuid || !dataUrl) return { ok: false, error: 'thumb' };
    return { ok: true, value: { uuid, dataUrl } };
  };

  return {
    CHANNELS: GRAPH_SERVICES,
    register() {
      invoke('spatial:graph:load', 'load', null, h.load);
      invoke('spatial:graph:mutate', 'mutate', validateOps, h.mutate);
      invoke('spatial:node:open', 'open', validateUuid, h.openNode);
      invoke('spatial:node:close', 'close', validateUuid, h.closeNode);
      invoke('spatial:node:navigate', 'navigate', validateUrl, h.navigate);
      invoke('spatial:mode:set', 'mode', validateMode, h.setMode);
      send('spatial:chrome:layout', validateLayout, h.setChromeLayout);
      send('spatial:zorder:engage', null, h.engageGuard);
      send('spatial:zorder:release', null, h.releaseGuard);
      send('spatial:thumb:store', validateThumb, h.storeThumb);
    },
  };
}

module.exports = { createGraphIpc, GRAPH_SERVICES };
