/**
 * app/src/components/canvas/nodes/PreviewArt.tsx — deterministic editorial
 * preview artwork for spatial reference cards (Phase 1.5).
 *
 * The UI chrome is dead-neutral matte graphite; these renders are where the
 * card's visual life lives (ZCODE_MASTER_PROMPT.md §Phase 1.5). Every kind
 * draws strictly monochrome-ish ink-on-paper tones resolved from the node's
 * `PreviewSpec` — no rainbow gradients, no neon, no hue of any kind:
 *
 *   type-specimen — big letterform pair on a paper tone
 *   ui-grid       — muted wireframe blocks (nav / hero / columns)
 *   duotone       — two-tone overlapping shapes
 *   wireframe     — thin outline rectangles, plan-style
 *   swatch-board  — 4 quiet monochrome swatches
 *   logo-mark     — a single geometric mark
 *
 * Determinism contract (types.ts `PreviewSpec`): `seed` is the ONLY source
 * of variation. No Math.random(), no Date.now(), no per-render drift — the
 * same node renders byte-identical art on every machine, in every session,
 * at every zoom. `ink`/`paper` fall back to the canonical neutral tokens
 * (colors flow through `currentColor` + CSS vars, so the paper theme flips
 * the art for free). Kinds absent a persisted `preview` resolve through
 * `previewSpecForNode` → `defaultPreviewSpecFor` (FNV-1a over
 * `${domain}:${uuid}`), which is itself deterministic.
 *
 * The component is memoized and pure: one `<svg>` (or a small DOM collage
 * for the specimen kind) absolutely filling its parent box.
 */
import { memo, useMemo } from 'react'
import type { ReactNode } from 'react'
import { defaultPreviewSpecFor } from '../../../lib/types'
import type { PreviewSpec, SpatialTabNodeRecord } from '../../../lib/types'

/* ------------------------------------------------------------------ */
/* Deterministic PRNG + seeded pickers                                 */
/* ------------------------------------------------------------------ */

/**
 * mulberry32 — tiny, fast, fully deterministic PRNG. Seeded once per
 * PreviewArt instance from `spec.seed`; every geometric decision below
 * draws from it in a fixed order, so the stream is stable forever.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Inclusive integer in [min, max] from the stream. */
function randInt(next: () => number, min: number, max: number): number {
  return min + Math.floor(next() * (max - min + 1))
}

/** Pick one element of a non-empty array. */
function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length) % items.length]
}

/** Round to 1 decimal — keeps the SVG markup stable across platforms. */
function r1(value: number): number {
  return Math.round(value * 10) / 10
}

/* ------------------------------------------------------------------ */
/* Tone resolution                                                     */
/* ------------------------------------------------------------------ */

/** Ink defaults to the canonical neutral ink token; spec override wins. */
function inkOf(spec: PreviewSpec): string {
  return spec.ink ?? 'var(--ink-primary)'
}

/**
 * Paper defaults to the most elevated neutral surface token — a quiet step
 * above `--bg-card`, so the preview reads as a lifted sheet inside the
 * card. Spec override wins (used by duotone-style treatments).
 */
function paperOf(spec: PreviewSpec): string {
  return spec.paper ?? 'var(--bg-elevated)'
}

/* ------------------------------------------------------------------ */
/* Shared geometry — one viewBox for every kind                        */
/* ------------------------------------------------------------------ */

/** Design space of the preview box (260px card, ~16:10 crop). */
const W = 260
const H = 162

type ArtProps = {
  next: () => number
  ink: string
  paper: string
}

/**
 * Standard SVG root: fills its parent absolutely, crops with `slice` so any
 * box ratio keeps the composition, and funnels all color through
 * `currentColor` (the root carries `color: ink`) so CSS vars + theme flips
 * work inside SVG.
 */
