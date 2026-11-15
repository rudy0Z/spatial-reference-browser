/**
 * app/src/components/chrome/PermissionPrompt.tsx — §B.8 permission lane.
 *
 * The spatial shell's matte permission card. Main's permission policy
 * (permissions.js) keeps ALL semantics — tiers, stored decisions, quiet-sweep
 * cancellation — and merely routes the PROMPT surface here for spatial
 * windows instead of the strip's floating permission view. The answer rides
 * `spatial:permission:respond`; a prompt the shell never answers dies with
 * its tab or window exactly as before.
 *
 * Sentence case, hairline card, spring 380/30. Origin is shown as the bare
 * host the user can read — never the full URL.
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ShieldCheck, X } from 'lucide-react'

import { spatialApi } from '../../lib/spatialBridge'

const SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

export type PermissionRequest = {
  id: number
  origin: string | null
  permission: string | null
  mediaTypes: string[]
}

/** Human label per prompted permission (PROMPTED set in permissions.js). */
function permissionLabel(request: PermissionRequest): string {
  const media = request.mediaTypes.filter(Boolean)
  if (request.permission === 'media') {
    if (media.includes('video') && media.includes('audio')) return 'camera and microphone'
    if (media.includes('video')) return 'camera'
    if (media.includes('audio')) return 'microphone'
    return 'media devices'
  }
  if (request.permission === 'geolocation') return 'location'
  if (request.permission === 'notifications') return 'notifications'
  return request.permission ?? 'access'
}

function PermissionPrompt({ onVisible }: { onVisible?: (visible: boolean) => void }) {
  const [request, setRequest] = useState<PermissionRequest | null>(null)

  useEffect(() => {
    if (!spatialApi) return
    return spatialApi.onPermissionRequest((payload) => {
      // One card at a time — the newest prompt wins; earlier pending prompts
      // stay pending in main until answered or cancelled there.
      setRequest(payload)
    })
  }, [])

  // §B.8 z-order honesty: while the card is up it must be able to paint
  // OVER the live view, so App engages the shell's z-order guard.
  useEffect(() => {
    onVisible?.(request != null)
    return () => onVisible?.(false)
  }, [request != null, onVisible])

  const answer = (allow: boolean) => {
    const current = request
    if (!current || !spatialApi) return
    spatialApi.permissionRespond(current.id, allow)
    setRequest(null)
  }

  const dismiss = () => {
    const current = request
    if (!current || !spatialApi) return
    spatialApi.permissionRespond(current.id, false)
    setRequest(null)
  }

  const host = (() => {
    if (!request?.origin) return 'This site'
    try {
      return new URL(request.origin).host || request.origin
    } catch {
      return request.origin
    }
  })()

  return (
    <AnimatePresence>
      {request ? (
        <motion.div
          key={`permission-${request.id}`}
          role="alertdialog"
          aria-label="Permission request"
          className="pointer-events-auto absolute bottom-14 left-4 z-50 w-[300px] rounded-xl border border-hairline bg-surface-glass p-3 shadow-[var(--shadow-pop)] backdrop-blur-xl"
          initial={{ opacity: 0, y: 12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.15, ease: 'easeIn' } }}
          transition={SPRING}
        >
          <div className="flex items-start gap-2">
            <ShieldCheck size={14} className="mt-0.5 shrink-0 text-[color:var(--ink-muted)]" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium leading-tight text-[color:var(--ink-primary)]">
                Allow {permissionLabel(request)}?
              </p>
              <p className="mt-0.5 text-[10px] tracking-ui text-[color:var(--ink-muted)]">{host}</p>
            </div>
            <button
              type="button"
              aria-label="Deny and close"
              onClick={dismiss}
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
              Block
            </button>
            <button
              type="button"
              onClick={() => answer(true)}
              className="rounded-lg border border-hairline bg-[color:var(--bg-elevated)] px-2.5 py-1 text-[11px] text-[color:var(--ink-primary)] transition-colors hover:border-[color:var(--border-hover)]"
            >
              Allow
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export default PermissionPrompt
