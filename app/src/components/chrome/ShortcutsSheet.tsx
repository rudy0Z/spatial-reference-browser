/**
 * app/src/components/chrome/ShortcutsSheet.tsx — the Phase 1.5 replacement
 * for the permanent bottom-left ShortcutLegend pill (removed per
 * ZCODE_MASTER_PROMPT.md §Phase 1.5.2): a clean ⌘/Ctrl+/ (or "?" button)
 * modal sheet that documents every shortcut, so nothing conflicts silently
 * with the host OS (SPEC §10 intent, relocated).
 *
 * Matte elevated surface, sentence case, `--font-mono` reserved for the
 * <kbd> hints themselves. Opens/closes via the app shell; Esc and scrim
 * click close locally (the shell's layered Esc dismissal backs this up).
 */

import { AnimatePresence, motion } from 'framer-motion'
import { Keyboard, X } from 'lucide-react'
import type { ReactNode } from 'react'

/** §2 motion language — spring physics everywhere, never linear. */
const SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

type ShortcutRow = { keys: ReactNode; action: string }

const SECTIONS: ReadonlyArray<{ title: string; rows: readonly ShortcutRow[] }> = [
  {
    title: 'Views',
    rows: [
      { keys: '⌘/Ctrl Space · Alt Space', action: 'Toggle canvas ⇄ reading' },
      { keys: '⌘/Ctrl L', action: 'Command palette' },
      { keys: '⌘/Ctrl S', action: 'Toggle tab rail' },
      { keys: '⌘/Ctrl ⇧ G', action: 'Neighbourhood glance' },
    ],
  },
  {
    title: 'Reading',
    rows: [
      { keys: 'Alt N', action: 'Quick sticky note on the active page' },
      { keys: '⌘/Ctrl Click', action: 'Branch a link into a child node' },
      { keys: '⌘/Ctrl Click drag', action: 'Drag a link onto the island to anchor it' },
    ],
  },
  {
    title: 'General',
    rows: [
      { keys: '⌘/Ctrl /', action: 'This shortcuts sheet' },
      { keys: 'Esc', action: 'Close overlays · dismiss ghost · back to reading' },
    ],
  },
]

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-hairline bg-[color:var(--glass-soft)] px-1.5 py-0.5 font-mono text-[10px] leading-[16px] text-[color:var(--ink-secondary)]">
      {children}
    </kbd>
  )
}

export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="shortcuts-sheet"
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={SPRING}
        >
          {/* scrim */}
          <button
            type="button"
            aria-label="Close shortcuts"
            onClick={onClose}
            className="absolute inset-0 cursor-default bg-void/60"
          />

          <motion.div
            role="dialog"
            aria-label="Keyboard shortcuts"
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={SPRING}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                onClose()
              }
            }}
            className="relative flex max-h-[min(78vh,560px)] w-[min(92vw,440px)] flex-col overflow-hidden rounded-2xl border border-hairline"
            style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-4 py-3">
              <Keyboard size={14} strokeWidth={1.75} className="shrink-0 text-[color:var(--ink-muted)]" aria-hidden />
              <h2 className="text-[13px] font-medium text-[color:var(--ink-primary)]">Keyboard shortcuts</h2>
              <button
                type="button"
                onClick={onClose}
                title="Close"
                aria-label="Close shortcuts"
                className="ml-auto flex size-6 items-center justify-center rounded-md text-[color:var(--ink-muted)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
              >
                <X size={13} strokeWidth={1.75} aria-hidden />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 [scrollbar-color:var(--border-hover)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[color:var(--border-hover)]">
              {SECTIONS.map((section) => (
                <section key={section.title} className="mb-3 last:mb-0">
                  <h3 className="px-1 pb-1.5 text-[10px] font-medium text-[color:var(--ink-muted)]">{section.title}</h3>
                  <div className="overflow-hidden rounded-xl border border-hairline">
                    {section.rows.map((row) => (
                      <div
                        key={row.action}
                        className="flex items-center justify-between gap-3 border-b border-hairline px-3 py-2 last:border-b-0"
                      >
                        <span className="min-w-0 text-[12.5px] leading-snug text-[color:var(--ink-primary)]">{row.action}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          <Kbd>{row.keys}</Kbd>
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
              <p className="px-1 pt-1 text-[11px] leading-relaxed text-[color:var(--ink-muted)]">
                Split view, extensions and the theme live in the top bar. Toolbar actions always work without modifiers.
              </p>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export default ShortcutsSheet
