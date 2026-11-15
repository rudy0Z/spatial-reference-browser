'use strict';

// Link-branch click tagging for the Spatial shell (Phase 3, spec step 3).
//
// Modeled on link-route-preload.js and attached to the SAME tab sessions:
// it reports, from a tab's own top-level page only, a trusted user activation
// of a link the user asked to branch — Cmd/Ctrl+Click, middle-click, or a
// link carrying target="_blank". Main records the activation so the
// window-open handler's branch record knows the branch was user-requested
// (spatialLinkActivations in main.js). It sends the link's http(s) address
// and three booleans, nothing else.
//
//   - main frames only, so a sandboxed iframe never reports;
//   - trusted events only, which a page cannot synthesize;
//   - never an opaque-origin document.

const { ipcRenderer } = require('electron');

const SPATIAL_LINK_ACTIVATED_CHANNEL = 'spatial:link:activated';
const MAX_URL_LENGTH = 8192;

if (process.isMainFrame && /^https?:$/.test(window.location.protocol)) {
  const describe = (event) => {
    if (!event.isTrusted || window.origin === 'null') return null;
    // Left click (possibly modified) or middle click.
    const isClick = event.type === 'click';
    if (isClick ? event.button !== 0 : event.button !== 1) return null;
    const link = event.composedPath().find((node) => node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement);
    const href = link?.href;
    if (typeof href !== 'string' || href.length > MAX_URL_LENGTH || !/^https?:/i.test(href)) return null;
    const modified = isClick ? (event.ctrlKey || event.metaKey || event.shiftKey) : true;
    const targetBlank = link.target === '_blank';
    if (!modified && !targetBlank) return null;
    return { url: href, modified, targetBlank, middle: !isClick };
  };
  window.addEventListener('click', (event) => {
    const tagged = describe(event);
    if (tagged) ipcRenderer.send(SPATIAL_LINK_ACTIVATED_CHANNEL, tagged);
  }, true);
  window.addEventListener('auxclick', (event) => {
    const tagged = describe(event);
    if (tagged) ipcRenderer.send(SPATIAL_LINK_ACTIVATED_CHANNEL, tagged);
  }, true);
}
