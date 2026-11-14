/**
 * app/src/App.tsx — the navigation shell (SPEC §3, §9, §10).
 *
 * Composition (everything else is fully store-driven, per the builder
 * contracts in lib/types.ts):
 *  - Mode A (reading): full-bleed MockWebReader on the active node.
 *  - Mode B (canvas):  SpatialCanvas — mounts itself as a fixed layer and
 *    gates on `viewMode` internally (its own AnimatePresence cross-fade),
 *    so it stays mounted here unconditionally.
 *  - FloatingIslandPill — always-mounted z-50 chrome (pill ⇄ palette morph,
 *    §6 neighbour dots, drag-to-anchor drop zone).
 *  - NeighbourhoodGlance — right-edge overlay; self-gates on `glanceOpen`
 *    with its own AnimatePresence exit, we only position it.
 *  - ToastStack — the global §5.2 auto-hibernate / §6 ghost-echo surface,
 *    fed by the event bridge below.
 *  - ShortcutLegend — §10 "on-screen shortcut hint chips … visible so
 *    nothing conflicts silently with the host OS".
 *
 * §9 first run: after the persist hydration completes (zustand fires the
 * store's onRehydrateStorage → setHasHydrated even when localStorage is
 * empty — verified against zustand 5.1 middleware.js), ensureFirstRunSeed()
 * applies the 28-tab seed; it is idempotent (seededVersion guard).
 *
 * §10 keys: Cmd/Ctrl+Space AND Alt+Space toggle modes; Cmd/Ctrl+L palette;
 * Alt+N quick note; Cmd/Ctrl+Shift+G glance; Esc layered dismissal
 * (palette → glance → strongest ghost → back to reading). Every handler
 * preventDefaults per the SPEC table and skips keys a component already
 * handled (defaultPrevented) or that land in a text field (Esc only).
 */
import { useCallback, useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Keyboard } from 'lucide-react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

import FloatingIslandPill from './components/chrome/FloatingIslandPill'
import NeighbourhoodGlance from './components/chrome/NeighbourhoodGlance'
import ToastStack from './components/chrome/ToastStack'
import SpatialCanvas from './components/canvas/SpatialCanvas'
import MockWebReader from './components/viewport/MockWebReader'
import { LIVE_POOL_LIMIT, useGraphStore } from './store/useGraphStore'
import { useToastStore } from './store/useToastStore'
import type { MockLinkTarget, SubPageRef } from './lib/types'

/** No shared cn() utility exists yet — same file-local copy the other builders use. */
function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** §2 motion language — spring physics everywhere, never linear. */
const CROSSFADE_SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

/* ------------------------------------------------------------------ */
/* §10 shortcut hint chips                                             */
/* ------------------------------------------------------------------ */

const SHORTCUT_HINTS: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: '⌘/Ctrl+Space · Alt+Space', label: 'Canvas' },
  { keys: '⌘/Ctrl+L', label: 'Palette' },
  { keys: 'Alt+N', label: 'Note' },
  { keys: '⌘/Ctrl+⇧G', label: 'Glance' },
  { keys: 'Esc', label: 'Back' },
]

function ShortcutLegend({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none fixed bottom-2 left-3 z-40 flex max-w-[calc(100vw-24px)] items-center gap-2 overflow-hidden rounded-full border border-hairline bg-surface-glass/70 px-2.5 py-1 shadow-[0_6px_24px_rgba(0,0,0,0.45)] backdrop-blur-md',
        className,
      )}
    >
      <Keyboard size={11} className="shrink-0 text-white/30" />
      {SHORTCUT_HINTS.map((hint) => (
        <span key={hint.keys} className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          <kbd className="rounded border border-white/10 bg-white/[0.06] px-1 py-px font-mono text-[8.5px] tracking-wide text-white/55">
            {hint.keys}
          </kbd>
          <span className="text-[9px] tracking-wide text-white/35">{hint.label}</span>
        </span>
      ))}
    </div>
  )
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
    // two pre-seeded ghost echoes and no eviction — none of that is "news".
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
          body: `0 MB · live pool limit (${LIVE_POOL_LIMIT})`,
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
/* §10 global keyboard map                                             */
/* ------------------------------------------------------------------ */

