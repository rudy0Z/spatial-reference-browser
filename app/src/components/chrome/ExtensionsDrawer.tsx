/**
 * app/src/components/chrome/ExtensionsDrawer.tsx — the quiet Extensions
 * button's drawer (ZCODE_MASTER_PROMPT.md §Phase 1.5.2): an honest,
 * informative panel stating that extension support arrives with the desktop
 * build (Phase 4 wires `electron-chrome-extensions` + Web Store installs).
 * Not a dead button — the drawer explains what will land and why this
 * preview can't host extensions yet. Matte chrome, sentence case, no neon.
 */

import { AnimatePresence, motion } from 'framer-motion'
import { KeyRound, Puzzle, ShieldCheck, SlidersHorizontal, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** §2 motion language — spring physics everywhere, never linear. */
const SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

const PLANNED: ReadonlyArray<{ icon: LucideIcon; label: string }> = [
  { icon: Puzzle, label: 'Chrome Web Store installs — paste a URL or extension ID' },
  { icon: ShieldCheck, label: 'Built-in network adblocking, with optional uBlock Origin' },
  { icon: KeyRound, label: '1Password desktop integration' },
  { icon: SlidersHorizontal, label: 'Toolbar action popovers and “Load unpacked” folders' },
]

export function ExtensionsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          key="extensions-drawer"
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 40, opacity: 0 }}
          transition={SPRING}
          role="dialog"
          aria-label="Extensions"
          className={cn(
            'fixed bottom-0 right-0 top-12 z-[60] flex w-[320px] max-w-[86vw] flex-col border-l border-hairline',
          )}
          style={{ background: 'var(--bg-glass)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', boxShadow: 'var(--shadow-pop)' }}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-4 py-3">
            <Puzzle size={14} strokeWidth={1.75} className="shrink-0 text-[color:var(--ink-muted)]" aria-hidden />
            <h2 className="text-[13px] font-medium text-[color:var(--ink-primary)]">Extensions</h2>
            <button
              type="button"
              onClick={onClose}
              title="Close"
              aria-label="Close extensions panel"
              className="ml-auto flex size-6 items-center justify-center rounded-md text-[color:var(--ink-muted)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
            >
              <X size={13} strokeWidth={1.75} aria-hidden />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 [scrollbar-color:var(--border-hover)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[color:var(--border-hover)]">
            <p className="text-[12.5px] leading-relaxed text-[color:var(--ink-secondary)]">
              Extension support arrives with the desktop build. This preview renders simulated pages in the browser tab
              itself, so there is no extension host to load into yet.
            </p>

            <h3 className="px-0 pb-1.5 pt-4 text-[10px] font-medium text-[color:var(--ink-muted)]">Planned for the desktop build</h3>
            <div className="overflow-hidden rounded-xl border border-hairline">
              {PLANNED.map(({ icon: Icon, label }) => (
                <div key={label} className="flex items-start gap-2.5 border-b border-hairline px-3 py-2.5 last:border-b-0">
                  <Icon size={13} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[color:var(--ink-muted)]" aria-hidden />
                  <span className="min-w-0 text-[12px] leading-snug text-[color:var(--ink-secondary)]">{label}</span>
                </div>
              ))}
            </div>

            <p className="pt-4 text-[11px] leading-relaxed text-[color:var(--ink-muted)]">
              The Electron shell (Phases 3–4) mounts the real Chromium extension host on the browsing session — this
              panel becomes the manager then.
            </p>
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  )
}

export default ExtensionsDrawer
