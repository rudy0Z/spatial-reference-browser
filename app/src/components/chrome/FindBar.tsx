/**
 * app/src/components/chrome/FindBar.tsx — §B.8.1 find lane.
 *
 * The matte floating find bar of the spatial shell. A live page (a native
 * WebContentsView) cannot be searched from the chrome document directly:
 * main's arbitration forwards Cmd/Ctrl+F here, and every query/repeat/stop
 * rides `spatial:find:control` onto the active pane (main.js
 * spatialFindControl), with match counts streaming back over
 * `spatial:find:result`. Same grammar as the rest of the chrome: glass
 * surface, hairline border, spring 380/30, sentence case, no neon.
 *
 * Non-spatial (prototype) builds never mount this — the window document
 * receives its own keyboard events there.
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ChevronUp, X } from 'lucide-react'

import { spatialApi } from '../../lib/spatialBridge'

const SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

export type FindBarProps = {
  open: boolean
  onClose: () => void
}

function FindBar({ open, onClose }: FindBarProps) {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<{ total: number; active: number }>({ total: 0, active: 0 })
  const inputRef = useRef<HTMLInputElement>(null)
  const openRef = useRef(open)
  openRef.current = open

  // Match counts stream from main while a search is live.
  useEffect(() => {
    if (!spatialApi || !open) return
    return spatialApi.onFindResult(({ matches, activeMatchOrdinal }) => {
      setMatches({ total: matches, active: activeMatchOrdinal })
    })
  }, [open])

  // Fresh open = fresh search. Focus lands in the field immediately.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setMatches({ total: 0, active: 0 })
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 20)
    return () => window.clearTimeout(focusTimer)
  }, [open])

  const close = () => {
    void spatialApi?.findControl('stop')
    onClose()
  }

  // §B.8.1 — Escape dismisses the bar (layered dismissal covers it after
  // overlays: this component is the topmost layer while open).
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      void spatialApi?.findControl(event.shiftKey ? 'prev' : 'next', query)
    }
  }

  // Start a search once the query has settled (findInPage is cheap, but a
  // started search on every keystroke would thrash the highlight pass).
  useEffect(() => {
    if (!spatialApi || !open) return
    if (query.trim() === '') return
    const timer = window.setTimeout(() => {
      void spatialApi?.findControl('start', query)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [query, open])

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="matte-find-bar"
          role="search"
          aria-label="Find in page"
          className="pointer-events-auto absolute right-4 top-1.5 z-50 flex h-9 items-center gap-1 rounded-lg border border-hairline bg-surface-glass px-2 shadow-[var(--shadow-pop)] backdrop-blur-xl"
          initial={{ opacity: 0, y: -10, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.97, transition: { duration: 0.15, ease: 'easeIn' } }}
          transition={SPRING}
        >
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find in page"
            aria-label="Find in page"
            spellCheck={false}
            className="w-52 bg-transparent text-[12px] text-[color:var(--ink-primary)] outline-none placeholder:text-[color:var(--ink-muted)]"
          />
          <span className="min-w-[54px] text-right text-[10px] tracking-ui text-[color:var(--ink-muted)]" aria-live="polite">
            {query.trim() === '' ? '' : matches.total > 0 ? `${matches.active}/${matches.total}` : 'No matches'}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            onClick={() => void spatialApi?.findControl('prev', query)}
            className="rounded p-1 text-[color:var(--ink-muted)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
          >
            <ChevronUp size={12} />
          </button>
          <button
            type="button"
            aria-label="Next match"
            onClick={() => void spatialApi?.findControl('next', query)}
            className="rounded p-1 text-[color:var(--ink-muted)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
          >
            <ChevronDown size={12} />
          </button>
          <button
            type="button"
            aria-label="Close find bar"
            onClick={close}
            className="rounded p-1 text-[color:var(--ink-muted)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
          >
            <X size={12} />
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export default FindBar
