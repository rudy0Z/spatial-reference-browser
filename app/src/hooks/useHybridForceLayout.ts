/**
 * app/src/hooks/useHybridForceLayout.ts — hybrid physics solver (SPEC §1, §4.6,
 * §6): d3-force with `fx`/`fy` pinned anchors that never drift, and gently
 * orbiting unpinned satellites.
 *
 * Guardrails honored (§6 "never auto-move existing nodes"):
 *  - Pinned anchors get `fx`/`fy` — d3-force locks them every tick.
 *  - Settled nodes are held near their persisted home by strong forceX/forceY
 *    (± a few px of gentle orbit wobble in render space — the persisted
 *    coordinates never change on their own).
 *  - Only freshly spawned satellites (`isNew`) are relaxed by the link/charge
 *    forces near their parent; once their velocity decays they report
 *    `onSettle` so the store can commit the position.
 *  - `frozen` stops the simulation AND the orbit loop entirely.
 *
 * Performance note: positions are written into a mutable ref (and pushed via
 * the `onTick` callback once per animation frame, mutating the same record in
 * place). Consumers should apply positions imperatively / batched instead of
 * copying into React state per tick.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import type { ForceLink, Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { fnv1a32 } from '../lib/embed'
import type { NodeUuid } from '../lib/types'

export type LayoutNodeInput = {
  uuid: NodeUuid
  /** Persisted home position. */
  x: number
  y: number
  /** Anchor lock (null when unpinned). */
  fx: number | null
  fy: number | null
  /** True only for freshly spawned satellites that physics may still place. */
  isNew: boolean
  /** Collision radius (varies with semantic-zoom LOD). */
  radius: number
}

export type LayoutLinkInput = {
  source: NodeUuid
  target: NodeUuid
  weight: number
}

export type LayoutPosition = { x: number; y: number }

/** Mutable per-frame position map — entries are replaced, not mutated. */
export type LayoutPositions = Record<NodeUuid, LayoutPosition>

export type UseHybridForceLayoutOptions = {
  /** §6 physics Freeze toggle — stops the simulation and the orbit dead. */
  frozen: boolean
  /** Gentle idle orbit for unpinned satellites (default true). */
  orbit?: boolean
  /** Called once per animation frame with the fresh position map (same object mutated in place). */
  onTick?: (positions: LayoutPositions, version: number) => void
  /** A freshly spawned satellite settled — commit its position to the store. */
  onSettle?: (uuid: NodeUuid, x: number, y: number) => void
}

export type HybridForceLayoutApi = {
  /** Latest positions (mutated in place each frame — copy if you store it). */
  positionsRef: { current: LayoutPositions }
  /** Re-energize the simulation (e.g. after fan-out or bulk changes). */
  reheat: (intensity?: number) => void
  /** Hard-stop the simulation. */
  stop: () => void
  /** True while the solver is actively relaxing (orbit excluded). */
  isRunning: boolean
}

interface SimNode extends SimulationNodeDatum {
  uuid: NodeUuid
  homeX: number
  homeY: number
  pinned: boolean
  isNew: boolean
  radius: number
  phase: number
  calmTicks: number
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  weight: number
}

const ORBIT_AMPLITUDE_PX = 5.5
const ORBIT_AMPLITUDE_NEW_PX = 3
const SETTLE_VELOCITY_SQ = 0.02
const SETTLE_TICKS = 30

