'use strict';

// §B.8 — the Spatial shell plumbing bridge (main ⇄ blanc-chrome:// shell).
//
// Senders (main → shell document):
//   spatial:shell:shortcut      — §B.8.1 arbitrated shell shortcuts
//   spatial:external:confirm    — §B.8.2 external-app handoff confirmation
//   spatial:downloads:updated   — §B.8.5 download progress surface
//   spatial:find:result         — matte find bar match counts
//   spatial:permission:request  — matte permission prompt
//
// Receiver channels (registered through the SAME trust-gated registrars as
// the graph seam — graph-ipc.js) invoke into effects injected from main.js:
//   spatial:external:respond    — toast answer → shell.openExternal
//   spatial:downloads:list      — sanitized snapshot for the ⌘J surface
//   spatial:downloads:action    — cancel/resume/retry/open/show/clear
//   spatial:find:control        — start/next/prev/stop on the active pane
//   spatial:permission:respond  — prompt answer → resolver
//
// Pure policy lives in focus-arbitration.js / scheme-classifier.js /
// session-partitions.js. This module is wiring only: every effect is
// injected, so the trust gate stays in main.js and `node --test` can pin the
// channel contract.

const { randomUUID } = require('node:crypto');

// A toast request that never got an answer dies with the window or after a
// TTL — a stale figma:// URL must not launch hours later on a stray click.
const PENDING_TTL_MS = 60_000;
// will-navigate, will-frame-navigate and setWindowOpenHandler can all fire
// for one click; only one toast may exist per (recent) URL.
const DEDUPE_WINDOW_MS = 1_500;

const sanitizeDownloadRecord = (record) => ({
  id: typeof record?.id === 'string' ? record.id : null,
  url: typeof record?.url === 'string' ? record.url : '',
  filename: typeof record?.filename === 'string' ? record.filename : '',
  state: record?.state ?? 'progressing',
  receivedBytes: Number(record?.receivedBytes) || 0,
  totalBytes: Number(record?.totalBytes) || 0,
  startedAt: Number(record?.startedAt) || 0,
  finishedAt: Number(record?.finishedAt) || 0,
  private: record?.private === true,
  inFlight: record?.inFlight === true,
  // savePath is deliberately NEVER serialized across the bridge: the shell
  // surface opens/shows through spatial:downloads:action, which re-resolves
  // the record in main (downloads.js).
});

/**
 * Build the shell bridge.
 * @param {object} deps
 * @param {(channel: string, handler: Function) => void} deps.chromeHandle  invoke registrar (trust-gated)
 * @param {(channel: string, handler: Function) => void} deps.chromeOn     fire-and-forget registrar (trust-gated)
 * @param {() => Iterable<object>} deps.allRuntimes
 * @param {(url: string) => Promise<void>} deps.openExternal  shell.openExternal
 * @param {object} deps.effects
 *   downloads: { list, activity, cancel, resume, retry, open, show, clear }
 *   find:      (payload) => { ok: boolean }   — findInPage control on the
 *              sender's runtime (registrars bind rt() to the sender)
 *   permissionRespond: (id, allow) => void     — resolve a pending prompt
 */