function ArtSvg({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* kind: type-specimen — big letterform pair on a paper tone           */
/* ------------------------------------------------------------------ */

const SPECIMEN_PAIRS: readonly [string, string][] = [
  ['A', 'a'],
  ['G', 'g'],
  ['R', 'k'],
  ['K', 'r'],
  ['Q', '&'],
  ['W', 'y'],
  ['M', 'n'],
  ['F', 'j'],
  ['B', 'x'],
  ['T', 'a'],
]

/**
 * Editorial type specimen: one huge light letterform, one smaller heavy
 * italic overlapping it (outline-only), a hairline baseline rule and two
 * size ticks. Rendered as DOM text for crisp glyph outlines, with the
 * baseline drawn as a plain div — no SVG text metrics involved.
 */
function TypeSpecimenArt({ next, ink }: ArtProps): ReactNode {
  const [big, small] = pick(next, SPECIMEN_PAIRS)
  const weightLight = next() > 0.5 ? 200 : 300
  const weightHeavy = next() > 0.5 ? 750 : 800
  const lift = randInt(next, 2, 10)

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      {/* hairline baseline + size ticks */}
      <span
        className="absolute inset-x-6 bottom-9 block h-px"
        style={{ backgroundColor: ink, opacity: 0.22 }}
      />
      <span className="absolute bottom-9 left-6 block h-1.5 w-px" style={{ backgroundColor: ink, opacity: 0.35 }} />
      <span className="absolute bottom-9 right-6 block h-1.5 w-px" style={{ backgroundColor: ink, opacity: 0.35 }} />
      {/* the big light letterform */}
      <span
        className="absolute select-none leading-none"
        style={{
          left: 18,
          top: 96 - lift,
          fontSize: 128,
          fontWeight: weightLight,
          letterSpacing: '-0.04em',
          color: ink,
          opacity: 0.88,
        }}
      >
        {big}
      </span>
      {/* the heavy italic partner — outline only, overlapping the baseline */}
      <span
        className="absolute select-none italic leading-none"
        style={{
          left: 118,
          top: 132 - lift,
          fontSize: 84,
          fontWeight: weightHeavy,
          letterSpacing: '-0.02em',
          color: 'transparent',
          WebkitTextStroke: `1.25px ${ink}`,
          opacity: 0.6,
        }}
      >
        {small}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* kind: ui-grid — muted wireframe blocks                              */
/* ------------------------------------------------------------------ */

/**
 * Quiet product-wireframe: a nav bar, a hero block on one side, a column
 * run and a footer line — all flat fills at 8–16% ink plus hairline
 * strokes. The seed picks the hero side, column count and block rhythm.
 */
function UiGridArt({ next, ink, paper }: ArtProps): ReactNode {
  const heroLeft = next() > 0.5
  const columns = randInt(next, 2, 3)
  const margin = 22
  const contentW = W - margin * 2

  const blocks: ReactNode[] = []

  // nav bar
  blocks.push(
    <rect key="nav" x={margin} y={16} width={contentW} height={10} rx={3} style={{ fill: ink }} opacity={0.16} />,
  )
  // nav dots
  for (let i = 0; i < 3; i++) {
    blocks.push(
      <circle key={`nd-${i}`} cx={margin + 6 + i * 10} cy={21} r={2} style={{ fill: ink }} opacity={0.3} />,
    )
  }

  // hero block (focal — the only stronger fill)
  const heroW = Math.round(contentW * (columns === 3 ? 0.46 : 0.56))
  const heroH = 52
  const heroX = heroLeft ? margin : margin + (contentW - heroW)
  blocks.push(
    <g key="hero">
      <rect x={heroX} y={38} width={heroW} height={heroH} rx={5} style={{ fill: ink }} opacity={0.34} />
      <rect x={heroX + 10} y={heroH - 6 + 38 - 24} width={heroW - 20} height={4} rx={2} style={{ fill: paper }} opacity={0.9} />
    </g>,
  )

  // column run beside/under the hero
  const colTop = 38
  const colGap = 8
  const colW = Math.floor((contentW - heroW - colGap) / columns)
  for (let i = 0; i < columns; i++) {
    const x = (heroLeft ? margin + heroW + colGap : margin) + i * (colW + colGap)
    const h = randInt(next, 20, 44)
    blocks.push(
      <g key={`col-${i}`}>
        <rect
          x={x}
          y={colTop}
          width={colW}
          height={h}
          rx={4}
          style={{ fill: 'none', stroke: ink }}
          strokeWidth={1}
          strokeOpacity={0.3}
        />
        <rect x={x + 6} y={colTop + 8} width={colW - 12} height={3} rx={1.5} style={{ fill: ink }} opacity={0.2} />
        <rect x={x + 6} y={colTop + 16} width={Math.max(8, colW - 26)} height={3} rx={1.5} style={{ fill: ink }} opacity={0.14} />
      </g>,
    )
  }

  // footer line
  blocks.push(
    <rect key="foot" x={margin} y={112} width={contentW * 0.62} height={3} rx={1.5} style={{ fill: ink }} opacity={0.14} />,
  )

  return <ArtSvg>{blocks}</ArtSvg>
}

/* ------------------------------------------------------------------ */
/* kind: duotone — two-tone overlapping shapes                         */
/* ------------------------------------------------------------------ */

/**
 * Two flat ink tones (heavy + faint) overlapping on the paper: a large
 * circle and a rotated rounded square (or a soft blob path, by seed), plus
 * a hairline echo outline. The overlap compounds the alphas into a third
 * quiet value — still strictly two tones.
 */
function DuotoneArt({ next, ink, paper }: ArtProps): ReactNode {
  const blob = next() > 0.5
  const cx = randInt(next, 96, 128)
  const cy = randInt(next, 62, 84)
  const r = randInt(next, 54, 68)
  const boxSize = randInt(next, 92, 120)
  const boxX = randInt(next, 118, 142)
  const boxY = randInt(next, 28, 48)
  const rotation = randInt(next, -14, 14)
  const echoShift = randInt(next, 6, 12)

  return (
    <ArtSvg>
      {/* hairline echo of the primary shape */}
      <circle cx={cx + echoShift} cy={cy - echoShift} r={r} style={{ fill: 'none', stroke: ink }} strokeWidth={1} strokeOpacity={0.3} />
      {/* faint tone */}
      {blob ? (
        <path
          d={`M ${boxX} ${boxY + 26} Q ${boxX + 30} ${boxY - 14} ${boxX + 68} ${boxY + 6} T ${boxX + boxSize} ${boxY + 52} Q ${boxX + boxSize - 20} ${boxY + 96} ${boxX + 40} ${boxY + 88} T ${boxX} ${boxY + 26} Z`}
          style={{ fill: ink }}
          opacity={0.16}
        />
      ) : (
        <rect
          x={boxX}
          y={boxY}
          width={boxSize}
          height={boxSize}
          rx={18}
          transform={`rotate(${rotation} ${boxX + boxSize / 2} ${boxY + boxSize / 2})`}
          style={{ fill: ink }}
          opacity={0.16}
        />
      )}
      {/* heavy tone overlapping the faint one */}
      <circle cx={cx} cy={cy} r={r} style={{ fill: ink }} opacity={0.46} />
      {/* one paper-colored punch-out keeps it graphic, not mushy */}
      <circle cx={cx + r * 0.32} cy={cy - r * 0.32} r={7} style={{ fill: paper }} opacity={0.9} />
    </ArtSvg>
  )
}

/* ------------------------------------------------------------------ */
/* kind: wireframe — thin outline rectangles, plan-style               */
/* ------------------------------------------------------------------ */

/**
 * Architectural plan: 6–9 hairline outline rectangles — some nested, one
 * anchored with a faint fill, one crossed out — plus a couple of ruling
 * lines. Strokes only; the paper shows through everywhere.
 */
function WireframeArt({ next, ink }: ArtProps): ReactNode {
  const rects: ReactNode[] = []
  const margin = 20
  const count = randInt(next, 6, 8)

  // one anchored (faintly filled) rect
  const anchorW = randInt(next, 84, 116)
  const anchorH = randInt(next, 44, 62)
  const anchorX = randInt(next, margin, W - margin - anchorW)
  const anchorY = randInt(next, 22, H - 30 - anchorH)
  rects.push(
    <g key="anchor">
      <rect x={anchorX} y={anchorY} width={anchorW} height={anchorH} rx={3} style={{ fill: ink }} opacity={0.1} />
      <rect
        x={anchorX}
        y={anchorY}
        width={anchorW}
        height={anchorH}
        rx={3}
        style={{ fill: 'none', stroke: ink }}
        strokeWidth={1}
        strokeOpacity={0.4}
      />
    </g>,
  )

  // outline rects — a mix of nested, adjacent and overlapping
  for (let i = 0; i < count; i++) {
    const w = randInt(next, 30, 120)
    const h = randInt(next, 18, 64)
    const x = randInt(next, margin, W - margin - w)
    const y = randInt(next, 16, H - 26 - h)
    rects.push(
      <rect
        key={`o-${i}`}
        x={x}
        y={y}
        width={w}
        height={h}
        rx={2}
        style={{ fill: 'none', stroke: ink }}
        strokeWidth={1}
        strokeOpacity={0.32}
      />,
    )
  }

  // one crossed-out rect (plan markup)
  const cxW = randInt(next, 34, 52)
  const cxH = randInt(next, 24, 40)
  const cxX = randInt(next, margin + 20, W - margin - 20 - cxW)
  const cxY = randInt(next, 20, H - 30 - cxH)
  rects.push(
    <g key="cross" style={{ stroke: ink }} strokeWidth={1} strokeOpacity={0.5}>
      <rect x={cxX} y={cxY} width={cxW} height={cxH} rx={2} style={{ fill: 'none' }} />
      <line x1={cxX + 4} y1={cxY + 4} x2={cxX + cxW - 4} y2={cxY + cxH - 4} />
      <line x1={cxX + cxW - 4} y1={cxY + 4} x2={cxX + 4} y2={cxY + cxH - 4} />
    </g>,
  )

  // two ruling lines
  rects.push(
    <g key="rules" style={{ stroke: ink }} strokeWidth={1} strokeOpacity={0.2}>
      <line x1={margin} y1={H - 18} x2={W - margin} y2={H - 18} />
      <line x1={margin} y1={14} x2={W - margin} y2={14} />
    </g>,
  )

  return <ArtSvg>{rects}</ArtSvg>
}

/* ------------------------------------------------------------------ */
/* kind: swatch-board — 4 quiet monochrome swatches                    */
/* ------------------------------------------------------------------ */

/** Ink-alpha steps for the swatch run (strictly the one ink tone). */
const SWATCH_STEPS: readonly number[] = [0.82, 0.55, 0.3, 0.1]

/**
 * A row (or 2×2 tile, by seed) of four rounded swatches stepping down the
 * ink tone — paper, hairline-outlined — over a thin baseline with ticks.
 */
function SwatchBoardArt({ next, ink }: ArtProps): ReactNode {
  const grid2x2 = next() > 0.5
  const steps = next() > 0.5 ? SWATCH_STEPS : [...SWATCH_STEPS].reverse()
  const swatches: ReactNode[] = []

  if (grid2x2) {
    const size = 52
    const gap = 12
    const startX = (W - (size * 2 + gap)) / 2
    const startY = (H - (size * 2 + gap)) / 2 - 4
    steps.forEach((step, i) => {
      const x = startX + (i % 2) * (size + gap)
      const y = startY + Math.floor(i / 2) * (size + gap)
      swatches.push(
        <g key={`s-${i}`}>
          <rect x={x} y={y} width={size} height={size} rx={7} style={{ fill: ink }} opacity={step} />
          {step < 0.15 && (
            <rect
              x={x + 0.5}
              y={y + 0.5}
              width={size - 1}
              height={size - 1}
              rx={7}
              style={{ fill: 'none', stroke: ink }}
              strokeWidth={1}
              strokeOpacity={0.35}
            />
          )}
        </g>,
      )
    })
  } else {
    const swW = 48
    const swH = 84
    const gap = 14
    const totalW = swW * 4 + gap * 3
    const startX = (W - totalW) / 2
    const startY = 30
    steps.forEach((step, i) => {
      const x = startX + i * (swW + gap)
      swatches.push(
        <g key={`s-${i}`}>
          <rect x={x} y={startY} width={swW} height={swH} rx={7} style={{ fill: ink }} opacity={step} />
          {step < 0.15 && (
            <rect
              x={x + 0.5}
              y={startY + 0.5}
              width={swW - 1}
              height={swH - 1}
              rx={7}
              style={{ fill: 'none', stroke: ink }}
              strokeWidth={1}
              strokeOpacity={0.35}
            />
          )}
          <rect x={x} y={startY + swH + 10} width={swW} height={2} rx={1} style={{ fill: ink }} opacity={0.22} />
        </g>,
      )
    })
  }

  return <ArtSvg>{swatches}</ArtSvg>
}

/* ------------------------------------------------------------------ */
/* kind: logo-mark — a single geometric mark                           */
/* ------------------------------------------------------------------ */

/** Center of the mark; the seed picks one of six quiet constructions. */
function LogoMarkArt({ next, ink, paper }: ArtProps): ReactNode {
  const cx = W / 2
  const cy = H / 2 - 4
  const variant = randInt(next, 0, 5)
  const s = randInt(next, 42, 54) // base radius / half-size
  const elements: ReactNode[] = []
  const stroke = { fill: 'none', stroke: ink } as const

  if (variant === 0) {
    // concentric circles + filled center dot
    elements.push(
      <g key="m" style={stroke} strokeWidth={1.5} strokeOpacity={0.75}>
        <circle cx={cx} cy={cy} r={s} />
        <circle cx={cx} cy={cy} r={s * 0.58} strokeOpacity={0.45} />
      </g>,
      <circle key="d" cx={cx} cy={cy} r={6} style={{ fill: ink }} opacity={0.8} />,
    )
  } else if (variant === 1) {
    // square + inscribed circle
    elements.push(
      <rect key="sq" x={cx - s} y={cy - s} width={s * 2} height={s * 2} rx={10} style={stroke} strokeWidth={1.5} strokeOpacity={0.75} />,
      <circle key="c" cx={cx} cy={cy} r={s * 0.72} style={stroke} strokeWidth={1.5} strokeOpacity={0.4} />,
      <circle key="d" cx={cx + s * 0.72} cy={cy} r={5} style={{ fill: ink }} opacity={0.8} />,
    )
  } else if (variant === 2) {
    // triangle atop circle
    elements.push(
      <g key="m" style={stroke} strokeWidth={1.5} strokeOpacity={0.75}>
        <circle cx={cx} cy={cy + 12} r={s * 0.78} />
        <path d={`M ${cx} ${cy - s} L ${cx + s * 0.9} ${cy + s * 0.34} L ${cx - s * 0.9} ${cy + s * 0.34} Z`} strokeOpacity={0.45} />
      </g>,
    )
  } else if (variant === 3) {
    // asterisk through a circle
    const spokes = [0, 60, 120]
    elements.push(
      <circle key="c" cx={cx} cy={cy} r={s * 0.92} style={stroke} strokeWidth={1.5} strokeOpacity={0.5} />,
      <g key="sp" style={stroke} strokeWidth={1.5} strokeOpacity={0.75}>
        {spokes.map((deg) => {
          const rad = (deg * Math.PI) / 180
          const dx = Math.cos(rad) * s * 0.92
          const dy = Math.sin(rad) * s * 0.92
          return <line key={deg} x1={r1(cx - dx)} y1={r1(cy - dy)} x2={r1(cx + dx)} y2={r1(cy + dy)} />
        })}
      </g>,
    )
  } else if (variant === 4) {
    // hexagon + counter-rotated inner hexagon
    const hex = (radius: number, offsetDeg: number): string => {
      const points: string[] = []
      for (let i = 0; i < 6; i++) {
        const rad = (((offsetDeg + i * 60) % 360) * Math.PI) / 180
        points.push(`${r1(cx + Math.cos(rad) * radius)},${r1(cy + Math.sin(rad) * radius)}`)
      }
      return points.join(' ')
    }
    elements.push(
      <polygon key="h1" points={hex(s, 0)} style={stroke} strokeWidth={1.5} strokeOpacity={0.75} />,
      <polygon key="h2" points={hex(s * 0.55, 30)} style={stroke} strokeWidth={1.5} strokeOpacity={0.4} />,
      <circle key="d" cx={cx} cy={cy} r={4.5} style={{ fill: ink }} opacity={0.8} />,
    )
  } else {
    // diamond in a circle with a vertical axis line
    elements.push(
      <circle key="c" cx={cx} cy={cy} r={s} style={stroke} strokeWidth={1.5} strokeOpacity={0.5} />,
      <path
        key="d"
        d={`M ${cx} ${cy - s * 0.86} L ${cx + s * 0.62} ${cy} L ${cx} ${cy + s * 0.86} L ${cx - s * 0.62} ${cy} Z`}
        style={{ fill: ink }}
        opacity={0.32}
      />,
      <line key="l" x1={cx} y1={cy - s} x2={cx} y2={cy + s} style={stroke} strokeWidth={1.5} strokeOpacity={0.6} />,
    )
  }

  // paper punch-hole behind everything keeps the mark crisp on any tone
  return (
    <ArtSvg>
      <circle cx={cx} cy={cy} r={s + 14} style={{ fill: paper }} opacity={0.65} />
      {elements}
    </ArtSvg>
  )
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

function PreviewArtInner({ spec, className }: { spec: PreviewSpec; className?: string }) {
  // The PRNG stream is created once per spec identity; every kind consumes
  // it in a fixed order, so identical seeds always yield identical art.
  const next = useMemo(() => mulberry32(spec.seed), [spec.seed])
  const ink = inkOf(spec)
  const paper = paperOf(spec)
  const artProps: ArtProps = { next, ink, paper }

  let art: ReactNode
  switch (spec.kind) {
    case 'type-specimen':
      art = <TypeSpecimenArt {...artProps} />
      break
    case 'ui-grid':
      art = <UiGridArt {...artProps} />
      break
    case 'duotone':
      art = <DuotoneArt {...artProps} />
      break
    case 'wireframe':
      art = <WireframeArt {...artProps} />
      break
    case 'swatch-board':
      art = <SwatchBoardArt {...artProps} />
      break
    case 'logo-mark':
      art = <LogoMarkArt {...artProps} />
      break
  }

  return (
    <div className={className} style={{ backgroundColor: paper, color: ink }} aria-hidden>
      {art}
    </div>
  )
}

/**
 * Resolve the preview spec for a node: the persisted directive when present,
 * otherwise the deterministic FNV-1a fallback (`defaultPreviewSpecFor`) —
 * never random, never per-render.
 */
export function previewSpecForNode(node: SpatialTabNodeRecord): PreviewSpec {
  return node.preview ?? defaultPreviewSpecFor(node)
}

/** Memoized: identical spec identity + className never re-renders. */
export const PreviewArt = memo(PreviewArtInner, (prev, next) => prev.spec === next.spec && prev.className === next.className)
export default PreviewArt
