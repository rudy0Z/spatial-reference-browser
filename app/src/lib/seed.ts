/**
 * app/src/lib/seed.ts — first-run 28-tab designer seed (SPEC §9) + 700-node
 * designer stress seed (/seed-700). Deterministic given `now`.
 *
 * PHASE 1.5 — the "tech-bro filler" world was replaced with authentic
 * designer reference data (Are.na boards, Pangram Pangram, Typewolf, Google
 * Fonts, Klim, Dribbble shots, Behance studios, real studio domains, Figma
 * files, Shadertoy, WebGL Fundamentals, MDN) while every §7 edge case stays
 * present. Every newly seeded node carries an explicit content-matched
 * `PreviewSpec` (kind matched to its cluster, muted ink/paper tones,
 * deterministic seed); pre-1.5 persisted nodes have no `preview` field and
 * fall back to `defaultPreviewSpecFor` — the persisted shape is unchanged.
 *
 * First-run composition (exactly 28 nodes, 4 spatial islands):
 *   3 live · 23 hibernated (8 older than 14 days for visible decay) ·
 *   1 ephemeral google.com hub · 2 Ghost Echoes
 * and every §7 edge case present at least once:
 *   §7.1 hub + query-tagged children · §7.2 via-auth collapse example ·
 *   §7.3 SPA filmstrip node with subPages[] · §7.4 noCapture private node ·
 *   §7.5 dead-link cached excerpts · §7.6 duplicate-url_hash pair sharing
 *   notes · §5.3/§7.7 one audible live tab + pinned anchors.
 *
 * /seed-700 composition: exactly 700 nodes across exactly 7 clusters —
 * Visual References, Typography & Foundries, Studio Portfolios, Product UI
 * Benchmarks, Shaders & Motion, Active Figma Projects, Technical Docs —
 * with believable navigation-path edges (search-hub spokes, reading chains,
 * cross-cluster bridges), a spread of ages including >14 days for the decay
 * grammar, and at most 5 live nodes (respects the LRU pool cap + immunity).
 */
import { fnv1a32, tokenize } from './embed'
import {
  domainOf,
  looksLikeAuthOrPaymentUrl,
  ramMbFor,
  urlHashOf,
} from './types'
import type {
  GraphEdgeRecord,
  GraphNodeKind,
  NodeUuid,
  PreviewSpec,
  PreviewSpecKind,
  RamState,
  Region,
  RegionId,
  SpatialTabNodeRecord,
  StickyNote,
  SubPageRef,
  VoiceMemo,
} from './types'

export const FIRST_RUN_SEED_VERSION = 1
/** v3 — designer-world 700-node seed (Phase 1.5). Marker only; nothing branches on the value. */
export const STRESS_SEED_VERSION = 3
export const STRESS_NODE_COUNT = 700
export const STRESS_REGION_COUNT = 7

const DAY_MS = 86_400_000

/* ------------------------------------------------------------------ */
/* Seed graph envelope                                                 */
/* ------------------------------------------------------------------ */

export type SeedGraph = {
  regions: Region[]
  nodes: SpatialTabNodeRecord[]
  edges: GraphEdgeRecord[]
  notes: StickyNote[]
  memos: VoiceMemo[]
  /** Node the reading viewport opens on. */
  activeNodeUuid: NodeUuid
}

/* ------------------------------------------------------------------ */
/* Deterministic preview specs (Phase 1.5)                             */
/* ------------------------------------------------------------------ */

/**
 * Muted ink/paper tone pools per preview kind. Previews own 100% of the
 * color on the dead-neutral canvas, so these are deliberately desaturated
 * editorial tones (stone, ivory, graphite) — matte, never garish, never
 * neon. `previewFor` picks one deterministically per node.
 */