function createShellBridge({ chromeHandle, chromeOn, allRuntimes, openExternal, effects }) {
  if (typeof chromeHandle !== 'function' || typeof chromeOn !== 'function') {
    throw new TypeError('createShellBridge: chromeHandle and chromeOn are required registrars');
  }
  if (typeof openExternal !== 'function' || !effects || typeof effects !== 'object') {
    throw new TypeError('createShellBridge: openExternal and effects are required');
  }
  const fx = effects && typeof effects === 'object' ? effects : {};
  const live = (runtime) => !!runtime?.spatialChrome && runtime.window && !runtime.window.isDestroyed();
  const send = (runtime, channel, payload) => {
    if (live(runtime)) runtime.window.webContents.send(channel, payload);
  };

  /* ---- pending external handoffs (§B.8.2) ---- */
  const pendingExternal = new Map();
  const recentExternal = new Map(); // url → last request ms (toast dedupe)

  const prunePending = (now = Date.now()) => {
    for (const [id, entry] of pendingExternal) {
      if (now - entry.at > PENDING_TTL_MS) pendingExternal.delete(id);
    }
    for (const [url, at] of recentExternal) {
      if (now - at > DEDUPE_WINDOW_MS * 4) recentExternal.delete(url);
    }
  };

  /** Send a confirmation toast for one app-scheme URL. Returns true when the
   *  navigation must be consumed (scheme classified, request delivered or
   *  deduped) — the caller preventDefaults before any blank node exists. */
  const requestExternalConfirm = (runtime, { url, source } = {}) => {
    prunePending();
    const now = Date.now();
    const last = recentExternal.get(url);
    if (last != null && now - last < DEDUPE_WINDOW_MS) return true;
    recentExternal.set(url, now);
    const requestId = randomUUID();
    pendingExternal.set(requestId, { url, at: now });
    // The initiating page is shown as an ORIGIN only — never its full URL,
    // query strings included.
    let origin = null;
    try {
      const parsed = new URL(source ?? '');
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') origin = parsed.origin;
    } catch { /* address-bar input has no referring page */ }
    send(runtime, 'spatial:external:confirm', { requestId, url, origin });
    return true;
  };

  const takePendingExternal = (requestId) => {
    if (typeof requestId !== 'string' || requestId.length !== 36) return null;
    prunePending();
    const entry = pendingExternal.get(requestId);
    if (!entry) return null;
    pendingExternal.delete(requestId);
    return entry.url;
  };

  /* ---- senders ---- */
  const sendShellShortcut = (runtime, action, info = {}) => {
    if (typeof action !== 'string' || action.length > 40) return;
    send(runtime, 'spatial:shell:shortcut', {
      action,
      tabId: Number.isInteger(info.tabId) ? info.tabId : null,
    });
  };

  const sendFindResult = (runtime, result) => {
    if (!result || typeof result !== 'object') return;
    const matches = Number.isInteger(result.matches) && result.matches >= 0 ? result.matches : 0;
    const activeMatchOrdinal = Number.isInteger(result.activeMatchOrdinal) && result.activeMatchOrdinal >= 0
      ? result.activeMatchOrdinal : 0;
    send(runtime, 'spatial:find:result', { matches, activeMatchOrdinal });
  };

  const sendPermissionRequest = (runtime, payload) => {
    if (!payload || !Number.isInteger(payload.id)) return;
    const mediaTypes = Array.isArray(payload.mediaTypes) ? payload.mediaTypes.slice(0, 8) : [];
    send(runtime, 'spatial:permission:request', {
      id: payload.id,
      origin: typeof payload.origin === 'string' ? payload.origin : null,
      permission: typeof payload.permission === 'string' ? payload.permission : null,
      mediaTypes,
    });
  };

  /** Snapshot for the ⌘J surface: sanitized items + aggregate activity for
   *  the local profile context the caller runs under. */
  const downloadsSnapshot = () => ({
    items: (typeof fx.downloads?.list === 'function' ? fx.downloads.list() : [])
      .map(sanitizeDownloadRecord),
    activity: typeof fx.downloads?.activity === 'function'
      ? fx.downloads.activity()
      : { active: 0, hasRecent: false, receivedBytes: 0, totalBytes: 0, lastCompletedAt: null },
  });

  const broadcastDownloads = () => {
    const snapshot = downloadsSnapshot();
    for (const runtime of allRuntimes()) send(runtime, 'spatial:downloads:updated', snapshot);
  };

  /* ---- receiver channels ---- */
  const DOWNLOAD_ACTIONS = Object.freeze(new Set([
    'cancel', 'resume', 'retry', 'open', 'show', 'clear',
  ]));

  const register = () => {
    // §B.8.2 — the toast's answer. Only an entry delivered by requestExternal
    // Confirm can open; the URL never round-trips through the renderer.
    chromeHandle('spatial:external:respond', (...args) => {
      const payload = args[1];
      const requestId = payload && typeof payload.requestId === 'string' ? payload.requestId : null;
      const url = takePendingExternal(requestId);
      if (!url) return { ok: false, error: 'unknown-request' };
      if (payload.allow !== true) return { ok: true, opened: false };
      void Promise.resolve(openExternal(url)).catch(() => {});
      return { ok: true, opened: true };
    });

    // §B.8.5 — ⌘J surface data.
    chromeHandle('spatial:downloads:list', () => ({ ok: true, ...downloadsSnapshot() }));

    chromeHandle('spatial:downloads:action', (...args) => {
      const payload = args[1];
      const id = payload && typeof payload.id === 'string' ? payload.id : null;
      const action = payload && typeof payload.action === 'string' ? payload.action : null;
      if (!id || !DOWNLOAD_ACTIONS.has(action)) return { ok: false, error: 'invalid' };
      const d = fx.downloads ?? {};
      try {
        if (action === 'cancel') d.cancel?.(id);
        else if (action === 'resume') d.resume?.(id);
        else if (action === 'retry') d.retry?.(id);
        else if (action === 'open') d.open?.(id);
        else if (action === 'show') d.show?.(id);
        else if (action === 'clear') d.clear?.();
      } catch { /* a dead item's action is a no-op */ }
      return { ok: true };
    });

    // §B.8.1 — matte find bar control over the ACTIVE pane (main resolves
    // the pane; the shell only states intent).
    chromeHandle('spatial:find:control', (...args) => {
      const payload = args[1];
      const action = payload && typeof payload.action === 'string' ? payload.action : null;
      if (!['start', 'next', 'prev', 'stop'].includes(action)) return { ok: false, error: 'invalid' };
      const query = typeof payload.query === 'string' ? payload.query.slice(0, 512) : '';
      if (action === 'start' && !query) return { ok: false, error: 'query' };
      return typeof fx.find === 'function' ? fx.find({ action, query }) : { ok: false };
    });

    // §B.8 prompt lane — matte permission prompt answer.
    chromeOn('spatial:permission:respond', (...args) => {
      const payload = args[1];
      const id = payload && Number.isInteger(payload.id) ? payload.id : null;
      if (id == null) return;
      if (typeof fx.permissionRespond === 'function') fx.permissionRespond(id, payload.allow === true);
    });
  };

  return {
    register,
    requestExternalConfirm,
    takePendingExternal,
    sendShellShortcut,
    sendFindResult,
    sendPermissionRequest,
    downloadsSnapshot,
    broadcastDownloads,
  };
}

module.exports = { createShellBridge, sanitizeDownloadRecord, PENDING_TTL_MS, DEDUPE_WINDOW_MS };
