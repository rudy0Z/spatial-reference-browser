/**
 * app/src/App.tsx — the navigation shell, rebuilt for the Phase 1.5
 * "Zen × Blanc" flagship chrome (ZCODE_MASTER_PROMPT.md §Phase 1.5.2,
 * SPEC §3, §9, §10).
 *
 * Composition (everything else is fully store-driven, per the builder
 * contracts in lib/types.ts):
 *  - Mode A (reading): BrowserTopBar (rail · Split View · Glance ·
 *    Extensions · theme · shortcuts · Canvas — §B.1 moved Back/Forward/
 *    Reload/security onto the island itself) with the FloatingIslandPill
 *    island floating in its reserved centre slot; the Zen-style ultra-slim
 *    left rail (⌘/Ctrl+S) listing live tabs under region marks; the
 *    MockWebReader viewport — optionally SPLIT into two reader panes side
 *    by side with a clean 1px divider (click a pane to focus it, ⇄ button
 *    swaps them).
 *  - Mode B (canvas): SpatialCanvas — mounts itself as a fixed layer and
 *    gates on `viewMode` internally (its own AnimatePresence cross-fade),
 *    so it stays mounted here unconditionally.
 *  - FloatingIslandPill — always-mounted z-50 chrome: the §B.1–B.5
 *    3-Stage Island Continuum (Stage 0 resting pill with dot-morph peek ·
 *    Stage 1 dual-horizon deck · Stage 2 canvas hand-off), satellite Flow
 *    notches, drag-to-anchor drop zone. App-owned surfaces (per-node
 *    history, split view, extensions drawer) pass in as props.
 *  - NeighbourhoodGlance — right-edge overlay below the top bar; self-gates
 *    on `glanceOpen` with its own AnimatePresence exit.
 *  - ShortcutsSheet — the ? / ⌘/Ctrl+/ modal sheet that REPLACED the
 *    permanent bottom-left ShortcutLegend pill (removed per §Phase 1.5.2).
 *  - ExtensionsDrawer — the honest "extensions arrive with the desktop
 *    build" panel (informative, not a dead button).
 *  - ToastStack — the global §5.2 auto-hibernate / §6 ghost-echo surface,
 *    fed by the event bridge below.
 *
 * Theme: dark graphite default; warm-paper light via html[data-theme='paper'].
 * Persisted directly in localStorage (the graph store owns graph state only).
 *
 * §9 first run: after the persist hydration completes (zustand fires the
 * store's onRehydrateStorage → setHasHydrated even when localStorage is
 * empty), ensureFirstRunSeed() applies the seed; it is idempotent.
 *
 * §10 keys: Cmd/Ctrl+Space AND Alt+Space toggle modes; Cmd/Ctrl+L palette;
 * Alt+N quick note; Cmd/Ctrl+Shift+G glance; Cmd/Ctrl+S rail;
 * Cmd/Ctrl+/ shortcuts sheet; Esc layered dismissal (shortcuts sheet →
 * extensions drawer → palette → glance → strongest ghost → back to
 * reading). Every handler preventDefaults per the SPEC table and skips keys
 * a component already handled (defaultPrevented) or that land in a text
 * field (Esc only).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeftRight } from 'lucide-react'

import BrowserTopBar from './components/chrome/BrowserTopBar'
import ExtensionsDrawer from './components/chrome/ExtensionsDrawer'
import FloatingIslandPill from './components/chrome/FloatingIslandPill'
import NeighbourhoodGlance from './components/chrome/NeighbourhoodGlance'
import ShortcutsSheet from './components/chrome/ShortcutsSheet'
import ToastStack from './components/chrome/ToastStack'
import ZenRail, { ZEN_RAIL_WIDTH } from './components/chrome/ZenRail'
import SpatialCanvas from './components/canvas/SpatialCanvas'
import MockWebReader from './components/viewport/MockWebReader'
import { DEFAULT_PERFORMANCE_GUARDRAIL } from './lib/livePool'
import { initSpatialBridge, spatialEnabled } from './lib/spatialBridge'
import { useGraphStore } from './store/useGraphStore'
import type { GraphStore } from './store/useGraphStore'
import { useToastStore } from './store/useToastStore'
import type { MockLinkTarget, NodeUuid, SubPageRef } from './lib/types'

/**
 * Fresh-State Browser Law (master spec §0.2) — the 700-node stress fixture
 * is a dev/benchmark harness hook, never a user-facing palette command.
 * `scripts/bench-fps.mjs` drives exactly this global.
 */
