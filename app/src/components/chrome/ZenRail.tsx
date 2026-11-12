/**
 * app/src/components/chrome/ZenRail.tsx — Zen-style ultra-slim collapsible
 * left rail (ZCODE_MASTER_PROMPT.md §Phase 1.5.2, toggled with ⌘/Ctrl+S by
 * the app shell; collapsing it yields full-bleed reading).
 *
 * A slim vertical list of LIVE tabs (ramState 'live', ghosts excluded)
 * grouped under quiet region marks — a small colored region dot (data owns
 * the hue) plus the region name in muted ink — then unregioned live tabs.
 * Clicking a row activates the node in the reading viewport
 * (`openNodeInViewport`, store action).
 *
 * State grammar: rows rest transparent, hover = quietest wash, the active
 * tab's row = 1px var(--border-active) hairline + var(--shadow-card).
 * Chrome stays matte; the only hue is the regions' own data color.
 */

import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { AudioLines } from 'lucide-react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { useGraphStore } from '../../store/useGraphStore'
import type { Region, SpatialTabNodeRecord } from '../../lib/types'

function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export const ZEN_RAIL_WIDTH = 224

type RailGroup = {
  region: Region | null
  nodes: SpatialTabNodeRecord[]
}

function RailTabRow({
  node,
  isActive,
  onOpen,
}: {
  node: SpatialTabNodeRecord
  isActive: boolean
  onOpen: (uuid: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(node.uuid)}
      title={`${node.title} — ${node.url}`}
      className={cn(
        'group flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors duration-150',
        isActive
          ? 'border-[color:var(--border-active)] bg-[color:var(--glass-soft)]'
          : 'border-transparent hover:border-[color:var(--border-subtle)] hover:bg-[color:var(--glass-soft)]',
      )}
      style={isActive ? { boxShadow: 'var(--shadow-card)' } : undefined}
    >
      {/* silent state dot — filled = live; the rail lists live tabs only */}
      {node.isLoading ? (
        <motion.span
          className="h-[5px] w-[5px] shrink-0 rounded-full bg-[color:var(--accent)]"
          animate={{ opacity: [1, 0.3, 1] }}
          transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
        />
      ) : (
        <span
          className={cn(
            'h-[5px] w-[5px] shrink-0 rounded-full',
            isActive ? 'bg-[color:var(--accent)]' : 'bg-[color:var(--ink-muted)]',
          )}
        />
      )}
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[12px] leading-tight',
          isActive ? 'text-[color:var(--ink-primary)]' : 'text-[color:var(--ink-secondary)] group-hover:text-[color:var(--ink-primary)]',
        )}
      >
        {node.title}
      </span>
      {node.isAudible ? (
        <AudioLines size={11} strokeWidth={1.75} className="shrink-0 text-[color:var(--ink-muted)]" aria-hidden />
      ) : null}
    </button>
  )
}

/**
 * The rail body. The app shell animates collapse (width → 0) around this
 * fixed-width aside, so it renders as a self-contained 224px column.
 */
export function ZenRail({ className }: { className?: string }) {
  const nodes = useGraphStore((s) => s.nodes)
  const regions = useGraphStore((s) => s.regions)
  const activeNodeUuid = useGraphStore((s) => s.activeNodeUuid)
  const openNodeInViewport = useGraphStore((s) => s.openNodeInViewport)

  const groups = useMemo<RailGroup[]>(() => {
    const live = Object.values(nodes).filter((node) => node.ramState === 'live' && node.nodeType !== 'ghost-echo')
    const byRegion = new Map<string, SpatialTabNodeRecord[]>()
    for (const node of live) {
      const key = node.regionId ?? ''
      const bucket = byRegion.get(key)
      if (bucket) bucket.push(node)
      else byRegion.set(key, [node])
    }
    // Most-recently-visited first inside each group (stable, data-driven).
    for (const bucket of byRegion.values()) bucket.sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)

    const ordered: RailGroup[] = []
    for (const region of Object.values(regions)) {
      const bucket = byRegion.get(region.id)
      if (bucket) {
        ordered.push({ region, nodes: bucket })
        byRegion.delete(region.id)
      }
    }
    const unregioned = byRegion.get('')
    if (unregioned) ordered.push({ region: null, nodes: unregioned })
    return ordered
  }, [nodes, regions])

  const liveCount = useMemo(() => groups.reduce((sum, group) => sum + group.nodes.length, 0), [groups])

  return (
    <aside
      className={cn('flex h-full shrink-0 flex-col overflow-hidden border-r border-hairline', className)}
      style={{ width: ZEN_RAIL_WIDTH, background: 'var(--bg-glass)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}
    >
      <div className="flex shrink-0 items-baseline justify-between px-3 pb-1 pt-3">
        <span className="text-[10.5px] font-medium text-[color:var(--ink-muted)]">Live tabs</span>
        <span className="text-[10.5px] tabular-nums text-[color:var(--ink-muted)]">{liveCount}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3 [scrollbar-color:var(--border-hover)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[color:var(--border-hover)]">
        {liveCount === 0 ? (
          <p className="px-1.5 pt-2 text-[11.5px] leading-relaxed text-[color:var(--ink-muted)]">
            No live tabs — wake one from the canvas or the command palette.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.region?.id ?? 'unregioned'}>
              <div className="flex items-center gap-1.5 px-2 pb-1 pt-3">
                {group.region ? (
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: group.region.color }} />
                ) : null}
                <span className="truncate text-[10px] font-medium text-[color:var(--ink-muted)]">
                  {group.region ? group.region.name : 'Unregioned'}
                </span>
              </div>
              {group.nodes.map((node) => (
                <RailTabRow
                  key={node.uuid}
                  node={node}
                  isActive={node.uuid === activeNodeUuid}
                  onOpen={openNodeInViewport}
                />
              ))}
            </section>
          ))
        )}
      </div>
    </aside>
  )
}

export default ZenRail
