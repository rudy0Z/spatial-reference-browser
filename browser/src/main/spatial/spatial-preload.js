'use strict';

// Preload for the Spatial chrome document (blanc-chrome://spatial/).
//
// Attached INSTEAD of preload.js when a window runs the spatial shell, so the
// contract-pinned `browserAPI` bridge (browser-api/contract.json) is not
// extended from the side: the spatial document gets its own narrow
// `window.spatialAPI` bridge and nothing else. Same hardening posture as
// every Blanc chrome surface — contextIsolation, sandbox, no Node.
//
// Window controls reuse the existing `window:*` channels (main.js:12367-
// 12369), which are already trust-gated for this window's webContents;
// everything spatial goes through the `spatial:*` namespace registered by
// spatial-runtime.js/graph-ipc.js.

const { contextBridge, ipcRenderer } = require('electron');

const send = (channel) => () => { ipcRenderer.send(channel); };
const on = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('spatialAPI', {
  // Graph
  load: () => ipcRenderer.invoke('spatial:graph:load'),
  mutate: (ops) => ipcRenderer.invoke('spatial:graph:mutate', ops),
  // Node lifecycle
  openNode: (uuid) => ipcRenderer.invoke('spatial:node:open', { uuid }),
  closeNode: (uuid) => ipcRenderer.invoke('spatial:node:close', { uuid }),
  navigate: (url) => ipcRenderer.invoke('spatial:node:navigate', { url }),
  // Modes & layout
  setMode: (mode) => ipcRenderer.invoke('spatial:mode:set', { mode }),
  setChromeLayout: (layout) => ipcRenderer.send('spatial:chrome:layout', layout),
  // Z-order guard (palette/glance/extensions/shortcuts over a live view)
  zorderEngage: send('spatial:zorder:engage'),
  zorderRelease: send('spatial:zorder:release'),
  // Mode B thumbnails: main sends raw PNG, renderer answers a 640×400 WebP
  storeThumb: (uuid, dataUrl) => ipcRenderer.send('spatial:thumb:store', { uuid, dataUrl }),
  // Window controls (existing trust-gated channels)
  win: {
    minimize: send('window:minimize'),
    maximize: send('window:maximize'),
    close: send('window:close'),
  },
  // Main → renderer events; each returns an unsubscribe function.
  onGraphUpdated: on('spatial:graph:updated'),
  onZorderBackdrop: on('spatial:zorder:backdrop'),
  onModeChanged: on('spatial:mode:changed'),
  onActiveChanged: on('spatial:active:changed'),
  onThumbCapture: on('spatial:thumb:capture'),
});
