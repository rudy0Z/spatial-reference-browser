'use strict';

// §B.8.1 + §B.8.3 + §B.8.5 — the Spatial shell's accelerator table.
//
// Pure policy (no Electron): decides, from one Electron `before-input-event`
// `input` record, whether the Spatial shell owns the key. When a live page
// (a WebContentsView) holds focus the shell document never sees the keyboard,
// so tab-view.js installs one arbitration listener on EVERY view that consults
// this table: a match is consumed (preventDefault) before the page — or
// Blanc's own strip-chrome shortcut set — can act, and either
//   scope 'shell' → forwarded to the blanc-chrome:// shell document as
//                   'spatial:shell:shortcut' { action }, or
//   scope 'main'  → executed by the main process directly (builder
//                   ergonomics: hard reload / DevTools on the focused pane).
//
// The strip chrome (SPATIAL_CHROME=0 rollback) never consults this table —
// Blanc's browser-shortcuts.js keeps its meaning there. Main gates on
// runtime.spatialChrome.

// Binding shape: { key, ctrl, meta, alt, shift, platforms }. Booleans must
// match the input EXACTLY (the browser-shortcuts.js posture — a binding that
// names shift refuses an unshifted press). `cmdorctrl` is resolved per
// platform below, like acceleratorMatches().
// Electron delivers Space as key ' ' (and some surfaces as 'Space') — both
// accepted. Escape arrives as 'Esc' or 'Escape' depending on the surface.
const SHELL_SHORTCUT_ACTIONS = Object.freeze([
  // §B.8.1 — canvas ⇄ reading (Cmd/Ctrl+Space, Alt+Space)
  { action: 'canvas', scope: 'shell', key: 'space', cmdorctrl: true, alt: false, shift: false },
  { action: 'canvas', scope: 'shell', key: 'space', alt: true, cmdorctrl: false, shift: false },
  // §B.8.1 — command palette (Cmd/Ctrl+L)
  { action: 'palette', scope: 'shell', key: 'l', cmdorctrl: true, alt: false, shift: false },
  // §B.8.1 — Zen rail (Cmd/Ctrl+S)
  { action: 'rail', scope: 'shell', key: 's', cmdorctrl: true, alt: false, shift: false },
  // §B.8.1 — neighbourhood glance (Cmd/Ctrl+Shift+G)
  { action: 'glance', scope: 'shell', key: 'g', cmdorctrl: true, shift: true, alt: false },
  // §B.8.1 — shortcuts sheet (Cmd/Ctrl+/)
  { action: 'shortcuts', scope: 'shell', key: '/', cmdorctrl: true, alt: false, shift: false },
  // §B.8.1 — quick sticky note (Alt+N)
  { action: 'quick-note', scope: 'shell', key: 'n', alt: true, cmdorctrl: false, shift: false },
  // §B.8.1 — matte find bar (Cmd/Ctrl+F)
  { action: 'find', scope: 'shell', key: 'f', cmdorctrl: true, alt: false, shift: false },
  // §B.8.5 — downloads surface (Cmd/Ctrl+J; the strip's Ctrl+Shift+J keeps
  // its blanc://downloads meaning on non-spatial windows)
  { action: 'downloads', scope: 'shell', key: 'j', cmdorctrl: true, alt: false, shift: false },
  // §B.8.1 — layered dismissal (Esc). The wiring skips fullscreen pages:
  // Chromium's own Escape first leaves HTML fullscreen.
  { action: 'escape', scope: 'shell', key: 'escape', cmdorctrl: false, alt: false, shift: false },
  // §B.8.3 — builder ergonomics, executed by MAIN on the focused pane.
  { action: 'reload-ignore-cache', scope: 'main', key: 'r', cmdorctrl: true, shift: true, alt: false },
  { action: 'toggle-devtools', scope: 'main', key: 'i', cmdorctrl: true, alt: true, shift: false },
  { action: 'toggle-devtools', scope: 'main', key: 'f12', cmdorctrl: false, alt: false, shift: false },
]);

const normalizeKey = (value) => {
  const key = String(value ?? '').toLowerCase();
  if (key === ' ' || key === 'space') return 'space';
  if (key === 'esc' || key === 'escape') return 'escape';
  return key;
};

/**
 * Match one Electron before-input-event input against the shell table.
 * @param {{ type?: string, key?: string, control?: boolean, meta?: boolean,
 *          alt?: boolean, shift?: boolean, isAutoRepeat?: boolean,
 *          isComposing?: boolean }} input
 * @param {{ platform?: string }} [options]
 * @returns {{ action: string, scope: 'shell'|'main' } | null} null = the key
 *   belongs to the page / Blanc's own shortcut set.
 */
function matchShellShortcut(input, { platform = process.platform } = {}) {
  if (!input || input.type !== 'keyDown') return null;
  // An IME composition and a held repeat are text/typing, not commands.
  if (input.isComposing || input.isAutoRepeat) return null;
  if (String(input.key ?? '').toLowerCase() === 'altgraph') return null;
  const key = normalizeKey(input.key);
  for (const binding of SHELL_SHORTCUT_ACTIONS) {
    if (normalizeKey(binding.key) !== key) continue;
    // CmdOrCtrl resolves to THE platform's command key, and the other one
    // must be OFF — a macOS Ctrl+L is a page chord, never the palette.
    const wantCtrl = binding.cmdorctrl === true ? platform !== 'darwin' : !!binding.ctrl;
    const wantMeta = binding.cmdorctrl === true ? platform === 'darwin' : !!binding.meta;
    if (!!input.control !== wantCtrl) continue;
    if (!!input.meta !== wantMeta) continue;
    if (!!input.alt !== !!binding.alt) continue;
    if (!!input.shift !== !!binding.shift) continue;
    return { action: binding.action, scope: binding.scope };
  }
  return null;
}

/** The shell-owned (forwarded) action ids — the contract the shell document
 *  implements in App.tsx. Pure metadata for tests and the shortcuts sheet. */
const SHELL_SCOPED_ACTIONS = Object.freeze(
  SHELL_SHORTCUT_ACTIONS.filter((b) => b.scope === 'shell').map((b) => b.action),
);
const MAIN_SCOPED_ACTIONS = Object.freeze(
  SHELL_SHORTCUT_ACTIONS.filter((b) => b.scope === 'main').map((b) => b.action),
);

module.exports = {
  SHELL_SHORTCUT_ACTIONS,
  SHELL_SCOPED_ACTIONS,
  MAIN_SCOPED_ACTIONS,
  matchShellShortcut,
};
