/**
 * app/src/components/chrome/BrowserTopBar.tsx — Mode A flagship chrome
 * ("Zen × Blanc", Phase 3.2 Stage C).
 *
 * A sleek matte top command bar (48px, glass over content) laid out as
 * `1fr · reserved island slot · 1fr`. Per SPEC ADDENDUM B §B.1 the
 * navigation cluster (Back / Forward / Reload / security lock) now lives on
 * the FloatingIslandPill itself (Stage 0 resting island), so this bar keeps
 * only the secondary utility cluster:
 *
 *   left   — Zen-style ultra-slim tab-rail toggle (⌘/Ctrl+S)
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
  CircleHelp,
  Columns2,
  LayoutGrid,
  PanelLeft,
  PanelRight,
  Puzzle,
} from 'lucide-react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export type BrowserTopBarProps = {
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
      {/* ---- left: rail toggle (Back/Forward/Reload live on the island, §B.1) ---- */}
      <div className="flex items-center justify-self-start">
        <BarButton icon={PanelLeft} label="Toggle tab rail (⌘/Ctrl+S)" onClick={onToggleRail} active={railOpen} />
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