const PREVIEW_TONES: Record<PreviewSpecKind, ReadonlyArray<{ paper: string; ink: string }>> = {
  'type-specimen': [
    { paper: '#F4F1EA', ink: '#201E19' },
    { paper: '#EFE9DF', ink: '#35322B' },
    { paper: '#E9E4D8', ink: '#4A463C' },
  ],
  'ui-grid': [
    { paper: '#1A1B1E', ink: '#7A7A82' },
    { paper: '#191A1C', ink: '#8C8C94' },
    { paper: '#1C1B1A', ink: '#87837A' },
  ],
  duotone: [
    { paper: '#1C1B18', ink: '#A8A199' },
    { paper: '#15161A', ink: '#8E8E96' },
    { paper: '#1E1D1B', ink: '#B5B0A5' },
  ],
  wireframe: [
    { paper: '#191A1D', ink: '#7A7A82' },
    { paper: '#1A1917', ink: '#8C887E' },
    { paper: '#181A1A', ink: '#7E8480' },
  ],
  'swatch-board': [
    { paper: '#232226', ink: '#9C948A' },
    { paper: '#20262A', ink: '#8FA0A3' },
    { paper: '#26221E', ink: '#A39684' },
  ],
  'logo-mark': [
    { paper: '#101114', ink: '#C7C2B8' },
    { paper: '#171614', ink: '#A8A199' },
    { paper: '#141518', ink: '#B3B5BB' },
  ],
}

/**
 * Deterministic PreviewSpec for a seed node: the seed number is a pure
 * FNV-1a hash of the uuid (stable across machines and sessions — never
 * Math.random, never per-render), and the muted tone is picked by a second
 * independent hash so the two never correlate visually.
 */
function previewFor(kind: PreviewSpecKind, uuid: NodeUuid): PreviewSpec {
  const tones = PREVIEW_TONES[kind]
  const tone = tones[fnv1a32(`tone:${kind}:${uuid}`) % tones.length]
  return { kind, seed: fnv1a32(`preview:${uuid}`), ink: tone.ink, paper: tone.paper }
}

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

type SeedNodeSpec = {
  uuid: NodeUuid
  url: string
  title: string
  keywords: string[]
  regionId?: RegionId | null
  dx: number
  dy: number
  ageDays: number
  createdDaysAgo: number
  ramState?: RamState
  isAudible?: boolean
  isPinned?: boolean
  noCapture?: boolean
  ephemeral?: boolean
  viaAuth?: boolean
  searchQuery?: string
  subPages?: SubPageRef[]
  excerpt?: string
  parentUuid?: NodeUuid
  nodeType?: GraphNodeKind
  ghostOfUuid?: NodeUuid | null
  ghostTetherUuid?: NodeUuid | null
  ghostMatch?: number | null
  /** Content-matched preview kind → deterministic PreviewSpec (Phase 1.5). */
  previewKind?: PreviewSpecKind
}

function materializeNode(spec: SeedNodeSpec, centerX: number, centerY: number, now: number): SpatialTabNodeRecord {
  const nodeType: GraphNodeKind = spec.nodeType ?? 'tab'
  const ramState: RamState = spec.ramState ?? 'hibernated'
  const isGhost = nodeType === 'ghost-echo'
  const isHub = nodeType === 'hub'
  const viaAuth = spec.viaAuth ?? (ramState === 'live' && looksLikeAuthOrPaymentUrl(spec.url))
  const x = centerX + spec.dx
  const y = centerY + spec.dy
  const pinned = spec.isPinned ?? false
  return {
    uuid: spec.uuid,
    urlHash: urlHashOf(spec.url),
    url: spec.url,
    domain: domainOf(spec.url),
    title: spec.title,
    regionId: spec.regionId ?? null,
    nodeType,
    ramState: isGhost || isHub ? 'hibernated' : ramState,
    ramMb: ramState === 'live' && !isGhost && !isHub ? ramMbFor(spec.uuid) : 0,
    isAudible: spec.isAudible ?? false,
    isPinned: pinned,
    isLoading: false,
    noCapture: spec.noCapture ?? false,
    ephemeral: spec.ephemeral ?? (isGhost || isHub),
    viaAuth,
    searchQuery: spec.searchQuery ?? null,
    subPages: spec.subPages ?? [],
    excerpt: spec.excerpt ?? null,
    keywords: spec.keywords,
    parentUuid: spec.parentUuid ?? null,
    ghostOfUuid: spec.ghostOfUuid ?? null,
    ghostTetherUuid: spec.ghostTetherUuid ?? null,
    ghostMatch: spec.ghostMatch ?? null,
    settled: true,
    visitCount: ramState === 'live' ? 3 : 1 + Math.round(spec.ageDays % 4),
    lastVisitedAt: now - spec.ageDays * DAY_MS,
    createdAt: now - spec.createdDaysAgo * DAY_MS,
    x,
    y,
    fx: pinned ? x : null,
    fy: pinned ? y : null,
    preview: spec.previewKind ? previewFor(spec.previewKind, spec.uuid) : undefined,
  }
}

