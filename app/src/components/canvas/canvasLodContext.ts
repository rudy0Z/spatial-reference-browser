/**
 * app/src/components/canvas/canvasLodContext.ts — the §4 semantic-zoom tier
 * channel for canvas cards.
 *
 * The tier is deliberately NOT carried inside each React Flow node's `data`:
 * baking it there forces SpatialCanvas to rebuild every node object in the
 * graph (700 objects on /seed-700) on every tier crossing and push them
 * through React Flow's internal store — the exact pipeline that intermittently
 * wedged during the Phase 1.5 live audit (V1). Through context, a crossing
 * re-renders only the mounted card components and React Flow's node store is
 * not churned at all.
 */
import { createContext } from 'react'
import type { SemanticZoomLevel } from '../../lib/types'

export type CanvasLodValue = {
  /** Current §4 semantic-zoom tier for this frame. */
  lod: SemanticZoomLevel
}

export const CanvasLodContext = createContext<CanvasLodValue>({ lod: 'rich' })
