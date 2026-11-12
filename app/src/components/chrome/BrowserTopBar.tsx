/**
 * app/src/components/chrome/BrowserTopBar.tsx — Mode A flagship chrome
 * ("Zen × Blanc", ZCODE_MASTER_PROMPT.md §Phase 1.5.2).
 *
 * A sleek matte top command bar (48px, glass over content) laid out as
 * `1fr · reserved island slot · 1fr` so the FloatingIslandPill floats
 * exactly in the middle of the bar and acts as the centered domain/title
 * palette trigger.
 *
 *   left   — tab-rail toggle · Back / Forward / Reload (wired by App to the
 *            mock reader's per-node in-place history) · security indicator
 *            (quiet matte icon — a status, not a button)
 *   right  — Split View · Neighbourhood Glance · Extensions · theme ·
 *            shortcuts sheet (?) · Canvas toggle
 *
 * Color discipline: matte graphite only. Buttons rest quiet, hover = the
 * quietest wash (var(--glass-soft)), toggled-on = wash + a 1px inset
 * var(--border-active) hairline. Never colored glows, never neon.
 */

import { Moon, Sun } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowLeft,
  ArrowRight,
  CircleHelp,
  Columns2,
  LayoutGrid,
  PanelLeft,
  PanelRight,
  Puzzle,
  RotateCw,
  ShieldCheck,
} from 'lucide-react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export type BrowserTopBarProps = {
  /** Per-node in-place history (App owns the stacks). */
  canBack: boolean
  canForward: boolean
  onBack: () => void
  onForward: () => void
  onReload: () => void
  /** Zen-style ultra-slim left rail (⌘/Ctrl+S). */
  railOpen: boolean
  onToggleRail: () => void
  /** Split View — two mock reader panes side by side. */
  splitOpen: boolean
  onToggleSplit: () => void
  /** Neighbourhood Glance drawer (⌘/Ctrl+Shift+G). */
  glanceOpen: boolean
  onToggleGlance: () => void
  /** Honest "extensions arrive with the desktop build" drawer. */
  extensionsOpen: boolean
  onToggleExtensions: () => void
  /** ? / ⌘/Ctrl+/ shortcuts modal sheet. */
  onToggleShortcuts: () => void
  /** 'dark' default | warm-paper light (html[data-theme='paper']). */
  theme: 'dark' | 'paper'
  onToggleTheme: () => void
  /** Canvas toggle (⌘/Ctrl+Space · Alt+Space wired globally). */
  onToggleCanvas: () => void
  className?: string
}

function BarButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  disabled = false,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150',
        active
          ? 'bg-[color:var(--glass-soft)] text-[color:var(--ink-primary)] shadow-[inset_0_0_0_1px_var(--border-active)]'
          : 'text-[color:var(--ink-secondary)] hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]',
        disabled && 'pointer-events-none opacity-35',
      )}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden />
    </button>
  )
}

function BarDivider() {
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-hairline" />
}

export function BrowserTopBar({
  canBack,
  canForward,
  onBack,
  onForward,
  onReload,
  railOpen,
  onToggleRail,
  splitOpen,
  onToggleSplit,
  glanceOpen,
  onToggleGlance,
  extensionsOpen,
  onToggleExtensions,
  onToggleShortcuts,
  theme,
  onToggleTheme,
  onToggleCanvas,
  className,
}: BrowserTopBarProps) {
  return (
    <header
      className={cn('fixed inset-x-0 top-0 z-40 grid h-12 grid-cols-[1fr_auto_1fr] items-center border-b border-hairline px-2', className)}
      style={{ background: 'var(--bg-glass)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}
    >
      {/* ---- left: rail · history · security ---- */}
      <div className="flex items-center justify-self-start">
        <BarButton icon={PanelLeft} label="Toggle tab rail (⌘/Ctrl+S)" onClick={onToggleRail} active={railOpen} />
        <BarDivider />
        <BarButton icon={ArrowLeft} label="Back — active tab history" onClick={onBack} disabled={!canBack} />
        <BarButton icon={ArrowRight} label="Forward — active tab history" onClick={onForward} disabled={!canForward} />
        <BarButton icon={RotateCw} label="Reload page" onClick={onReload} />
        <BarDivider />
        {/* Security indicator — quiet matte status, intentionally not a button */}
        <span
          title="Mock connection — pages are simulated in this preview"
          className="flex size-7 shrink-0 items-center justify-center text-[color:var(--ink-muted)]"
        >
          <ShieldCheck size={14} strokeWidth={1.75} aria-hidden />
        </span>
      </div>

      {/* ---- centre: reserved slot the FloatingIslandPill island floats in ---- */}
      <div aria-hidden className="h-9 w-[min(44vw,520px)]" />

      {/* ---- right: split · glance · extensions · theme · shortcuts · canvas ---- */}
      <div className="flex items-center justify-self-end">
        <BarButton icon={Columns2} label="Split view — read two tabs side by side" onClick={onToggleSplit} active={splitOpen} />
        <BarButton icon={PanelRight} label="Neighbourhood glance (⌘/Ctrl+Shift+G)" onClick={onToggleGlance} active={glanceOpen} />
        <BarButton icon={Puzzle} label="Extensions" onClick={onToggleExtensions} active={extensionsOpen} />
        <BarDivider />
        <BarButton
          icon={theme === 'paper' ? Moon : Sun}
          label={theme === 'paper' ? 'Switch to dark theme' : 'Switch to warm paper light theme'}
          onClick={onToggleTheme}
        />
        <BarButton icon={CircleHelp} label="Keyboard shortcuts (⌘/Ctrl+/)" onClick={onToggleShortcuts} />
        <BarDivider />
        <BarButton
          icon={LayoutGrid}
          label="Toggle spatial canvas (⌘/Ctrl+Space or Alt+Space)"
          onClick={onToggleCanvas}
        />
      </div>
    </header>
  )
}

export default BrowserTopBar