function edge(source: NodeUuid, target: NodeUuid, weight: number, kind: GraphEdgeRecord['kind'], now: number): GraphEdgeRecord {
  return { id: `${source}->${target}`, source, target, weight, kind, createdAt: now }
}

function note(id: string, urlHash: string, text: string, createdDaysAgo: number, now: number): StickyNote {
  const createdAt = now - createdDaysAgo * DAY_MS
  return { id, urlHash, text, createdAt, updatedAt: createdAt }
}

/** Tiny deterministic PRNG (mulberry32) for stress-seed jitter. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/* ------------------------------------------------------------------ */
/* Authentic domain URL shapes — designer-world realism                */
/* ------------------------------------------------------------------ */

/** Real-sounding are.na member handles for channel URLs. */
const ARENA_HANDLES: readonly string[] = [
  'studio-notebook',
  'marie-lou',
  'pixel-plateau',
  'fonda-composition',
  'grid-club',
  'paper-cuts',
]

/** PascalCase for Google Fonts specimen paths (`instrument-sans` → `InstrumentSans`). */
function pascalSlug(slug: string): string {
  return slug
    .split('-')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join('')
}

/**
 * Authentic per-domain URL shapes for the stress seed. Pure + deterministic:
 * ids are FNV-1a derivatives of the domain/slug/uuid, never random.
 * NOTE: deliberately no bare `#` fragments in stress URLs — `urlHashOf`
 * strips fragments, so hash-differing URLs would silently collapse onto one
 * `url_hash` and bleed notes across unrelated nodes.
 */
function designerUrlFor(domain: string, slug: string, uuid: NodeUuid): string {
  const h = fnv1a32(`url:${domain}/${slug}`)
  switch (domain) {
    case 'are.na':
      return `https://www.are.na/${ARENA_HANDLES[h % ARENA_HANDLES.length]}/${slug}`
    case 'dribbble.com':
      return `https://dribbble.com/shots/${(h % 90_000) + 10_000}-${slug}`
    case 'cosmos.so':
      return `https://cosmos.so/search?query=${encodeURIComponent(slug.replace(/-/g, '+'))}`
    case 'savee.it':
      return `https://savee.it/s/${slug.slice(0, 24)}`
    case 'siteinspire.com':
      return `https://www.siteinspire.com/websites?categories=${slug.split('-')[0]}`
    case 'godly.website':
      return `https://godly.website/website/${slug}`
    case 'pangrampangram.com':
      return `https://pangrampangram.com/products/${slug}`
    case 'typewolf.com':
      return `https://www.typewolf.com/${slug}`
    case 'fonts.google.com':
      return `https://fonts.google.com/specimen/${pascalSlug(slug)}`
    case 'fontsinuse.com':
      return `https://fontsinuse.com/uses/${(h % 90_000) + 10_000}/${slug}`
    case 'klim.co.nz':
      return `https://klim.co.nz/retail-fonts/${slug}`
    case 'grillitype.com':
      return `https://www.grillitype.com/typeface/${slug}`
    case 'dinamotype.com':
      return `https://dinamotype.com/typeface/${slug}`
    case 'commercialtype.com':
      return `https://commercialtype.com/catalog/${slug}`
    case 'pentagram.com':
      return `https://www.pentagram.com/work/${slug}`
    case 'koto.studio':
      return `https://koto.studio/work/${slug}`
    case 'buck.co':
      return `https://buck.co/work/${slug}`
    case 'mvsm.com':
      return `https://mvsm.com/work/${slug}`
    case 'studiodumbar.com':
      return `https://studiodumbar.com/work/${slug}`
    case 'wearecollins.com':
      return `https://wearecollins.com/work/${slug}`
    case 'shadertoy.com':
      return `https://www.shadertoy.com/view/${h.toString(36).padStart(6, '0').slice(0, 6)}`
    case 'compute.toys':
      return `https://compute.toys/view/${h % 300}-${slug}`
    case 'webglfundamentals.org':
      return `https://webglfundamentals.org/webgl/lessons/en/${slug}.html`
    case 'threejs.org':
      return `https://threejs.org/manual/en/${slug}.html`
    case 'maximeheckel.com':
      return `https://maximeheckel.com/posts/${slug}`
    case 'thebookofshaders.com':
      return `https://thebookofshaders.com/${(h % 16) + 1}/`
    case 'motion.dev':
      return `https://motion.dev/docs/${slug}`
    case 'tympanus.net':
      return `https://tympanus.net/codrops/${slug}`
    case 'figma.com': {
      // Active projects are design files; every 5th is a community reference file.
      const fileId = fnv1a32(`figma:${uuid}`).toString(36).padStart(9, 'x').slice(0, 9)
      if (h % 5 === 4) {
        const communityId = (fnv1a32(`figma-community:${uuid}`) % 900_000_000) + 100_000_000
        return `https://www.figma.com/community/file/${communityId}/${slug}`
      }
      return `https://www.figma.com/design/${fileId}/${slug}`
    }
    case 'developer.mozilla.org':
      return `https://developer.mozilla.org/en-US/docs/Web/CSS/${slug.replace(/-reference$/, '')}`
    case 'web.dev':
      return `https://web.dev/articles/${slug}`
    case 'typescriptlang.org':
      return `https://www.typescriptlang.org/docs/handbook/${slug}`
    case 'react.dev':
      return `https://react.dev/learn/${slug}`
    case 'tailwindcss.com':
      return `https://tailwindcss.com/docs/${slug}`
    case 'gpuweb.github.io':
      return `https://gpuweb.github.io/gpuweb/${slug}`
    case 'drafts.csswg.org':
      return `https://drafts.csswg.org/${slug}/`
    case 'html.spec.whatwg.org':
      return `https://html.spec.whatwg.org/multipage/${slug}`
    default:
      return `https://${domain}/${slug}`
  }
}