/** Esc must not yank the viewport while a component-level editor consumes it. */
function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  )
}

function useGlobalShortcuts() {
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

      // §10 — Esc: layered dismissal.
      if (event.key === 'Escape' && !isTypingTarget(event.target)) {
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
  }, [])
}

/* ------------------------------------------------------------------ */
/* App shell                                                           */
/* ------------------------------------------------------------------ */

function App() {
  const hasHydrated = useGraphStore((state) => state.hasHydrated)
  const viewMode = useGraphStore((state) => state.viewMode)
  const activeNode = useGraphStore((state) => (state.activeNodeUuid ? (state.nodes[state.activeNodeUuid] ?? null) : null))

  /* --- §9 first run: seed the 28-tab graph once, after hydration --- */
  const ensureFirstRunSeed = useGraphStore((state) => state.ensureFirstRunSeed)
  useEffect(() => {
    if (!hasHydrated) return
    ensureFirstRunSeed()
  }, [hasHydrated, ensureFirstRunSeed])

  /* --- event bridge (declared after the seed effect: baselines prime post-seed) --- */
  useGraphEventBridge(hasHydrated)

  /* --- §10 global keys --- */
  useGlobalShortcuts()

  /* --- document title follows the active tab (index.html carries the default) --- */
  useEffect(() => {
    document.title = activeNode ? `${activeNode.title} — Spatial Canvas` : 'Spatial Canvas — Phase 1'
  }, [activeNode])

  /* --- MockWebReader callbacks (§5.1, §7.3) --- */
  const handleNavigate = useCallback((target: MockLinkTarget) => {
    useGraphStore.getState().navigateActiveNode(target.url, target.title, target.searchQuery)
  }, [])

  const handleBranch = useCallback((target: MockLinkTarget) => {
    const parentUuid = useGraphStore.getState().activeNodeUuid
    if (!parentUuid) return
    useGraphStore.getState().spawnChildNode(parentUuid, {
      url: target.url,
      title: target.title,
      searchQuery: target.searchQuery,
    })
  }, [])

  const handleSubNavigate = useCallback((sub: SubPageRef) => {
    const uuid = useGraphStore.getState().activeNodeUuid
    if (!uuid) return
    useGraphStore.getState().pushSubPage(uuid, sub)
  }, [])

  return (
    <div className="fixed inset-0 overflow-hidden bg-void font-sans tracking-ui">
      {/* ---- Mode A: focused reading viewport (cross-fades out on toggle) ---- */}
      <div className="absolute inset-0 z-0">
        <AnimatePresence initial={false}>
          {viewMode === 'reading' && activeNode ? (
            <motion.div
              key="reading-viewport"
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={CROSSFADE_SPRING}
            >
              <MockWebReader
                node={activeNode}
                onNavigate={handleNavigate}
                onBranch={handleBranch}
                onSubNavigate={handleSubNavigate}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        {viewMode === 'reading' && !activeNode ? (
          <div className="flex h-full items-center justify-center">
            <p className="font-mono text-[11px] tracking-[0.22em] text-white/35 uppercase">
              {hasHydrated ? 'Seeding spatial graph…' : 'Hydrating…'}
            </p>
          </div>
        ) : null}
      </div>

      {/* ---- Mode B: infinite spatial canvas (self-gates on viewMode, fixed z-10) ---- */}
      <SpatialCanvas />

      {/* ---- §3 neighbourhood glance: right-edge overlay, self-gates on glanceOpen ---- */}
      <div className="pointer-events-none fixed inset-y-0 right-0 z-30 flex justify-end">
        <NeighbourhoodGlance className="pointer-events-auto" />
      </div>

      {/* ---- chrome ---- */}
      <FloatingIslandPill />
      <ToastStack />
      <ShortcutLegend />
    </div>
  )
}

export default App
