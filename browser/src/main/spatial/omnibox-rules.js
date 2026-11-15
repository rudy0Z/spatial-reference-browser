'use strict';

// Pure omnibox rules for the Spatial shell (Phase 3, spec step 4).
//
// The typed-address pipeline's authority stays in main.js
// (navigateTabToAddress: handOffToOs → bangResolver → normalizeAddressInput).
// These functions MIRROR its classification so the spatial chrome can show a
// preview and route Enter identically, without importing Electron or the
// settings object: everything ambiguous is injected. AGENTS.md — "Address
// input normalization" — fixes the heuristic deliberately: has-a-scheme,
// looks-like-localhost/IPv4, looks-like-a-domain, else a search query
// against the selected engine. Known, accepted limitation; do not "fix" it
// with a heavier URL parser.
//
// No Electron imports: unit-tested under node --test.

/** Script-executing schemes are never navigable from the address bar. */
const NAVIGABLE_SCHEMES = new Set(['http', 'https']);

const LOCALHOST_PATTERN = /^localhost(:\d+)?(\/|$)/;
const BARE_IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/;

/**
 * The classification half of normalizeAddressInput (main.js:6535), pure:
 * 'url' when the text is directly navigable, 'search' when it goes to the
 * selected engine. `searchUrlFor` is injected so the caller's engine
 * selection (settings.currentSearchEngine(), or a custom `%s` template)
 * decides where a query lands.
 */
function classifyAddressInput(text, { searchUrlFor } = {}) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { kind: 'empty', url: null };
  const scheme = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//)?.[1]?.toLowerCase();
  if (scheme) {
    if (NAVIGABLE_SCHEMES.has(scheme)) return { kind: 'url', url: trimmed };
    // Other schemes (blanc:, mailto:, view-source:) are not the omnibox's
    // business here — the caller's handOffToOs/utility checks handle them.
    return { kind: 'other', url: trimmed };
  }
  if (LOCALHOST_PATTERN.test(trimmed) || BARE_IPV4_PATTERN.test(trimmed)) {
    return { kind: 'url', url: `http://${trimmed}` };
  }
  // A search operator (site:example.com) puts a colon where the host would
  // be; only a numeric port may follow one. user:pass@ keeps its path.
  const host = trimmed.split(/[/?#]/, 1)[0];
  if (!host.includes('@') && /:(?!\d+$)/.test(host)) return { kind: 'search', url: null };
  const looksLikeDomain = /^[^\s]+\.[a-zA-Z]{2,}(\/[^\s]*)?$/.test(trimmed);
  if (looksLikeDomain) return { kind: 'url', url: `https://${trimmed}` };
  return { kind: 'search', url: null };
}

/** Resolve a classification into a navigation URL (search through the engine). */
function resolveOmniboxInput(text, { searchUrlFor } = {}) {
  const classification = classifyAddressInput(text, {});
  if (classification.kind === 'url' || classification.kind === 'other') return classification;
  if (classification.kind === 'empty') return classification;
  const query = String(text ?? '').trim();
  const url = typeof searchUrlFor === 'function' ? searchUrlFor(query) : null;
  return url ? { kind: 'search', url } : { kind: 'search', url: null };
}

/**
 * TLS/shield display state for the top bar. Only real https (or the local
 * chrome) can be "secure"; an explicit certificate failure for the URL wins
 * over everything else; http and opaque schemes read as insecure/neutral.
 */
function tlsDisplayState(url, { certificateError = false } = {}) {
  if (certificateError) return 'error';
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    return 'neutral';
  }
  if (parsed.protocol === 'https:') return 'secure';
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
    return isLocal ? 'local' : 'insecure';
  }
  return 'neutral';
}

module.exports = { classifyAddressInput, resolveOmniboxInput, tlsDisplayState, NAVIGABLE_SCHEMES };