/* ------------------------------------------------------------------ */
/* §0.2 Fresh-State Browser Law — the shipping first run is ONE clean   */
/* New Tab: zero edges, regions, notes or dummy data. The old 28-node   */
/* designer demo was removed; /seed-700 survives as a dev/benchmark     */
/* fixture exposed only through window.__devStressSeed.                 */
/* ------------------------------------------------------------------ */

export const NEW_TAB_URL = 'https://new-tab.spatial/local'
export const NEW_TAB_NODE_UUID: NodeUuid = 'new-tab'

export function buildCleanFirstRunState(now: number): SeedGraph {
  const node = materializeNode(
    {
      uuid: NEW_TAB_NODE_UUID,
      url: NEW_TAB_URL,
      title: 'New Tab',
      keywords: [],
      regionId: null,
      dx: 0,
      dy: 0,
      ageDays: 0,
      createdDaysAgo: 0,
      ramState: 'live',
      isPinned: true,
      previewKind: 'logo-mark',
    },
    0,
    0,
    now,
  )
  return { regions: [], nodes: [node], edges: [], notes: [], memos: [], activeNodeUuid: NEW_TAB_NODE_UUID }
}

/* ------------------------------------------------------------------ */
/* /seed-700 — designer stress seed: 700 nodes across 7 clusters       */
/* ------------------------------------------------------------------ */

