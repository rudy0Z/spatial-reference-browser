/**
 * app/src/components/chrome/ExternalHandoffToast.tsx — §B.8.2 lane.
 *
 * Confirmation toast for external app protocols (figma://, vscode://,
 * cursor://, mailto:, discord://, spotify://, slack://). Main's scheme
 * classifier (spatial/scheme-classifier.js) names the app; this toast asks
 * the one question the spec demands ("the system pays, the user confirms")
 * and answers through `spatial:external:respond` — main re-resolves the URL
 * from the request id, so the renderer can never substitute a target.
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUpRight, X } from 'lucide-react'

import { spatialApi } from '../../lib/spatialBridge'

const SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

export type ExternalConfirmRequest = {
  requestId: string
  url: string
  origin: string | null
}

const APP_LABELS: Record<string, string> = {
  figma: 'Figma',
  vscode: 'VS Code',
  cursor: 'Cursor',
  mail: 'your mail app',
  discord: 'Discord',
  spotify: 'Spotify',
  slack: 'Slack',
}

function appLabelFrom(url: string): string {
  const scheme = url.slice(0, url.indexOf(':')).toLowerCase()
  return APP_LABELS[scheme] ?? 'another app'
}

function ExternalHandoffToast({ onVisible }: { onVisible?: (visible: boolean) => void }) {
  const [request, setRequest] = useState<ExternalConfirmRequest | null>(null)
  const autoDismissTimer = useRef<number | null>(null)

  useEffect(() => {
    if (!spatialApi) return
    return spatialApi.onExternalConfirm((payload) => {
      if (autoDismissTimer.current !== null) window.clearTimeout(autoDismissTimer.current)
      setRequest(payload)
      // A toast nobody answers self-dismisses; main's pending entry expires
      // on its own 60 s TTL, so a late confirm is a no-op either way.
      autoDismissTimer.current = window.setTimeout(() => setRequest(null), 30_000)
    })
  }, [])

  // §B.8 z-order honesty: the confirmation must paint over the live view —
  // App engages the shell's z-order guard while it shows.
  useEffect(() => {
    onVisible?.(request != null)
    return () => onVisible?.(false)
  }, [request != null, onVisible])

  const answer = (allow: boolean) => {
    const current = request
    if (!current || !spatialApi) return
    void spatialApi.externalRespond(current.requestId, allow)
    setRequest(null)
  }

  const appLabel = request ? appLabelFrom(request.url) : ''

  return (
    <AnimatePresence>
      {request ? (
        <motion.div
          key={`external-${request.requestId}`}
          role="alertdialog"
          aria-label="Open in another app"
          className="pointer-events-auto absolute bottom-14 left-4 z-50 w-[320px] rounded-xl border border-hairline bg-surface-glass p-3 shadow-[var(--shadow-pop)] backdrop-blur-xl"
          initial={{ opacity: 0, y: 12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.15, ease: 'easeIn' } }}
          transition={SPRING}
        >
          <div className="flex items-start gap-2">
            <ArrowUpRight size={14} className="mt-0.5 shrink-0 text-[color:var(--ink-muted)]" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium leading-tight text-[color:var(--ink-primary)]">
                Open in {appLabel}?
              </p>
              <p className="mt-0.5 truncate text-[10px] tracking-ui text-[color:var(--ink-muted)]">
                {request.origin ? `${appLabel} link from ${new URL(request.origin).host}` : `${appLabel} link`}
              </p>
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => answer(false)}
              className="rounded p-1 text-[color:var(--ink-muted)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
            >
              <X size={11} />
            </button>
          </div>
          <div className="mt-2.5 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => answer(false)}
              className="rounded-lg border border-hairline px-2.5 py-1 text-[11px] text-[color:var(--ink-secondary)] transition-colors hover:border-[color:var(--border-hover)] hover:text-[color:var(--ink-primary)]"
            >
              Stay here
            </button>
            <button
              type="button"
              onClick={() => answer(true)}
              className="rounded-lg border border-hairline bg-[color:var(--bg-elevated)] px-2.5 py-1 text-[11px] text-[color:var(--ink-primary)] transition-colors hover:border-[color:var(--border-hover)]"
            >
              Open
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export default ExternalHandoffToast
