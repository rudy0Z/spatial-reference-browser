/**
 * app/src/components/chrome/ToastStack.tsx — §5.2 / §6 event toasts.
 *
 * Renders the runtime-only `useToastStore` stack with framer-motion
 * <AnimatePresence> (§2 motion language: spring stiffness 380 / damping 30,
 * never linear). App.tsx positions the stack bottom-left — a corner both
 * shells keep clear (the pill owns top-center, the canvas HUD dock owns
 * bottom-center, the glance panel owns the right edge).
 *
 * Two toast kinds:
 *  - `auto-hibernate` — §5.2: the live pool (max 5) evicted the oldest
 *    non-immune tab to `HIBERNATED (0 MB)`.
 *  - `ghost-echo` — §6: a Ghost Echo suggestion materialized beside the
 *    active cluster (violet spectral styling).
 */
import { AnimatePresence, motion } from 'framer-motion'
import { Ghost, Moon, X } from 'lucide-react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { useToastStore, type Toast } from '../../store/useToastStore'

/** No shared cn() utility exists yet (same file-local copy the other chrome builders use). */
function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** §2 spring — identical to the pill/glance/canvas springs. */
const TOAST_SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

function ToastCard({ toast }: { toast: Toast }) {
  const dismissToast = useToastStore((state) => state.dismissToast)
  const isGhost = toast.kind === 'ghost-echo'

  return (
    <motion.div
      layout
      key={toast.id}
      role="status"
      className={cn(
        'pointer-events-auto flex w-[300px] items-start gap-2 rounded-lg border px-3 py-2 shadow-[0_14px_44px_rgba(0,0,0,0.55)] backdrop-blur-xl',
        isGhost ? 'border-ghost/40 bg-violet-950/40' : 'border-hairline bg-surface-glass',
      )}
      initial={{ opacity: 0, y: 14, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.16, ease: 'easeIn' } }}
      transition={TOAST_SPRING}
    >
      <span className={cn('mt-0.5 shrink-0', isGhost ? 'text-ghost' : 'text-white/55')} aria-hidden="true">
        {isGhost ? <Ghost size={13} /> : <Moon size={13} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-medium leading-tight text-white/90">{toast.title}</p>
        <p className={cn('mt-0.5 font-mono text-[9.5px] tracking-wide', isGhost ? 'text-ghost/80' : 'text-white/40')}>
          {toast.body}
        </p>
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => dismissToast(toast.id)}
        className="mt-0.5 shrink-0 rounded p-0.5 text-white/30 transition-colors hover:bg-white/[0.08] hover:text-white/70"
      >
        <X size={11} />
      </button>
    </motion.div>
  )
}

/**
 * The toast surface itself. Mounted once by App; invisible when the stack is
 * empty (AnimatePresence renders nothing), so it has no footprint and never
 * blocks the shells underneath.
 */
export function ToastStack({ className }: { className?: string }) {
  const toasts = useToastStore((state) => state.toasts)

  return (
    <div className={cn('pointer-events-none fixed bottom-12 left-3 z-50 flex flex-col-reverse gap-2', className)}>
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} />
        ))}
      </AnimatePresence>
    </div>
  )
}

export default ToastStack