const STRESS_REGIONS: ReadonlyArray<{
  id: RegionId
  name: string
  color: string
  center: { x: number; y: number }
  /** Google search-hub query fragment (§7.1) — believable designer search. */
  topic: string
  /** PreviewSpecKind matched to the cluster (Phase 1.5). */
  kind: PreviewSpecKind
  titles: string[]
  domains: string[]
}> = [
  {
    id: 'stress-visual-references',
    name: 'Visual References',
    color: '#8E8E96',
    center: { x: -2000, y: -2000 },
    topic: 'brutalist web graphics are.na boards',
    kind: 'duotone',
    titles: [
      'Brutalist Web Archive', 'Editorial Grid Systems', 'Risograph Texture Studies',
      'Chrome Y2K UI Salvage', 'Swiss Poster Archive', 'Soft Aurora Gradients',
      'Kinetic Type Loops', 'Glass Card Explorations', 'Magazine Spread Studies',
      'Bento Grid Inspiration', 'Offline Zine Scans', 'Interface Archaeology',
    ],
    domains: ['are.na', 'dribbble.com', 'cosmos.so', 'savee.it', 'siteinspire.com', 'godly.website'],
  },
  {
    id: 'stress-typography-foundries',
    name: 'Typography & Foundries',
    color: '#B5B0A5',
    center: { x: 2000, y: -2000 },
    topic: 'variable font foundry specimens',
    kind: 'type-specimen',
    titles: [
      'PP Neue Montreal Specimen', 'Söhne — Klim Specimen', 'Trends in Web Typography',
      'Editorial Grotesque Pairing', 'Variable Font Axes Explorer', 'ABC Diatype Mono',
      'GT America Expanded', 'Instrument Sans Specimen', 'Diatype Weight Tracker',
      'Sans Serif Renaissance', 'Foundry Specimen Booklet', 'Italic Forms Study',
    ],
    domains: ['pangrampangram.com', 'typewolf.com', 'fonts.google.com', 'fontsinuse.com', 'klim.co.nz', 'grillitype.com', 'dinamotype.com', 'commercialtype.com'],
  },
  {
    id: 'stress-studio-portfolios',
    name: 'Studio Portfolios',
    color: '#6E6A61',
    center: { x: 2000, y: 2000 },
    topic: 'studio identity motion reel',
    kind: 'logo-mark',
    titles: [
      'Identity Case Film', 'Motion Reel 2026', 'Editorial Systems',
      'Brand World Overview', 'Type in Environment', 'Interactive Installations',
      'Packaging Grid Studies', 'Wordmark Process Book', 'Rebrand Case Study',
      'Spatial Signage System', 'Title Sequence Archive', 'Print Annual Report',
    ],
    domains: ['pentagram.com', 'koto.studio', 'buck.co', 'mvsm.com', 'studiodumbar.com', 'actualsource.com', 'studiofeixen.ch', 'wearecollins.com', 'work.co', 'instrument.com'],
  },
  {
    id: 'stress-product-ui',
    name: 'Product UI Benchmarks',
    color: '#5A5A63',
    center: { x: -2000, y: 2000 },
    topic: 'linear app ui patterns',
    kind: 'ui-grid',
    titles: [
      'Command Palette Patterns', 'Settings Architecture', 'Onboarding Checklist Design',
      'Empty States That Teach', 'Sidebar Density Studies', 'Product Motion Choreography',
      'Dark Theme Contrast Pass', 'Keyboard-First Navigation', 'Billing Table Layouts',
      'Notification Tray Design', 'Form Validation Patterns', 'Multiplayer Presence UI',
    ],
    domains: ['linear.app', 'raycast.com', 'framer.com', 'stripe.com', 'notion.so', 'vercel.com', 'arc.net', 'superhuman.com', 'family.co'],
  },
  {
    id: 'stress-shaders-motion',
    name: 'Shaders & Motion',
    color: '#7A746B',
    center: { x: 0, y: -3625 },
    topic: 'fluid ink shader webgl',
    kind: 'swatch-board',
    titles: [
      'Fluid Ink Simulation', 'Raymarched Cloud Fields', 'GPGPU Particle Trails',
      'WGSL Uniform Layouts', 'Spring Physics Recipes', 'Audio-Reactive Plasma',
      'Noise Functions Field Guide', 'FBO Ping-Pong Feedback', 'TSL Node Materials',
      'Curvature Shading Primer', 'Verlet Integration Cloth', 'Signed Distance Field Text',
    ],
    domains: ['shadertoy.com', 'compute.toys', 'webglfundamentals.org', 'threejs.org', 'maximeheckel.com', 'thebookofshaders.com', 'motion.dev', 'tympanus.net'],
  },
  {
    id: 'stress-active-figma',
    name: 'Active Figma Projects',
    color: '#9B968B',
    center: { x: 3625, y: 0 },
    topic: 'auto layout best practices figma',
    kind: 'wireframe',
    titles: [
      'Design System v3 Foundations', 'Mobile App Redesign Explorations', 'Marketing Site 2026',
      'Component Audit Board', 'Auto Layout Patterns', 'Token Mapping Sheet',
      'Handoff QA Board', 'Onboarding Prototype Flow', 'Icon Set Redraw',
      'Spatial Canvas Spikes', 'Editorial Print Grids', 'Motion Spec Handoff',
    ],
    domains: ['figma.com'],
  },
  {
    id: 'stress-technical-docs',
    name: 'Technical Docs',
    color: '#4A4A52',
    center: { x: 0, y: 3625 },
    topic: 'view transitions api docs',
    kind: 'wireframe',
    titles: [
      'backdrop-filter Reference', 'color-mix() Reference', 'View Transitions API',
      'Container Queries Guide', 'CSS Cascade Layers', 'WebGPU External Textures',
      'Handbook — Narrowing', 'content-visibility Performance', 'Scroll-Driven Animations',
      'WGSL Memory Model', 'Field Sizing Reference', 'Text Box Trim Specification',
    ],
    domains: ['developer.mozilla.org', 'web.dev', 'typescriptlang.org', 'react.dev', 'tailwindcss.com', 'gpuweb.github.io', 'drafts.csswg.org', 'html.spec.whatwg.org'],
  },
]

