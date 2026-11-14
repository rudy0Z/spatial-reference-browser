/**
 * app/src/store/useToastStore.ts — minimal custom toast system
 * (zustand + framer-motion <AnimatePresence> rendering in
 * components/chrome/ToastStack.tsx).
 *
 * SPEC §5.2 — auto-hibernation from the strict live pool is surfaced "with a
 * smooth toast"; §6 — ghost-echo materialization is announced the same way so
 * predictions never appear silently. App.tsx bridges these store events into
 * this runtime-only store; nothing here is persisted (§1 — toasts are
 * transient, like paletteOpen/glanceOpen in useGraphStore).
 */
import { create } from 'zustand'

/** The two event families the SPEC names toasts for (§5.2, §6). */
export type ToastKind = 'auto-hibernate' | 'ghost-echo'

export type Toast = {
  id: string
  kind: ToastKind
  /** Headline — e.g. `Slept — WebGPU Fluid Shaders`. */
  title: string
  /** Mono detail line — e.g. `0 MB · live pool limit (5)`. */
  body: string
  createdAt: number
}

export type ToastInput = {
  kind: ToastKind
  title: string
  body: string
}

export type ToastState = {
  toasts: Toast[]
  pushToast: (input: ToastInput, ttlMs?: number) => string
  dismissToast: (id: string) => void
}

/** §5.2 "smooth toast" — visible long enough to read, gone without a click. */
const DEFAULT_TTL_MS = 4_600
/** Hard cap so event bursts (e.g. rapid tab switching) never flood the screen. */
const MAX_STACKED_TOASTS = 4

/** Timer registry so dismissal (auto or click) always clears its timeout. */
const timers = new Map<string, number>()

function newToastId(): string {
  return `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],

  pushToast: (input, ttlMs = DEFAULT_TTL_MS) => {
    const id = newToastId()
    const toast: Toast = { ...input, id, createdAt: Date.now() }
    set((state) => ({ toasts: [...state.toasts, toast].slice(-MAX_STACKED_TOASTS) }))
    timers.set(
      id,
      window.setTimeout(() => get().dismissToast(id), ttlMs),
    )
    return id
  },

  dismissToast: (id) => {
    const timer = timers.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.delete(id)
    }
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  },
}))
