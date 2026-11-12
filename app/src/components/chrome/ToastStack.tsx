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
 *    non-immune tab to hibernation.
 *  - `ghost-echo` — §6: a Ghost Echo suggestion materialized beside the
 *    active cluster (frosted muted styling, same silent state grammar).
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
        'pointer-events-auto flex w-[300px] items-start gap-2 rounded-lg border border-hairline bg-surface-glass shadow-[var(--shadow-pop)] backdrop-blur-xl',
      )}
      initial={{ opacity: 0, y: 14, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.16, ease: 'easeIn' } }}
      transition={TOAST_SPRING}
    >
      <span className={cn('mt-0.5 shrink-0', isGhost ? 'text-ghost' : 'text-[color:var(--ink-secondary)]')} aria-hidden="true">
        {isGhost ? <Ghost size={13} /> : <Moon size={13} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-medium leading-tight text-[color:var(--ink-primary)]">{toast.title}</p>
        <p className={cn('mt-0.5 text-[10px] tracking-ui', isGhost ? 'text-ghost' : 'text-[color:var(--ink-muted)]')}>
          {toast.body}
        </p>
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => dismissToast(toast.id)}
        className="mt-0.5 shrink-0 rounded p-0.5 text-[color:var(--ink-muted)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
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