/** Lived-in designer notes on one anchor node per cluster (attach to url_hash). */
const STRESS_NOTE_TEXTS: readonly string[] = [
  'Pin the five channels with the strongest grids — cull the rest into next quarter\'s purge.',
  'Neue Montreal 500 for display, Instrument Sans for UI. Do not mix the two grotesques in one screen.',
  'Watch the Dumbar reel at 0.5× — the easing between title cards is the reference for edge pulses.',
  'Command palette row height: 40px, selection wash at 7% white. Steal the settings hierarchy, not the color.',
  'The fbm warp runs 4 octaves; the audio band only drives the third octave — keep it that way.',
  'Foundations page is frozen for handoff; component audit continues on the QA board file.',
  'backdrop-filter fallback needed for the paper theme — @supports not guard already drafted.',
]

export function buildStressSeed700(now: number): SeedGraph {
  const rand = mulberry32(0x07070070)
  const regions: Region[] = STRESS_REGIONS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    color: spec.color,
    center: spec.center,
    // Matches the member spread below (~920px) so empty-region fallback boxes
    // agree with the populated zone geometry.
    radius: 920,
    createdAt: now,
  }))

  const nodes: SpatialTabNodeRecord[] = []
  const edges: GraphEdgeRecord[] = []
  const notes: StickyNote[] = []

  // §5.2 — at most 5 live nodes (pool cap), exactly one audible (§5.3).
  const liveSet = new Set<NodeUuid>([
    'stress-0-2', // are.na channel — opens active
    'stress-1-3', // foundry specimen
    'stress-3-2', // product UI benchmark
    'stress-4-4', // audio-reactive shader (§5.3 audible immunity)
    'stress-5-4', // active Figma file
  ])
  const audibleUuid: NodeUuid = 'stress-4-4'
  const activeNodeUuid: NodeUuid = 'stress-0-2'

  for (let r = 0; r < STRESS_REGIONS.length; r++) {
    const spec = STRESS_REGIONS[r]
    const hubUuid = `stress-${r}-0`

    for (let i = 0; i < 100; i++) {
      const uuid = `stress-${r}-${i}`
      const isHub = i === 0
      const isAnchor = i === 1
      const isLive = liveSet.has(uuid)
      // Live nodes were visited today; hibernated nodes spread across 0–45
      // simulated days, so a healthy share crosses the 14-day decay line.
      const ageDays = isLive ? 0 : (i * 37 + r * 11) % 46
      const title = isHub
        ? `Google — ${spec.topic}`
        : spec.titles[i % spec.titles.length] + (i >= 12 ? ` — Part ${Math.floor(i / 12) + 1}` : '')
      const slug = slugify(isHub ? spec.topic : title)
      const url = isHub
        ? `https://www.google.com/search?q=${encodeURIComponent(spec.topic)}`
        : designerUrlFor(spec.domains[i % spec.domains.length], slug, uuid)

      let x: number
      let y: number
      if (isHub) {
        x = spec.center.x
        y = spec.center.y
      } else if (isAnchor) {
        x = spec.center.x
        y = spec.center.y - 170
      } else {
        // Phase 1.5 layout pass (audit round 1, V3): 100 members per cluster
        // must breathe at the rich tier, where a card is 260px wide.
        // sqrt-uniform distance gives constant area density (no center
        // pile-up) and the ~920px spread turns heavy stacking into a light
        // editorial pinboard overlap.
        const angle = rand() * Math.PI * 2
        const distance = 140 + Math.sqrt(rand()) * 780
        x = spec.center.x + Math.cos(angle) * distance
        y = spec.center.y + Math.sin(angle) * distance
      }

      const keywords = Array.from(new Set([...tokenize(title), ...tokenize(spec.topic)])).slice(0, 6)
      const isHubChild = i > 1 && i % 4 === 1
      const subPages: SubPageRef[] = i % 7 === 3 && !isHub
        ? [1, 2, 3].map((n) => ({
            title: `${title} · Trail ${n}`,
            url: `${url}#trail-${n}`,
          }))
        : []
      const excerpt = i % 5 === 2 && !isHub
        ? `> Cached snapshot — ${domainOf(url)}\n\nArchived ${ageDays} days ago. Full Readability capture ships with the Electron phase.`
        : null

      const node: SpatialTabNodeRecord = {
        uuid,
        urlHash: urlHashOf(url),
        url,
        domain: domainOf(url),
        title,
        regionId: spec.id,
        nodeType: isHub ? 'hub' : 'tab',
        ramState: isLive ? 'live' : 'hibernated',
        ramMb: isLive ? ramMbFor(uuid) : 0,
        isAudible: uuid === audibleUuid,
        isPinned: isAnchor,
        isLoading: false,
        noCapture: i % 11 === 5,
        ephemeral: isHub,
        viaAuth: !isHub && looksLikeAuthOrPaymentUrl(url),
        searchQuery: isHubChild ? title.toLowerCase() : null,
        subPages,
        excerpt,
        keywords,
        parentUuid: isHubChild ? hubUuid : null,
        ghostOfUuid: null,
        ghostTetherUuid: null,
        ghostMatch: null,
        settled: true,
        visitCount: isLive ? 4 : 1 + (i % 4),
        lastVisitedAt: now - ageDays * DAY_MS,
        createdAt: now - (ageDays + 5) * DAY_MS,
        x,
        y,
        fx: isAnchor ? x : null,
        fy: isAnchor ? y : null,
        // §Phase 1.5 — cluster-matched deterministic preview, muted tones.
        preview: previewFor(isHub ? 'wireframe' : spec.kind, uuid),
      }
      nodes.push(node)

      // A lived-in note on one anchor per cluster (notes attach to url_hash).
      if (i === 7 && !isHub) {
        notes.push(note(`stress-note-${r}`, node.urlHash, STRESS_NOTE_TEXTS[r], 3, now))
      }

      // Believable navigation paths: in-cluster reading chain + search-hub
      // spokes (§7.1 query tags) + cross-cluster bridges.
      if (i >= 2 && !isHub) {
        edges.push(edge(uuid, `stress-${r}-${i - 1}`, 1 + ((i + r) % 3), 'visit', now))
      }
      if (isHubChild) {
        edges.push(edge(hubUuid, uuid, 1, 'visit', now))
      }
      if (i === 6) {
        const nextRegion = (r + 1) % STRESS_REGIONS.length
        edges.push(edge(uuid, `stress-${nextRegion}-1`, 1, 'visit', now))
      }
      if (i === 13) {
        const nextRegion = (r + 2) % STRESS_REGIONS.length
        edges.push(edge(uuid, `stress-${nextRegion}-0`, 1, 'visit', now))
      }
    }
  }

  if (nodes.length !== STRESS_NODE_COUNT) {
    throw new Error(`seed.ts: expected ${STRESS_NODE_COUNT} stress nodes, built ${nodes.length}`)
  }

  return {
    regions,
    nodes,
    edges,
    notes,
    memos: [],
    activeNodeUuid,
  }
}