export function useHybridForceLayout(
  nodes: LayoutNodeInput[],
  links: LayoutLinkInput[],
  options: UseHybridForceLayoutOptions,
): HybridForceLayoutApi {
  const optionsRef = useRef(options)
  optionsRef.current = options

  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null)
  const simNodesRef = useRef<Map<NodeUuid, SimNode>>(new Map())
  const linksRef = useRef<SimLink[]>([])
  const positionsRef = useRef<LayoutPositions>({})
  const versionRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef(Date.now())
  const [isRunning, setIsRunning] = useState(false)

  const writePositions = useCallback((orbitAmplitude: number) => {
    const time = (Date.now() - startRef.current) / 1000
    for (const sim of simNodesRef.current.values()) {
      const baseX = sim.x ?? sim.homeX
      const baseY = sim.y ?? sim.homeY
      if (orbitAmplitude > 0 && !sim.pinned) {
        const amplitude = sim.isNew ? ORBIT_AMPLITUDE_NEW_PX : ORBIT_AMPLITUDE_PX
        positionsRef.current[sim.uuid] = {
          x: baseX + Math.cos(time * 0.55 + sim.phase) * amplitude,
          y: baseY + Math.sin(time * 0.42 + sim.phase * 1.31) * amplitude,
        }
      } else {
        positionsRef.current[sim.uuid] = { x: baseX, y: baseY }
      }
    }
  }, [])

  /** rAF loop: composes sim base positions + gentle orbit, then notifies once per frame. */
  useEffect(() => {
    const frozen = options.frozen
    const orbit = options.orbit ?? true
    if (frozen || !orbit) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      writePositions(0)
      versionRef.current += 1
      optionsRef.current.onTick?.(positionsRef.current, versionRef.current)
      return
    }
    const loop = () => {
      writePositions(1)
      versionRef.current += 1
      optionsRef.current.onTick?.(positionsRef.current, versionRef.current)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [options.frozen, options.orbit, writePositions])

  /** Freeze also stops any relaxing simulation (§6 — Freeze stops all motion). */
  useEffect(() => {
    if (options.frozen) {
      simRef.current?.stop()
      setIsRunning(false)
    }
  }, [options.frozen])

  /** Sync the simulation with the store-derived node/link inputs. */
  useEffect(() => {
    const map = simNodesRef.current
    let hasNew = false

    for (const input of nodes) {
      let sim = map.get(input.uuid)
      if (!sim) {
        sim = {
          uuid: input.uuid,
          x: input.x,
          y: input.y,
          vx: 0,
          vy: 0,
          fx: input.fx,
          fy: input.fy,
          homeX: input.x,
          homeY: input.y,
          pinned: input.fx !== null && input.fx !== undefined,
          isNew: input.isNew,
          radius: input.radius,
          phase: (fnv1a32(input.uuid) % 6283) / 1000,
          calmTicks: 0,
        }
        map.set(input.uuid, sim)
      } else {
        sim.homeX = input.x
        sim.homeY = input.y
        const pinned = input.fx !== null && input.fx !== undefined
        sim.pinned = pinned
        sim.fx = pinned ? input.fx : null
        sim.fy = pinned ? input.fy : null
        if (input.isNew && !sim.isNew) {
          sim.isNew = true
          sim.x = input.x
          sim.y = input.y
          sim.vx = 0
          sim.vy = 0
        } else if (!input.isNew) {
          sim.isNew = false
        }
      }
      if (input.isNew) hasNew = true
    }

    const present = new Set(nodes.map((node) => node.uuid))
    for (const uuid of [...map.keys()]) {
      if (!present.has(uuid)) {
        map.delete(uuid)
        delete positionsRef.current[uuid]
      }
    }

    linksRef.current = links
      .filter((link) => map.has(link.source) && map.has(link.target))
      .map((link) => ({ source: link.source, target: link.target, weight: link.weight }))

    let sim = simRef.current
    if (!sim) {
      const linkForce = forceLink<SimNode, SimLink>(linksRef.current)
        .id((datum) => datum.uuid)
        .distance((link) => 150 + 140 / Math.max(1, link.weight))
        .strength((link) => Math.min(0.12, 0.02 + link.weight * 0.012))
      sim = forceSimulation<SimNode, SimLink>([...map.values()])
        .force('link', linkForce)
        .force('charge', forceManyBody<SimNode>().strength((datum) => (datum.isNew ? -140 : -35)))
        .force('collide', forceCollide<SimNode>((datum) => datum.radius + 8).strength(0.7).iterations(2))
        .force('homeX', forceX<SimNode>((datum) => datum.homeX).strength((datum) => (datum.isNew ? 0.05 : 0.55)))
        .force('homeY', forceY<SimNode>((datum) => datum.homeY).strength((datum) => (datum.isNew ? 0.05 : 0.55)))
        .alphaDecay(0.028)
        .velocityDecay(0.4)
        .on('tick', () => {
          const activeSim = simRef.current
          if (!activeSim) return
          let stillNew = false
          for (const datum of activeSim.nodes()) {
            if (!datum.isNew) continue
            const velocitySq = (datum.vx ?? 0) ** 2 + (datum.vy ?? 0) ** 2
            datum.calmTicks = velocitySq < SETTLE_VELOCITY_SQ ? datum.calmTicks + 1 : 0
            if (datum.calmTicks >= SETTLE_TICKS) {
              datum.isNew = false
              optionsRef.current.onSettle?.(datum.uuid, datum.x ?? datum.homeX, datum.y ?? datum.homeY)
            } else {
              stillNew = true
            }
          }
          if (!stillNew) {
            activeSim.stop()
            setIsRunning(false)
          }
        })
      simRef.current = sim
    } else {
      sim.nodes([...map.values()])
      const linkForce = sim.force('link')
      if (linkForce) (linkForce as ForceLink<SimNode, SimLink>).links(linksRef.current)
    }

    writePositions(optionsRef.current.frozen ? 0 : 1)

    if (!optionsRef.current.frozen && hasNew) {
      sim.alpha(0.5).restart()
      setIsRunning(true)
    }
  }, [nodes, links, writePositions])

  const reheat = useCallback((intensity = 0.3) => {
    const sim = simRef.current
    if (!sim || optionsRef.current.frozen) return
    sim.alpha(intensity).restart()
    setIsRunning(true)
  }, [])

  const stop = useCallback(() => {
    simRef.current?.stop()
    setIsRunning(false)
  }, [])

  useEffect(() => {
    return () => {
      simRef.current?.stop()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return { positionsRef, reheat, stop, isRunning }
}
