'use strict';

// §B.10 — Toggleable Studio Plugins, Electron-side owner (Phase 3.6).
//
// Pure policy lives in ./studio-plugins-model.js. This file owns:
//   - the authoritative active-plugin set. Injection is gated on it: a
//     plugin's in-page scripts are executed ONLY while it is active — armed
//     on activation (and on every dom-ready while active), torn down on
//     deactivation. With all plugins off the only thing that remains is the
//     dom-ready/did-navigate listeners that check the set and do nothing
//     (§B.0 zero-cost law, same posture as §B.9's Live Mods).
//   - Plugin A (`xray`): per-view await-loop for the click-to-capture
//     snapshot, forwarded to the shell on `spatial:xray:capture` where the
//     shell formats Markdown and lands a StickyNote on the active node.
//   - Plugin B/C media cache: trust-gated writes into `userData/media/` —
//     net.fetch + MIME allowlist + size caps for remote sources, inline SVG
//     markup for `<svg>` drags, and read-back as data URLs for RichCard.
//     The shell never receives a filesystem path, only validated clip ids.
//   - Plugin C preview capture: `beginFrameSubscription` on the ACTIVE view,
//     throttled, resized to 640×400 PNG and streamed to the shell (which
//     MediaRecords them into a WebM and hands it back via
//     `spatial:media:store-webm`).
//   - Plugin D: `enableDeviceEmulation`/`disableDeviceEmulation` on a node's
//     live view (breakpoint presets) and `capturePage` pane snapshots for
//     the onion-skin overlay.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  PLUGIN_IDS,
  isPluginId,
  normalizeEmulateWidth,
  MEDIA_CACHE_MAX_BYTES,
  normalizeClipRequest,
  normalizeWebmStoreRequest,
  extForMime,
  xrayArmScript,
  xrayAwaitScript,
  xrayTeardownScript,
  shaderHudArmScript,
  shaderHudTeardownScript,
} = require('./studio-plugins-model');

const XRAY_WAIT_MS = 120_000;
const PREVIEW_DURATION_MS = 5_000;
const PREVIEW_MIN_FRAME_INTERVAL_MS = 80; // ~12.5 fps compositor sampling
const PREVIEW_WIDTH = 640;
const PREVIEW_HEIGHT = 400;

// ext → mime for data-URL read-back (mirrors the model's allowlist).
const EXT_MIME = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webm: 'video/webm',
  mp4: 'video/mp4',
});

const CLIP_ID_PATTERN = /^[\w][\w.-]{0,79}$/;