declare global {
  interface Window {
    __devStressSeed?: () => void
  }
}

/** §2 motion language — spring physics everywhere, never linear. */
const CROSSFADE_SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

/* ------------------------------------------------------------------ */
/* Theme (dark default · warm paper light via data-theme='paper')      */
/* ------------------------------------------------------------------ */

type ThemeMode = 'dark' | 'paper'

const THEME_STORAGE_KEY = 'spatial.theme'

function initialTheme(): ThemeMode {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'paper' ? 'paper' : 'dark'
  } catch {
    return 'dark'
  }
}

/* ------------------------------------------------------------------ */
/* Store → toast event bridge (§5.2 auto-hibernate, §6 ghost echoes)   */
/* ------------------------------------------------------------------ */

function useGraphEventBridge(enabled: boolean) {
  /** Ghost ids already announced — ghost uuids are deterministic
   *  (`ghost:<active>:<candidate>`), so rapid A↔B tab switches re-materialize
   *  the same suggestion without re-toasting it. */
  const toastedGhostUuidsRef = useRef<ReadonlySet<string>>(new Set())
  /** Dedupe key for eviction notices (timestamp of the last one toasted). */
  const lastEvictionAtRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) return
    const pushToast = useToastStore.getState().pushToast

    // Prime the baselines AFTER the seed effect has run (App declares the
    // seeding effect first, so effects fire in that order): the §9 seed ships
    // pre-seeded ghost echoes and no eviction — none of that is "news".
    const store = useGraphStore.getState()
    const seededGhosts = new Set<string>()
    for (const node of Object.values(store.nodes)) {
      if (node.nodeType === 'ghost-echo') seededGhosts.add(node.uuid)
    }
    toastedGhostUuidsRef.current = seededGhosts
    lastEvictionAtRef.current = store.lastEviction?.at ?? null

    return useGraphStore.subscribe((state) => {
      // §5.2 — the strict live pool auto-hibernated the oldest evictable tab.
      const eviction = state.lastEviction
      if (eviction && eviction.at !== lastEvictionAtRef.current) {
        lastEvictionAtRef.current = eviction.at
        pushToast({
          kind: 'auto-hibernate',
          title: `Slept — ${eviction.title}`,
          body: `0 MB · live pool guardrail (${DEFAULT_PERFORMANCE_GUARDRAIL.maxLiveSessionTabs})`,
        })
      }

      // §6 — a ghost-echo suggestion materialized beside the active cluster.
      for (const node of Object.values(state.nodes)) {
        if (node.nodeType !== 'ghost-echo') continue
        if (toastedGhostUuidsRef.current.has(node.uuid)) continue
        toastedGhostUuidsRef.current = new Set([...toastedGhostUuidsRef.current, node.uuid])
        const match = node.ghostMatch != null ? `${Math.round(node.ghostMatch * 100)}% match` : 'resurfacing'
        pushToast({
          kind: 'ghost-echo',
          title: `Ghost Echo — ${node.title}`,
          body: `${match} · wake from the canvas or Esc to dismiss`,
        })
      }
    })
  }, [enabled])
}

/* ------------------------------------------------------------------ */
/* In-place browser history (per node) — Back / Forward / Reload       */
/* ------------------------------------------------------------------ */

type PaneHistory = {
  /** Chronological in-place navigation targets; entry 0 is the node's origin. */
  entries: MockLinkTarget[]
  index: number
}

/**
 * Pick the second Split View tab: workbench MRU first, then any live node,
 * then any other node — never ghosts, never the primary tab.
 */
function pickSplitNeighbour(state: GraphStore, primaryUuid: NodeUuid | null): NodeUuid | null {
  const candidates: NodeUuid[] = []
  const seen = new Set<NodeUuid>()
  const consider = (uuid: NodeUuid | null) => {
    if (!uuid || seen.has(uuid) || uuid === primaryUuid) return
    const node = state.nodes[uuid]
    if (!node || node.nodeType === 'ghost-echo') return
    seen.add(uuid)
    candidates.push(uuid)
  }
  for (const uuid of state.workbenchUuids) consider(uuid)
  for (const node of Object.values(state.nodes)) consider(node.uuid)
  return candidates.find((uuid) => state.nodes[uuid]?.ramState === 'live') ?? candidates[0] ?? null
}

/** Esc must not yank the viewport while a component-level editor consumes it. */
function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  )
}

