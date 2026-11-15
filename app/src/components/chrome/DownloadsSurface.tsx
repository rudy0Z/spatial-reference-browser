/**
 * app/src/components/chrome/DownloadsSurface.tsx — §B.8.5 download gates.
 *
 * Two surfaces in one file:
 *  1. DownloadToasts — every `spatial:downloads:updated` progress push shows
 *     an in-flight toast (filename + received/total); completion and
 *     cancellation land as one final toast. Driven from App's event
 *     subscription through the same runtime-only toast stack the §5.2/§6
 *     events use (kind 'download').
 *  2. DownloadsPanel — the ⌘/Ctrl+J surface: a matte floating list of the
 *     current profile's downloads (in-flight first), with the actions main
 *     implements through `spatial:downloads:action` — the shell never sees a
 *     filesystem path; open/reveal re-resolve the record in main.
 *
 * Silent state grammar: no pulsing progress rings, no neon — a hairline
 * progress bar, muted mono numbers, spring 380/30.
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowDownToLine, Check, FolderOpen, X } from 'lucide-react'

import { spatialApi } from '../../lib/spatialBridge'
import { useToastStore } from '../../store/useToastStore'

const SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

export type DownloadItem = {
  id: string | null
  url: string
  filename: string
  state: string
  receivedBytes: number
  totalBytes: number
  startedAt: number
  finishedAt: number
  private: boolean
  inFlight: boolean
}

/** Bytes → the mono detail line ("12.4 MB of 48.0 MB"). */
function bytesOf(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`
}

/* ------------------------------------------------------------------ */
/* DownloadsPanel — the ⌘J surface                                     */
/* ------------------------------------------------------------------ */

function stateLabel(item: DownloadItem): string {
  if (item.state === 'completed') return 'Completed'
  if (item.state === 'cancelled') return 'Cancelled'
  if (item.state === 'interrupted') return 'Interrupted'
  return 'Downloading'
}

function DownloadRow({ item }: { item: DownloadItem }) {
  const percent = item.totalBytes > 0
    ? Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100))
    : null
  return (
    <li className="rounded-lg border border-hairline bg-[color:var(--bg-elevated)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[color:var(--ink-muted)]" aria-hidden="true">
          {item.state === 'completed' ? <Check size={13} /> : <ArrowDownToLine size={13} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] leading-tight text-[color:var(--ink-primary)]">{item.filename || item.url}</p>
          <p className="mt-0.5 text-[10px] tracking-ui text-[color:var(--ink-muted)]">
            {stateLabel(item)}
            {item.inFlight && percent != null ? ` · ${percent}%` : ''}
            {item.inFlight && item.totalBytes > 0 ? ` · ${bytesOf(item.receivedBytes)} of ${bytesOf(item.totalBytes)}` : ''}
            {item.private ? ' · private' : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {item.state === 'completed' ? (
            <>
              <button
                type="button"
                aria-label={`Open ${item.filename}`}
                onClick={() => void spatialApi?.downloadsAction(item.id ?? '', 'open')}
                className="rounded p-1 text-[color:var(--ink-muted)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
              >
                <ArrowDownToLine size={12} />
              </button>
              <button
                type="button"
                aria-label={`Show ${item.filename} in folder`}
                onClick={() => void spatialApi?.downloadsAction(item.id ?? '', 'show')}
                className="rounded p-1 text-[color:var(--ink-muted)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
              >
                <FolderOpen size={12} />
              </button>
            </>
          ) : null}
          {item.inFlight ? (
            <button
              type="button"
              aria-label={`Cancel ${item.filename}`}
              onClick={() => void spatialApi?.downloadsAction(item.id ?? '', 'cancel')}
              className="rounded p-1 text-[color:var(--ink-muted)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
      </div>
      {item.inFlight && percent != null ? (
        <div className="mt-1.5 h-px w-full overflow-hidden bg-[color:var(--hairline)]">
          <div className="h-full bg-[color:var(--ink-muted)]" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
    </li>
  )
}

export function DownloadsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<DownloadItem[]>([])

  useEffect(() => {
    if (!spatialApi || !open) return
    const api = spatialApi
    let alive = true
    const refresh = () => {
      void api.downloadsList().then((result) => {
        if (alive && result?.ok && Array.isArray(result.items)) setItems(result.items as DownloadItem[])
      })
    }
    refresh()
    const off = api.onDownloadsUpdated((payload) => {
      if (alive) setItems(payload.items)
    })
    return () => {
      alive = false
      off()
    }
  }, [open])

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="downloads-panel"
          role="dialog"
          aria-label="Downloads"
          className="pointer-events-auto absolute bottom-14 right-4 z-50 flex max-h-[60vh] w-[340px] flex-col gap-2 overflow-y-auto rounded-xl border border-hairline bg-surface-glass p-3 shadow-[var(--shadow-pop)] backdrop-blur-xl"
          initial={{ opacity: 0, y: 12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.15, ease: 'easeIn' } }}
          transition={SPRING}
        >
          <div className="flex items-center justify-between">
            <p className="text-[12px] font-medium text-[color:var(--ink-primary)]">Downloads</p>
            <button
              type="button"
              aria-label="Close downloads"
              onClick={onClose}
              className="rounded p-1 text-[color:var(--ink-muted)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
            >
              <X size={12} />
            </button>
          </div>
          {items.length === 0 ? (
            <p className="px-1 py-3 text-[11px] text-[color:var(--ink-muted)]">No downloads yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {items.slice(0, 12).map((item) => (
                <DownloadRow key={`${item.id ?? item.url}`} item={item} />
              ))}
            </ul>
          )}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

/* ------------------------------------------------------------------ */
/* Download progress toasts                                            */
/* ------------------------------------------------------------------ */

/** One toast per in-flight download, keyed by id; finished items show one
 *  final toast. App subscribes to onDownloadsUpdated and calls this with
 *  the newest snapshot. */
export function noteDownloadToasts(items: DownloadItem[], previous: Map<string, string>): Map<string, string> {
  const pushToast = useToastStore.getState().pushToast
  const next = new Map(previous)
  const seen = new Set<string>()
  for (const item of items) {
    if (!item.id) continue
    seen.add(item.id)
    const before = previous.get(item.id)
    if (item.inFlight && item.state === 'progressing') {
      next.set(item.id, 'progressing')
      if (before !== 'progressing') {
        pushToast({
          kind: 'download',
          title: `Downloading — ${item.filename}`,
          body: item.totalBytes > 0
            ? `${bytesOf(item.receivedBytes)} of ${bytesOf(item.totalBytes)}`
            : bytesOf(item.receivedBytes),
        })
      }
      continue
    }
    if (item.state === 'completed') {
      if (before !== 'completed') {
        pushToast({
          kind: 'download',
          title: `Downloaded — ${item.filename}`,
          body: item.totalBytes > 0 ? bytesOf(item.totalBytes) : 'Done',
        })
      }
      next.set(item.id, 'completed')
    } else if (item.state === 'interrupted' && before !== 'interrupted') {
      pushToast({ kind: 'download', title: `Interrupted — ${item.filename}`, body: 'Resume from ⌘/Ctrl+J' })
      next.set(item.id, 'interrupted')
    } else if (item.state === 'cancelled' && before !== 'cancelled') {
      next.set(item.id, 'cancelled')
    }
  }
  return next
}

export default DownloadsPanel