/** Build the Studio Plugins engine (wired once from spatial-runtime.initSpatial). */
function createStudioPlugins({
  chromeHandle,
  chromeOn,
  getActiveView,
  iterViews,
  notifyShell,
  userDataPath,
  viewForNode,
  captureView,
}) {
  if (typeof chromeHandle !== 'function') {
    throw new TypeError('createStudioPlugins: chromeHandle registrar is required');
  }
  if (typeof getActiveView !== 'function' || typeof notifyShell !== 'function') {
    throw new TypeError('createStudioPlugins: getActiveView and notifyShell are required');
  }
  const iter = typeof iterViews === 'function' ? iterViews : () => [];
  const nodeView = typeof viewForNode === 'function' ? viewForNode : () => null;
  const paneCapture = typeof captureView === 'function' ? captureView : () => Promise.resolve(null);

  /* ---- activation state (session-scoped, never persisted) ---- */

  const active = new Set();

  const broadcastActive = () => {
    notifyShell('spatial:plugins:updated', {
      plugins: PLUGIN_IDS.map((id) => ({ id, active: active.has(id) })),
    });
  };

  /* ---- attached views & injection bookkeeping ---- */

  const views = new Map(); // tabId → { tabId, wc, xrayLoopRunning }

  const wcAlive = (view) => !!view.wc && !view.wc.isDestroyed?.();

  function safeExec(view, script) {
    if (!wcAlive(view)) return Promise.resolve(undefined);
    try {
      return view.wc.executeJavaScript(script, true);
    } catch {
      return Promise.resolve(undefined);
    }
  }

  /** (Re)inject every ACTIVE plugin's scripts into one view. */
  function reinjectView(view) {
    if (!wcAlive(view)) return;
    if (active.has('xray')) {
      void safeExec(view, xrayArmScript());
      startXrayLoop(view);
    }
    if (active.has('shader-hud')) {
      void safeExec(view, shaderHudArmScript());
    }
  }

  /** Tear down every active plugin's scripts in one view. */
  function teardownView(view) {
    if (!wcAlive(view)) return;
    if (active.has('xray')) void safeExec(view, xrayTeardownScript());
    if (active.has('shader-hud')) void safeExec(view, shaderHudTeardownScript());
    view.xrayLoopRunning = false;
  }

  function attachView(tabId, wc) {
    if (!wc || typeof tabId !== 'number') return;
    let view = views.get(tabId);
    if (view && view.wc === wc) return;
    if (view) view.wc = wc;
    else {
      view = { tabId, wc, xrayLoopRunning: false };
      views.set(tabId, view);
      wc.once?.('destroyed', () => {
        view.xrayLoopRunning = false;
        if (views.get(tabId) === view) views.delete(tabId);
      });
    }
    wc.on?.('dom-ready', () => {
      if (active.size > 0) reinjectView(view);
    });
    reinjectView(view);
  }

  function forgetView(tabId) {
    const view = views.get(tabId);
    if (!view) return;
    view.xrayLoopRunning = false;
    views.delete(tabId);
  }

  /* ---- Plugin A — X-Ray capture loops (one waiter per active view) ---- */

  function startXrayLoop(view) {
    if (!wcAlive(view) || view.xrayLoopRunning) return;
    view.xrayLoopRunning = true;
    void xrayLoop(view);
  }

  async function xrayLoop(view) {
    while (active.has('xray') && wcAlive(view) && view.xrayLoopRunning) {
      try {
        const snapshot = await safeExec(view, xrayAwaitScript(XRAY_WAIT_MS));
        if (!active.has('xray')) break;
        if (snapshot && typeof snapshot === 'object') {
          notifyShell('spatial:xray:capture', { snapshot });
        }
        // Macrotask yield between waiters (microtask-famine guard, §B.9).
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        break;
      }
    }
    view.xrayLoopRunning = false;
  }

  /* ---- Plugin B/C — media cache (userData/media/) ---- */

  const mediaDir = () => {
    const dir = path.join(userDataPath ?? '.', 'media');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const clipPathFor = (clipId, ext) => {
    if (!CLIP_ID_PATTERN.test(clipId)) return null;
    const file = path.join(mediaDir(), `${clipId}.${ext}`);
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(mediaDir()) + path.sep)) return null;
    return resolved;
  };

  const hashStem = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);

  async function fetchWithCap(url) {
    const electron = require('electron');
    const fetchFn = electron.net?.fetch;
    if (typeof fetchFn !== 'function') throw new Error('no-net');
    const response = await fetchFn(url, {
      method: 'GET',
      redirect: 'follow',
      // No credentials: clips are anonymous fetches, never authenticated ones.
      credentials: 'omit',
    });
    if (!response.ok) throw new Error(`http-${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MEDIA_CACHE_MAX_BYTES) throw new Error('too-large');
    const mime = response.headers?.get?.('content-type') ?? '';
    return { bytes: Buffer.from(arrayBuffer), mime };
  }

  async function cacheMediaClip(payload) {
    const check = normalizeClipRequest(payload);
    if (!check.ok) return { ok: false, error: check.error };
    const req = check.req;

    // Inline SVG (dragged without a source URL) — content-addressed store.
    if (req.markup !== null) {
      const clipId = `svg-${hashStem(req.markup)}`;
      const file = clipPathFor(clipId, 'svg');
      if (!file) return { ok: false, error: 'path' };
      fs.writeFileSync(file, req.markup, 'utf8');
      return {
        ok: true,
        clip: {
          kind: 'svg',
          clipId,
          src: '',
          sourcePageUrl: req.sourcePageUrl,
          bytes: Buffer.byteLength(req.markup, 'utf8'),
          mime: 'image/svg+xml',
          ext: 'svg',
        },
      };
    }

    // Remote source — fetch under cap, MIME-allowlisted.
    let fetched;
    try {
      fetched = await fetchWithCap(req.src);
    } catch (error) {
      return { ok: false, error: String(error?.message ?? 'fetch-failed').slice(0, 60) };
    }
    let ext = extForMime(fetched.mime);
    if (!ext) {
      // Generic binary with a media-looking URL extension is still refused
      // unless the extension resolves to the shell's declared kind — the
      // allowlist stays the authority, the URL only corroborates it.
      const urlExt = req.src.split('?')[0].match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
      ext = urlExt === 'webm' && req.kind === 'video' ? 'webm' : urlExt === 'mp4' && req.kind === 'video' ? 'mp4' : null;
    }
    if (!ext) return { ok: false, error: 'mime-refused' };

    const clipId = `${ext}-${hashStem(req.src)}`;
    const file = clipPathFor(clipId, ext);
    if (!file) return { ok: false, error: 'path' };
    if (!fs.existsSync(file)) fs.writeFileSync(file, fetched.bytes);
    return {
      ok: true,
      clip: {
        kind: req.kind,
        clipId,
        src: req.src,
        sourcePageUrl: req.sourcePageUrl,
        bytes: fetched.bytes.byteLength,
        mime: String(fetched.mime).split(';')[0].trim(),
        ext,
      },
    };
  }

  function readClipDataUrl(payload) {
    const clipId = payload && typeof payload.clipId === 'string' ? payload.clipId : '';
    if (!CLIP_ID_PATTERN.test(clipId)) return { ok: false, error: 'clip-id' };
    const dir = path.resolve(mediaDir());
    // Only existing files with allowlisted extensions resolve.
    for (const ext of Object.keys(EXT_MIME)) {
      const candidate = path.join(dir, `${clipId}.${ext}`);
      const resolved = path.resolve(candidate);
      if (!resolved.startsWith(dir + path.sep) || !fs.existsSync(resolved)) continue;
      const stat = fs.statSync(resolved);
      if (stat.size > MEDIA_CACHE_MAX_BYTES) return { ok: false, error: 'too-large' };
      const data = fs.readFileSync(resolved);
      return {
        ok: true,
        dataUrl: `data:${EXT_MIME[ext]};base64,${data.toString('base64')}`,
        mime: EXT_MIME[ext],
      };
    }
    return { ok: false, error: 'missing' };
  }

  function storeWebmPreview(payload) {
    const check = normalizeWebmStoreRequest(payload);
    if (!check.ok) return { ok: false, error: check.error };
    let bytes;
    try {
      bytes = Buffer.from(check.req.base64, 'base64');
    } catch {
      return { ok: false, error: 'base64' };
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MEDIA_CACHE_MAX_BYTES) return { ok: false, error: 'bytes' };
    const clipId = `preview-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const file = clipPathFor(clipId, 'webm');
    if (!file) return { ok: false, error: 'path' };
    fs.writeFileSync(file, bytes);
    return {
      ok: true,
      clip: {
        kind: 'video',
        clipId,
        src: '',
        sourcePageUrl: check.req.sourcePageUrl,
        bytes: bytes.byteLength,
        mime: 'video/webm',
        ext: 'webm',
      },
    };
  }

  /* ---- Plugin C — compositor frame stream for the 5s preview ---- */

  let previewRunning = false;

  function startPreviewCapture() {
    if (previewRunning) return { ok: false, error: 'busy' };
    const target = getActiveView();
    if (!target?.wc || target.wc.isDestroyed?.()) return { ok: false, error: 'no-view' };
    const wc = target.wc;
    if (typeof wc.beginFrameSubscription !== 'function' || typeof wc.endFrameSubscription !== 'function') {
      return { ok: false, error: 'unsupported' };
    }
    previewRunning = true;
    let lastSent = 0;
    let frames = 0;
    let index = 0;

    const onFrame = (_event, image) => {
      if (!image || image.isEmpty()) return;
      const now = Date.now();
      if (now - lastSent < PREVIEW_MIN_FRAME_INTERVAL_MS) return;
      lastSent = now;
      const resized = image.resize({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT });
      if (!resized || resized.isEmpty()) return;
      index += 1;
      frames += 1;
      notifyShell('spatial:plugin-hud:frame', {
        frame: `data:image/png;base64,${resized.toPNG().toString('base64')}`,
        index,
      });
    };

    try {
      wc.beginFrameSubscription(onFrame);
    } catch {
      previewRunning = false;
      return { ok: false, error: 'subscribe-failed' };
    }

    setTimeout(() => {
      try {
        wc.endFrameSubscription();
      } catch {
        /* view died mid-capture */
      }
      previewRunning = false;
      notifyShell('spatial:plugin-hud:capture-done', {
        ok: frames > 0,
        error: frames > 0 ? undefined : 'no-frames',
      });
    }, PREVIEW_DURATION_MS);

    return { ok: true };
  }

  /* ---- Plugin D — emulation + pane snapshots ---- */

  function emulateNode(payload) {
    const uuid = payload && typeof payload.uuid === 'string' ? payload.uuid : '';
    const width = payload ? normalizeEmulateWidth(payload.width) : undefined;
    if (width === undefined) return { ok: false, error: 'width' };
    const view = uuid ? nodeView(uuid) : null;
    if (!view?.wc || view.wc.isDestroyed?.()) return { ok: false, error: 'no-view' };
    try {
      if (width === null) view.wc.disableDeviceEmulation();
      else {
        const mobile = width < 800;
        view.wc.enableDeviceEmulation({
          screenPosition: 'front',
          screenSize: { width, height: mobile ? 844 : 900 },
          viewSize: { width, height: mobile ? 844 : 900 },
          deviceScaleFactor: mobile ? 3 : 1,
          mobile,
        });
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? 'emulate-failed').slice(0, 60) };
    }
  }

  async function capturePane(payload) {
    const uuid = payload && typeof payload.uuid === 'string' ? payload.uuid : '';
    if (!uuid) return { ok: false, error: 'uuid' };
    const image = await paneCapture(uuid);
    if (!image || image.isEmpty()) return { ok: false, error: 'capture-failed' };
    return { ok: true, dataUrl: image.toDataURL() };
  }

  /* ---- channel registration (trust-gated, §B.9 seam) ---- */

  const register = () => {
    chromeHandle('spatial:plugins:list', () => ({
      ok: true,
      plugins: PLUGIN_IDS.map((id) => ({ id, active: active.has(id) })),
    }));

    chromeHandle('spatial:plugins:set-active', (...args) => {
      const payload = args[1];
      const id = payload && typeof payload.id === 'string' ? payload.id : null;
      if (!isPluginId(id)) return { ok: false, error: 'plugin-id' };
      const on = payload?.active === true;
      if (on && !active.has(id)) {
        active.add(id);
        // Arm the ACTIVE view even if it has not joined the attached set yet
        // (same on-demand posture as the §B.9 zapper's armZapper).
        const target = getActiveView();
        if (target?.wc && !target.wc.isDestroyed?.() && typeof target.tabId === 'number') {
          attachView(target.tabId, target.wc);
        }
        for (const view of views.values()) reinjectView(view);
      } else if (!on && active.has(id)) {
        active.delete(id);
        for (const view of views.values()) {
          if (id === 'xray') {
            void safeExec(view, xrayTeardownScript());
            view.xrayLoopRunning = false;
          }
          if (id === 'shader-hud') void safeExec(view, shaderHudTeardownScript());
        }
      }
      broadcastActive();
      return { ok: true, active: active.has(id) };
    });

    chromeHandle('spatial:media:cache', (...args) => cacheMediaClip(args[1]));
    chromeHandle('spatial:media:read', (...args) => readClipDataUrl(args[1]));
    chromeHandle('spatial:media:store-webm', (...args) => storeWebmPreview(args[1]));
    chromeHandle('spatial:plugin-hud:capture-preview', () => startPreviewCapture());
    chromeHandle('spatial:plugins:emulate', (...args) => emulateNode(args[1]));
    chromeHandle('spatial:plugins:capture-pane', (...args) => capturePane(args[1]));
  };

  return {
    register,
    attachView,
    forgetView,
    activeIds: () => PLUGIN_IDS.filter((id) => active.has(id)),
    isPreviewRunning: () => previewRunning,
  };
}

module.exports = { createStudioPlugins, PREVIEW_DURATION_MS, PREVIEW_WIDTH, PREVIEW_HEIGHT };
