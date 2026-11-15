'use strict';

// Link-branch click tagging for the Spatial shell (Phase 3, spec step 3).
//
// Modeled on link-route-preload.js and attached to the SAME tab sessions:
// it reports, from a tab's own top-level page only, a trusted user activation
// of a link the user asked to branch — Cmd/Ctrl+Click, middle-click, or a
// link carrying target="_blank". Main records the activation so the
// window-open handler's branch record knows the branch was user-requested
// (spatialLinkActivations in main.js). It sends the link's http(s) address,
// three booleans, and — Phase 3.4 §B.7.1 Path-Preserving Trails — the rich
// spawn provenance: the exact clicked text/alt, ≤140 chars of the sentence
// around it, and the page scroll offset at the click ("via "Klim Söhne
// specimen"" on the graph later).
//
//   - main frames only, so a sandboxed iframe never reports;
//   - trusted events only, which a page cannot synthesize;
//   - never an opaque-origin document;
//   - bounded reads: text is clamped here AND re-validated in main.

const { ipcRenderer } = require('electron');

const SPATIAL_LINK_ACTIVATED_CHANNEL = 'spatial:link:activated';
const MAX_URL_LENGTH = 8192;
// Transport caps. The pure capture shape (app/src/lib/trails.ts) applies the
// §B.7.1 presentation caps (anchor 120 / snippet 140); these bounds only
// stop a pathological page from shipping megabytes over IPC.
const MAX_ANCHOR_TRANSPORT = 512;
const MAX_SNIPPET_TRANSPORT = 512;
// Ancestors worth reading for the surrounding sentence, nearest first.
const CONTEXT_SELECTORS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, dd, summary';

const collapseSpace = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/** The anchor's clicked text, or a wrapped image's alt when textless. */
function anchorLabel(link) {
  const text = collapseSpace(link.textContent).slice(0, MAX_ANCHOR_TRANSPORT);
  if (text) return text;
  const image = link.querySelector('img[alt]');
  const alt = image ? collapseSpace(image.getAttribute('alt')).slice(0, MAX_ANCHOR_TRANSPORT) : '';
  return alt || '';
}

/** The block of text the anchor sits in (nearest reasonable container). */
function contextText(link) {
  const container = link.closest(CONTEXT_SELECTORS) || link.parentElement;
  if (!container) return '';
  return collapseSpace(container.textContent).slice(0, MAX_SNIPPET_TRANSPORT);
}

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
    // §B.7.1 — rich provenance at the exact activation instant. Reads are
    // synchronous, local to the clicked anchor, and bounded; a page cannot
    // spoof isTrusted, so the provenance is as trustworthy as the branch
    // gate it rides on.
    const anchorText = anchorLabel(link);
    const contextSnippet = contextText(link);
    const scrollYAtSpawn = Number.isFinite(window.scrollY) ? Math.max(0, Math.round(window.scrollY)) : null;
    return {
      url: href,
      modified,
      targetBlank,
      middle: !isClick,
      anchorText: anchorText || null,
      contextSnippet: contextSnippet || null,
      scrollYAtSpawn,
    };
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