/* ------------------------------------------------------------------ */
/* App shell                                                           */
/* ------------------------------------------------------------------ */

function App() {
  const hasHydrated = useGraphStore((state) => state.hasHydrated)
  const viewMode = useGraphStore((state) => state.viewMode)
  const activeNode = useGraphStore((state) => (state.activeNodeUuid ? (state.nodes[state.activeNodeUuid] ?? null) : null))
  const glanceOpen = useGraphStore((state) => state.glanceOpen)

  /* --- §9 first run: seed the graph once, after hydration ---
   * Spatial shell: main owns the graph — the local seed is skipped there. --- */
  const ensureFirstRunSeed = useGraphStore((state) => state.ensureFirstRunSeed)
  useEffect(() => {
    if (!hasHydrated || spatialEnabled) return
    ensureFirstRunSeed()
  }, [hasHydrated, ensureFirstRunSeed])

  /* --- dev/benchmark-only stress fixture (never in the user palette) --- */
  useEffect(() => {
    window.__devStressSeed = () => {
      useGraphStore.getState().seed700()
      return Object.keys(useGraphStore.getState().nodes).length
    }
    return () => {
      delete window.__devStressSeed
    }
  }, [])

  /* --- event bridge (declared after the seed effect: baselines prime post-seed) --- */
  useGraphEventBridge(hasHydrated)

  /* --- theme (dark default · warm paper light) --- */
  const [theme, setTheme] = useState<ThemeMode>(initialTheme)
  useEffect(() => {
    if (theme === 'paper') document.documentElement.dataset.theme = 'paper'
    else delete document.documentElement.dataset.theme
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // Storage unavailable (private mode) — theme still applies for the session.
    }
  }, [theme])

  /* --- Zen rail (⌘/Ctrl+S) --- */
  const [railOpen, setRailOpen] = useState(true)

  /* --- overlays (top-bar buttons + ⌘/Ctrl+/ + layered Esc) --- */
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [extensionsOpen, setExtensionsOpen] = useState(false)

  /* --- Spatial shell bridge (real browser only; no-op under vite dev) ---
   * Phase 3: when this document runs as blanc-chrome://spatial/, main owns
   * the graph and the live WebContentsViews; the bridge hydrates the store,
   * pushes ops, syncs the mode/layout and drives the z-order guard. */
  const spatialHandleRef = useRef<ReturnType<typeof initSpatialBridge>>(null)
  useEffect(() => {
    const handle = initSpatialBridge()
    spatialHandleRef.current = handle
    return () => {
      handle?.dispose()
      spatialHandleRef.current = null
    }
  }, [])
  useEffect(() => {
    spatialHandleRef.current?.setShellOverlaysOpen(shortcutsOpen || extensionsOpen)
  }, [shortcutsOpen, extensionsOpen])
  useEffect(() => {
    spatialHandleRef.current?.setRailWidth(railOpen ? ZEN_RAIL_WIDTH : 0)
  }, [railOpen])

  /* --- Split View (two reader panes, 1px divider) --- */
  const [splitOpen, setSplitOpen] = useState(false)
  const [splitLeftUuid, setSplitLeftUuid] = useState<NodeUuid | null>(null)
  const [splitRightUuid, setSplitRightUuid] = useState<NodeUuid | null>(null)
  const splitLeftNode = useGraphStore((state) => (splitLeftUuid ? (state.nodes[splitLeftUuid] ?? null) : null))
  const splitRightNode = useGraphStore((state) => (splitRightUuid ? (state.nodes[splitRightUuid] ?? null) : null))

  /* --- per-node in-place history for Back/Forward (mock reader wiring) --- */
  const historyRef = useRef<Map<NodeUuid, PaneHistory>>(new Map())
  const [historyVersion, setHistoryVersion] = useState(0)

  const pushHistory = useCallback((uuid: NodeUuid, previous: { url: string; title: string }, target: MockLinkTarget) => {
    const history = historyRef.current.get(uuid)
    if (!history) {
      historyRef.current.set(uuid, { entries: [previous, target], index: 1 })
    } else if (history.entries[history.index]?.url !== target.url) {
      history.entries = [...history.entries.slice(0, history.index + 1), target]
      history.index += 1
    }
    setHistoryVersion((version) => version + 1)
  }, [])

  const navigateInPane = useCallback(
    (uuid: NodeUuid, target: MockLinkTarget) => {
      const state = useGraphStore.getState()
      const node = state.nodes[uuid]
      if (!node) return
      pushHistory(uuid, { url: node.url, title: node.title }, target)
      // Normal click navigates the pane's own tab in place (§5.1); focusing a
      // split pane first keeps the store's single active-node model honest.
      if (state.activeNodeUuid !== uuid) state.activateNode(uuid)
      useGraphStore.getState().navigateActiveNode(target.url, target.title, target.searchQuery)
    },
    [pushHistory],
  )

  const branchFrom = useCallback((uuid: NodeUuid, target: MockLinkTarget) => {
    useGraphStore.getState().spawnChildNode(uuid, {
      url: target.url,
      title: target.title,
      searchQuery: target.searchQuery,
    })
  }, [])

  const subNavigateIn = useCallback((uuid: NodeUuid, sub: SubPageRef) => {
    useGraphStore.getState().pushSubPage(uuid, sub)
  }, [])

  const goBack = useCallback(() => {
    const state = useGraphStore.getState()
    const uuid = state.activeNodeUuid
    if (!uuid) return
    const history = historyRef.current.get(uuid)
    if (!history || history.index <= 0) return
    const entry = history.entries[history.index - 1]
    if (!entry) return
    history.index -= 1
    setHistoryVersion((version) => version + 1)
    state.navigateActiveNode(entry.url, entry.title, entry.searchQuery)
  }, [])

  const goForward = useCallback(() => {
    const state = useGraphStore.getState()
    const uuid = state.activeNodeUuid
    if (!uuid) return
    const history = historyRef.current.get(uuid)
    if (!history || history.index >= history.entries.length - 1) return
    const entry = history.entries[history.index + 1]
    if (!entry) return
    history.index += 1
    setHistoryVersion((version) => version + 1)
    state.navigateActiveNode(entry.url, entry.title, entry.searchQuery)
  }, [])

  const activeHistory = useMemo(
    () => (activeNode ? (historyRef.current.get(activeNode.uuid) ?? null) : null),
    // historyVersion invalidates the ref-derived read after every mutation.
    [activeNode, historyVersion],
  )
  const canBack = activeHistory !== null && activeHistory.index > 0
  const canForward = activeHistory !== null && activeHistory.index < activeHistory.entries.length - 1

  /** Reload: re-navigate the active tab's current URL (fresh pulse + scroll reset). */
  const [reloadNonce, setReloadNonce] = useState(0)
  const handleReload = useCallback(() => {
    const state = useGraphStore.getState()
    const uuid = state.activeNodeUuid
    const node = uuid ? state.nodes[uuid] : null
    if (!uuid || !node) return
    state.navigateActiveNode(node.url, node.title, node.searchQuery ?? undefined)
    setReloadNonce((nonce) => nonce + 1)
  }, [])

  /* --- Split View actions --- */
  const handleToggleSplit = useCallback(() => {
    const state = useGraphStore.getState()
    if (splitOpen) {
      setSplitOpen(false)
      return
    }
    const left = state.activeNodeUuid ?? state.createNewTab()
    const right = pickSplitNeighbour(state, left) ?? state.createNewTab()
    setSplitLeftUuid(left)
    setSplitRightUuid(right)
    setSplitOpen(true)
  }, [splitOpen])

  /** Swap the two panes; focus follows the content that lands on the left. */
  const swapPanes = useCallback(() => {
    const left = splitLeftUuid
    const right = splitRightUuid
    if (!left || !right) return
    setSplitLeftUuid(right)
    setSplitRightUuid(left)
    const state = useGraphStore.getState()
    if (state.activeNodeUuid !== right) state.activateNode(right)
  }, [splitLeftUuid, splitRightUuid])

  /** Clicking a pane focuses its tab (pill/bar/toolbar then act on it). */
  const focusPane = useCallback((uuid: NodeUuid) => {
    const state = useGraphStore.getState()
    if (state.activeNodeUuid !== uuid) state.activateNode(uuid)
  }, [])

  /** Keep the split healthy: if the right tab vanished, re-pick or close. */
  useEffect(() => {
    if (!splitOpen || !splitRightUuid) return
    const state = useGraphStore.getState()
    if (state.nodes[splitRightUuid]) return
    const right = pickSplitNeighbour(state, state.activeNodeUuid)
    if (right) setSplitRightUuid(right)
    else setSplitOpen(false)
  }, [splitOpen, splitRightUuid])

  /* --- §10 global keys (extended with rail + shortcuts sheet) --- */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return
      const store = useGraphStore.getState()
      const mod = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()

      // §10 — Cmd/Ctrl+Space AND Alt+Space: toggle Canvas ⇄ Reading.
      if (event.code === 'Space' && (mod || event.altKey)) {
        event.preventDefault()
        store.toggleCanvas()
        return
      }

      // §10 — Cmd/Ctrl+L: command palette (browser address-bar collision).
      if (mod && !event.shiftKey && !event.altKey && key === 'l') {
        event.preventDefault()
        store.togglePalette()
        return
      }

      // Phase 1.5 — Cmd/Ctrl+S: Zen-style ultra-slim rail (save-dialog collision).
      if (mod && !event.shiftKey && !event.altKey && key === 's') {
        event.preventDefault()
        setRailOpen((open) => !open)
        return
      }

      // Phase 1.5 — Cmd/Ctrl+/: shortcuts sheet (replaces ShortcutLegend).
      if (mod && !event.altKey && (event.key === '/' || event.code === 'Slash')) {
        event.preventDefault()
        setShortcutsOpen((open) => !open)
        return
      }

      // §10 — Alt+N: quick sticky note on the active node.
      if (event.altKey && !mod && !event.shiftKey && key === 'n') {
        event.preventDefault()
        store.quickNoteOnActive()
        return
      }

      // §10 — Cmd/Ctrl+Shift+G: neighbourhood glance.
      if (mod && event.shiftKey && key === 'g') {
        event.preventDefault()
        store.toggleGlance()
        return
      }

      // §10 — Esc: layered dismissal (overlays first, then ghost, then mode).
      if (event.key === 'Escape' && !isTypingTarget(event.target)) {
        if (shortcutsOpen) {
          setShortcutsOpen(false)
          return
        }
        if (extensionsOpen) {
          setExtensionsOpen(false)
          return
        }
        if (store.paletteOpen) {
          store.setPaletteOpen(false)
          return
        }
        if (store.glanceOpen) {
          store.setGlanceOpen(false)
          return
        }
        const strongestGhost = Object.values(store.nodes)
          .filter((node) => node.nodeType === 'ghost-echo' && node.ghostTetherUuid === store.activeNodeUuid)
          .sort((a, b) => (b.ghostMatch ?? 0) - (a.ghostMatch ?? 0))[0]
        if (strongestGhost) {
          store.dismissGhostEcho(strongestGhost.uuid)
          return
        }
        if (store.viewMode === 'canvas') {
          store.setViewMode('reading')
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [shortcutsOpen, extensionsOpen])

  /* --- Mode B takeover closes reading-only overlays so they never
         re-appear stale when returning to the viewport --- */
  useEffect(() => {
    if (viewMode === 'canvas') {
      setShortcutsOpen(false)
      setExtensionsOpen(false)
    }
  }, [viewMode])

  /* --- document title follows the active tab (index.html carries the default) --- */
  useEffect(() => {
    document.title = activeNode ? `${activeNode.title} — Spatial` : 'Spatial — Phase 1.5'
  }, [activeNode])

  return (
    <div className="fixed inset-0 overflow-hidden bg-void font-sans tracking-ui">
      {/* ---- Mode A: flagship reading chrome (cross-fades out on toggle) ---- */}
      <AnimatePresence initial={false}>
        {viewMode === 'reading' ? (
          <motion.div
            key="mode-a-chrome"
            className="absolute inset-0 z-20"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={CROSSFADE_SPRING}
          >
            <BrowserTopBar
              railOpen={railOpen}
              onToggleRail={() => setRailOpen((open) => !open)}
              splitOpen={splitOpen}
              onToggleSplit={handleToggleSplit}
              glanceOpen={glanceOpen}
              onToggleGlance={() => useGraphStore.getState().toggleGlance()}
              extensionsOpen={extensionsOpen}
              onToggleExtensions={() => setExtensionsOpen((open) => !open)}
              onToggleShortcuts={() => setShortcutsOpen((open) => !open)}
              theme={theme}
              onToggleTheme={() => setTheme((current) => (current === 'paper' ? 'dark' : 'paper'))}
              onToggleCanvas={() => useGraphStore.getState().toggleCanvas()}
            />

            {/* Zen-style ultra-slim left rail (⌘/Ctrl+S) — collapsing yields
                full-bleed reading; the content offset animates in lockstep. */}
            <AnimatePresence initial={false}>
              {railOpen ? (
                <motion.div
                  key="zen-rail"
                  className="absolute bottom-0 left-0 top-12 z-30 overflow-hidden"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: ZEN_RAIL_WIDTH, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={CROSSFADE_SPRING}
                >
                  <ZenRail />
                </motion.div>
              ) : null}
            </AnimatePresence>

            {/* reading viewport — sits below the 48px bar, right of the rail */}
            <motion.div
              className="absolute bottom-0 right-0 top-12"
              animate={{ left: railOpen ? ZEN_RAIL_WIDTH : 0 }}
              transition={CROSSFADE_SPRING}
            >
              {splitOpen && splitLeftNode && splitRightNode ? (
                <div className="flex h-full w-full">
                  <div className="min-w-0 flex-1" onPointerDown={() => focusPane(splitLeftNode.uuid)}>
                    <MockWebReader
                      key={`split-left-${reloadNonce}`}
                      node={splitLeftNode}
                      onNavigate={(target) => navigateInPane(splitLeftNode.uuid, target)}
                      onBranch={(target) => branchFrom(splitLeftNode.uuid, target)}
                      onSubNavigate={(sub) => subNavigateIn(splitLeftNode.uuid, sub)}
                    />
                  </div>

                  {/* the clean 1px divider + pane swap */}
                  <div className="relative w-px shrink-0 bg-hairline">
                    <button
                      type="button"
                      onClick={swapPanes}
                      title="Swap panes"
                      aria-label="Swap split panes"
                      className="absolute left-1/2 top-5 z-10 flex size-6 -translate-x-1/2 items-center justify-center rounded-full border border-hairline text-[color:var(--ink-secondary)] transition-colors hover:border-[color:var(--border-hover)] hover:text-[color:var(--ink-primary)]"
                      style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-card)' }}
                    >
                      <ArrowLeftRight size={11} strokeWidth={1.75} aria-hidden />
                    </button>
                  </div>

                  <div className="min-w-0 flex-1" onPointerDown={() => focusPane(splitRightNode.uuid)}>
                    <MockWebReader
                      key={`split-right-${reloadNonce}`}
                      node={splitRightNode}
                      onNavigate={(target) => navigateInPane(splitRightNode.uuid, target)}
                      onBranch={(target) => branchFrom(splitRightNode.uuid, target)}
                      onSubNavigate={(sub) => subNavigateIn(splitRightNode.uuid, sub)}
                    />
                  </div>
                </div>
              ) : activeNode ? (
                <MockWebReader
                  key={`reader-${reloadNonce}`}
                  node={activeNode}
                  onNavigate={(target) => navigateInPane(activeNode.uuid, target)}
                  onBranch={(target) => branchFrom(activeNode.uuid, target)}
                  onSubNavigate={(sub) => subNavigateIn(activeNode.uuid, sub)}
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <p className="text-[12px] text-[color:var(--ink-muted)]">
                    {hasHydrated ? 'Seeding spatial graph…' : 'Loading…'}
                  </p>
                </div>
              )}
            </motion.div>

            {/* §3 neighbourhood glance: right-edge overlay below the bar,
                self-gates on glanceOpen */}
            <div className="pointer-events-none absolute bottom-0 right-0 top-12 z-30 flex justify-end">
              <NeighbourhoodGlance className="pointer-events-auto" />
            </div>

            {/* informative overlays (extensions drawer + shortcuts sheet) */}
            <ExtensionsDrawer open={extensionsOpen} onClose={() => setExtensionsOpen(false)} />
            <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ---- Mode B: infinite spatial canvas (self-gates on viewMode, fixed z-10) ---- */}
      <SpatialCanvas />

      {/* ---- global chrome: the 3-Stage Island Continuum floats in the top
              bar's centre slot (Stage 0 pill ⇄ Stage 1 deck ⇄ Stage 2 canvas),
              visible in both view modes. App-owned surfaces — per-node
              history, split view, the extensions drawer — pass in as props;
              everything else is store-driven. ---- */}
      <FloatingIslandPill
        canBack={canBack}
        canForward={canForward}
        onBack={goBack}
        onForward={goForward}
        onReload={handleReload}
        onToggleSplit={handleToggleSplit}
        onToggleExtensions={() => setExtensionsOpen((open) => !open)}
      />
      {/* toasts sit clear of the rail when it is open (its fixed left-3 default
          is overridden via twMerge in ToastStack) */}
      <ToastStack className={railOpen ? 'left-[236px]' : 'left-3'} />
    </div>
  )
}

export default App
