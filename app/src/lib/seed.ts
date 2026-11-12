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
export const FIRST_RUN_TAB_COUNT = 28
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
  regionId: RegionId
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
    regionId: spec.regionId,
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
/* §9 — First run: 28 curated designer tabs across 4 spatial islands   */
/* ------------------------------------------------------------------ */

export function buildFirstRunSeed(now: number): SeedGraph {
  const regions: Region[] = [
    { id: 'region-visual-references', name: 'Visual References', color: '#8E8E96', center: { x: -40, y: -840 }, radius: 480, createdAt: now },
    { id: 'region-typography-foundries', name: 'Typography & Foundries', color: '#B5B0A5', center: { x: 1140, y: 0 }, radius: 480, createdAt: now },
    { id: 'region-motion-shaders', name: 'Motion & Shaders', color: '#6E6A61', center: { x: 40, y: 860 }, radius: 480, createdAt: now },
    { id: 'region-studios-projects', name: 'Studios & Projects', color: '#5A5A63', center: { x: -1160, y: 0 }, radius: 480, createdAt: now },
  ]

  const activeUuid: NodeUuid = 'seed-arena-type-rhythm'

  const specs: SeedNodeSpec[] = [
    /* --- Region A: Visual References (6 hibernated + 1 live anchor) -- */
    {
      uuid: 'seed-arena-type-rhythm',
      url: 'https://www.are.na/studio-notebook/type-rhythm',
      title: 'Are.na — Type & Rhythm (channel)',
      keywords: ['arena', 'channel', 'type', 'rhythm', 'reference', 'moodboard'],
      regionId: 'region-visual-references',
      dx: -40, dy: -40, ageDays: 0, createdDaysAgo: 6,
      ramState: 'live', isPinned: true,
      previewKind: 'duotone',
    },
    {
      uuid: 'seed-arena-brutalist-web',
      url: 'https://www.are.na/marie-lou/brutalist-web-graphics',
      title: 'Are.na — Brutalist Web Graphics (channel)',
      keywords: ['arena', 'brutalist', 'web', 'graphics', 'channel'],
      regionId: 'region-visual-references',
      dx: -260, dy: -150, ageDays: 3, createdDaysAgo: 12,
      parentUuid: activeUuid,
      previewKind: 'duotone',
    },
    {
      uuid: 'seed-dribbble-editorial-cards',
      url: 'https://dribbble.com/shots/24891-editorial-type-cards',
      title: 'Dribbble — Editorial Type Cards (private shot)',
      keywords: ['dribbble', 'editorial', 'cards', 'glass', 'private'],
      regionId: 'region-visual-references',
      dx: 250, dy: -150, ageDays: 9, createdDaysAgo: 14,
      noCapture: true,
      previewKind: 'duotone',
    },
    {
      uuid: 'seed-savee-grain-studies',
      url: 'https://savee.it/s/generative-grain-studies',
      title: 'Savee — Generative Grain Studies',
      keywords: ['savee', 'grain', 'generative', 'texture', 'reference'],
      regionId: 'region-visual-references',
      dx: 270, dy: 40, ageDays: 2, createdDaysAgo: 5,
      parentUuid: 'seed-arena-brutalist-web',
      previewKind: 'duotone',
    },
    {
      uuid: 'seed-siteinspire-editorial',
      url: 'https://www.siteinspire.com/websites?categories=editorial',
      title: 'SiteInspire — Editorial Layouts',
      keywords: ['siteinspire', 'editorial', 'layouts', 'gallery', 'inspiration'],
      regionId: 'region-visual-references',
      dx: -250, dy: 70, ageDays: 23, createdDaysAgo: 34,
      previewKind: 'duotone',
    },
    {
      uuid: 'seed-cosmos-riso-textures',
      url: 'https://cosmos.so/search?query=risograph+textures',
      title: 'Cosmos — Risograph Textures (collection)',
      keywords: ['cosmos', 'risograph', 'textures', 'print', 'collection'],
      regionId: 'region-visual-references',
      dx: -10, dy: 100, ageDays: 40, createdDaysAgo: 52,
      excerpt:
        '> Cached snapshot — cosmos.so risograph textures\n\n' +
        'Three-grain riso passes: underprint at 12% dot gain, mid registration\n' +
        'offset of 1.5pt, and a final ink-starved flood. Steal the layer order\n' +
        'for the canvas texture study — never more than two hues per pass.\n\n' +
        '*(Dead link — cached Readability text.)*',
      previewKind: 'duotone',
    },

    /* --- Region B: Typography & Foundries (hub + 6, dup pair) -------- */
    {
      // §7.1 ephemeral google.com search-hub router (pinned anchor of region B).
      uuid: 'seed-hub-google-foundries',
      url: 'https://www.google.com/search?q=variable+font+foundry+specimens',
      title: 'Google — variable font foundry specimens',
      keywords: ['google', 'search', 'hub', 'router', 'foundry'],
      regionId: 'region-typography-foundries',
      dx: 0, dy: 0, ageDays: 6, createdDaysAgo: 8,
      nodeType: 'hub', isPinned: true, ephemeral: true,
      previewKind: 'wireframe',
    },
    {
      uuid: 'seed-pp-neue-montreal',
      url: 'https://pangrampangram.com/products/pp-neue-montreal',
      title: 'PP Neue Montreal — Pangram Pangram',
      keywords: ['pangram', 'neue', 'montreal', 'specimen', 'grotesque'],
      regionId: 'region-typography-foundries',
      dx: 220, dy: -160, ageDays: 5, createdDaysAgo: 9,
      searchQuery: 'pp neue montreal specimen',
      parentUuid: 'seed-hub-google-foundries',
      previewKind: 'type-specimen',
    },
    {
      uuid: 'seed-typewolf-trends',
      url: 'https://www.typewolf.com/trends',
      title: 'Typewolf — Trends in Web Typography',
      keywords: ['typewolf', 'trends', 'pairings', 'web', 'type'],
      regionId: 'region-typography-foundries',
      dx: 250, dy: 20, ageDays: 6, createdDaysAgo: 10,
      searchQuery: 'typewolf variable font trends',
      parentUuid: 'seed-hub-google-foundries',
      previewKind: 'type-specimen',
    },
    {
      uuid: 'seed-gfonts-instrument-sans',
      url: 'https://fonts.google.com/specimen/InstrumentSans',
      title: 'Google Fonts — Instrument Sans',
      keywords: ['google', 'fonts', 'instrument', 'sans', 'variable'],
      regionId: 'region-typography-foundries',
      dx: 240, dy: 180, ageDays: 3, createdDaysAgo: 7,
      parentUuid: 'seed-typewolf-trends',
      previewKind: 'type-specimen',
    },
    {
      uuid: 'seed-klim-soehne',
      url: 'https://klim.co.nz/retail-fonts/soehne',
      title: 'Klim — Söhne specimen',
      keywords: ['klim', 'soehne', 'specimen', 'foundry', 'grotesque'],
      regionId: 'region-typography-foundries',
      dx: -230, dy: -140, ageDays: 18, createdDaysAgo: 26,
      parentUuid: 'seed-typewolf-trends',
      previewKind: 'type-specimen',
    },
    {
      // §7.6 duplicate: canonicalizeUrl strips `ref`, so both nodes share one
      // url_hash — sticky notes attached below show on BOTH instances.
      uuid: 'seed-klim-soehne-mirror',
      url: 'https://klim.co.nz/retail-fonts/soehne?ref=typewolf',
      title: 'Klim — Söhne (reader mirror)',
      keywords: ['klim', 'soehne', 'mirror', 'reader', 'offline'],
      regionId: 'region-typography-foundries',
      dx: -250, dy: 30, ageDays: 3, createdDaysAgo: 5,
      parentUuid: 'seed-klim-soehne',
      previewKind: 'type-specimen',
    },
    {
      uuid: 'seed-fontsinuse-grotesque',
      url: 'https://fontsinuse.com/uses/32011/editorial-grotesque-pairing',
      title: 'Fonts In Use — Editorial grotesque pairing',
      keywords: ['fontsinuse', 'editorial', 'pairing', 'grotesque', 'case'],
      regionId: 'region-typography-foundries',
      dx: 15, dy: 205, ageDays: 12, createdDaysAgo: 18,
      previewKind: 'type-specimen',
    },

    /* --- Region C: Motion & Shaders (5 hibernated + 1 live audible) -- */
    {
      uuid: 'seed-shadertoy-ink-fluid',
      url: 'https://www.shadertoy.com/view/XtBGD3',
      title: 'Shadertoy — Fluid Ink Simulation (audio-reactive)',
      keywords: ['shadertoy', 'fluid', 'ink', 'shader', 'audio'],
      regionId: 'region-motion-shaders',
      dx: 0, dy: -20, ageDays: 0, createdDaysAgo: 2,
      ramState: 'live', isAudible: true, isPinned: true,
      previewKind: 'swatch-board',
    },
    {
      uuid: 'seed-compute-toys-water',
      url: 'https://compute.toys/view/42-water-sim',
      title: 'Compute.Toys — Water Simulation',
      keywords: ['compute', 'water', 'simulation', 'wgsl', 'particles'],
      regionId: 'region-motion-shaders',
      dx: 240, dy: -150, ageDays: 8, createdDaysAgo: 13,
      previewKind: 'swatch-board',
    },
    {
      uuid: 'seed-three-tsl-nodes',
      url: 'https://threejs.org/manual/en/tsl.html',
      title: 'Three.js — TSL node materials',
      keywords: ['threejs', 'tsl', 'nodes', 'materials', 'webgl'],
      regionId: 'region-motion-shaders',
      dx: -220, dy: -110, ageDays: 4, createdDaysAgo: 7,
      parentUuid: 'seed-compute-toys-water',
      previewKind: 'swatch-board',
    },
    {
      uuid: 'seed-heckel-study-of-shaders',
      url: 'https://maximeheckel.com/posts/the-study-of-shaders-with-react-three-fiber',
      title: 'Maxime Heckel — The Study of Shaders',
      keywords: ['shaders', 'r3f', 'noise', 'webgl', 'study'],
      regionId: 'region-motion-shaders',
      dx: 210, dy: 130, ageDays: 25, createdDaysAgo: 38,
      parentUuid: 'seed-shadertoy-ink-fluid',
      previewKind: 'swatch-board',
    },
    {
      uuid: 'seed-book-of-shaders-noise',
      url: 'https://thebookofshaders.com/07/',
      title: 'The Book of Shaders — Chapter 7 (Noise)',
      keywords: ['glsl', 'noise', 'fbm', 'shaders', 'book'],
      regionId: 'region-motion-shaders',
      dx: -210, dy: 150, ageDays: 40, createdDaysAgo: 55,
      excerpt:
        '> Cached snapshot — thebookofshaders.com/07\n\n' +
        'Noise is the shadow of randomness. Gradient noise (Perlin/Simplex)\n' +
        'beats value noise for ink flow; stack fbm at 4 octaves and warp the\n' +
        'domain once for turbulence, twice for curl.\n\n' +
        '*(Dead link — cached Readability text.)*',
      previewKind: 'swatch-board',
    },
    {
      uuid: 'seed-webglfund-image-processing',
      url: 'https://webglfundamentals.org/webgl/lessons/en/webgl-image-processing.html',
      title: 'WebGL Fundamentals — Image Processing',
      keywords: ['webgl', 'kernels', 'convolution', 'texture', 'fundamentals'],
      regionId: 'region-motion-shaders',
      dx: 20, dy: 190, ageDays: 11, createdDaysAgo: 16,
      previewKind: 'swatch-board',
    },

    /* --- Region D: Studios & Projects (1 live + 6 hibernated) -------- */
    {
      uuid: 'seed-figma-ds-v3',
      url: 'https://www.figma.com/design/qR8xK2mV3p/design-system-v3',
      title: 'Figma — Design System v3 · Foundations (SPA trail)',
      keywords: ['figma', 'design-system', 'foundations', 'tokens', 'components'],
      regionId: 'region-studios-projects',
      dx: 0, dy: -30, ageDays: 0, createdDaysAgo: 3,
      ramState: 'live',
      // §7.3 SPA node — in-page pushState trail shown as an expandable filmstrip.
      subPages: [
        { title: 'Design System v3 · Cover', url: 'https://www.figma.com/design/qR8xK2mV3p/design-system-v3?node-id=0-1' },
        { title: 'Design System v3 · Foundations', url: 'https://www.figma.com/design/qR8xK2mV3p/design-system-v3?node-id=12-402' },
        { title: 'Design System v3 · Components', url: 'https://www.figma.com/design/qR8xK2mV3p/design-system-v3?node-id=31-1180' },
      ],
      previewKind: 'wireframe',
    },
    {
      uuid: 'seed-figma-radix-kit',
      url: 'https://www.figma.com/community/file/1189023415/radix-ui-kit',
      title: 'Figma Community — Radix UI kit',
      keywords: ['figma', 'community', 'radix', 'kit', 'components'],
      regionId: 'region-studios-projects',
      dx: 235, dy: -140, ageDays: 7, createdDaysAgo: 11,
      parentUuid: 'seed-figma-ds-v3',
      previewKind: 'wireframe',
    },
    {
      uuid: 'seed-behance-dumbar-motion',
      url: 'https://www.behance.net/gallery/184902311/studio-dumbar-motion-identity',
      title: 'Behance — Studio Dumbar motion identity',
      keywords: ['behance', 'dumbar', 'motion', 'identity', 'studio'],
      regionId: 'region-studios-projects',
      dx: 250, dy: 100, ageDays: 13, createdDaysAgo: 20,
      previewKind: 'logo-mark',
    },
    {
      uuid: 'seed-pentagram-editorial',
      url: 'https://www.pentagram.com/work/editorial-systems',
      title: 'Pentagram — Editorial systems',
      keywords: ['pentagram', 'editorial', 'identity', 'systems', 'studio'],
      regionId: 'region-studios-projects',
      dx: -235, dy: -130, ageDays: 28, createdDaysAgo: 44,
      excerpt:
        '> Cached snapshot — pentagram.com editorial systems\n\n' +
        'The grid is the identity: a fixed baseline, three column widths and\n' +
        'one accent weight carry every page. Logotype never scales past 40%\n' +
        'of the measure.\n\n*(Dead link — cached Readability text.)*',
      previewKind: 'logo-mark',
    },
    {
      uuid: 'seed-koto-rebrand-cases',
      url: 'https://koto.studio/work/global-rebrands',
      title: 'Koto — Global rebrand case studies',
      keywords: ['koto', 'rebrand', 'case', 'studio', 'brand'],
      regionId: 'region-studios-projects',
      dx: -250, dy: 130, ageDays: 19, createdDaysAgo: 31,
      previewKind: 'logo-mark',
    },
    {
      // §7.2 — the "Activate on Adobe Fonts" chain (OAuth + sign-in redirect)
      // collapsed into ONE "via auth" node, reached from the Klim specimen.
      uuid: 'seed-adobe-fonts-via-auth',
      url: 'https://fonts.adobe.com/fonts/soehne',
      title: 'Adobe Fonts — Söhne web activation (via auth)',
      keywords: ['adobe', 'fonts', 'activation', 'web', 'via-auth'],
      regionId: 'region-studios-projects',
      dx: 15, dy: 165, ageDays: 2, createdDaysAgo: 4,
      viaAuth: true,
      parentUuid: 'seed-klim-soehne',
      previewKind: 'type-specimen',
    },
    {
      uuid: 'seed-mdn-backdrop-filter',
      url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter',
      title: 'MDN — backdrop-filter',
      keywords: ['mdn', 'backdrop-filter', 'css', 'glass', 'blur'],
      regionId: 'region-studios-projects',
      dx: -15, dy: 210, ageDays: 21, createdDaysAgo: 33,
      excerpt:
        '> Cached snapshot — developer.mozilla.org backdrop-filter\n\n' +
        '`backdrop-filter: blur(14px) saturate(1.4)` reads best over moving\n' +
        'content; pair it with a 1px translucent border and keep an opaque\n' +
        'fallback (`@supports not (backdrop-filter: blur(1px))`).\n\n' +
        '*(Dead link — cached Readability text.)*',
      previewKind: 'wireframe',
    },

    /* --- Ghost Echoes tethered beside the active node (§4.3, §6) ----- */
    {
      uuid: 'seed-ghost-swiss-archive',
      url: 'https://www.are.na/pixel-plateau/swiss-typography-archive',
      title: 'Are.na — Swiss Typography Archive',
      keywords: ['arena', 'swiss', 'typography', 'archive', 'ghost'],
      regionId: 'region-visual-references',
      dx: 150, dy: 105, ageDays: 1, createdDaysAgo: 1,
      nodeType: 'ghost-echo',
      ghostOfUuid: null,
      ghostTetherUuid: activeUuid,
      ghostMatch: 0.9,
      previewKind: 'duotone',
    },
    {
      uuid: 'seed-ghost-typewolf-sotm',
      url: 'https://www.typewolf.com/site-of-the-month',
      title: 'Typewolf — Site of the Month',
      keywords: ['typewolf', 'site-of-the-month', 'type', 'ghost'],
      regionId: 'region-visual-references',
      dx: 45, dy: 175, ageDays: 2, createdDaysAgo: 2,
      nodeType: 'ghost-echo',
      ghostOfUuid: null,
      ghostTetherUuid: activeUuid,
      ghostMatch: 0.83,
      previewKind: 'type-specimen',
    },
  ]

  const nodes = specs.map((spec) => {
    const region = regions.find((r) => r.id === spec.regionId)
    if (!region) throw new Error(`seed.ts: unknown region ${spec.regionId} for node ${spec.uuid}`)
    return materializeNode(spec, region.center.x, region.center.y, now)
  })

  if (nodes.length !== FIRST_RUN_TAB_COUNT) {
    throw new Error(`seed.ts: expected ${FIRST_RUN_TAB_COUNT} first-run nodes, built ${nodes.length}`)
  }

  const edges: GraphEdgeRecord[] = [
    // Visual References — browsing path through the boards
    edge(activeUuid, 'seed-arena-brutalist-web', 2, 'visit', now),
    edge(activeUuid, 'seed-dribbble-editorial-cards', 1, 'visit', now),
    edge('seed-arena-brutalist-web', 'seed-savee-grain-studies', 1, 'spawn', now),
    edge('seed-savee-grain-studies', 'seed-cosmos-riso-textures', 1, 'visit', now),
    edge('seed-dribbble-editorial-cards', 'seed-siteinspire-editorial', 1, 'visit', now),
    // Typography & Foundries — hub spokes + specimen walk
    edge('seed-hub-google-foundries', 'seed-pp-neue-montreal', 1, 'visit', now),
    edge('seed-hub-google-foundries', 'seed-typewolf-trends', 1, 'visit', now),
    edge('seed-typewolf-trends', 'seed-gfonts-instrument-sans', 1, 'visit', now),
    edge('seed-typewolf-trends', 'seed-klim-soehne', 2, 'visit', now),
    edge('seed-klim-soehne', 'seed-klim-soehne-mirror', 1, 'visit', now),
    edge('seed-klim-soehne-mirror', 'seed-fontsinuse-grotesque', 1, 'visit', now),
    // Motion & Shaders — from the audio-reactive toy down the reading path
    edge('seed-shadertoy-ink-fluid', 'seed-compute-toys-water', 2, 'visit', now),
    edge('seed-compute-toys-water', 'seed-three-tsl-nodes', 1, 'spawn', now),
    edge('seed-shadertoy-ink-fluid', 'seed-heckel-study-of-shaders', 1, 'visit', now),
    edge('seed-heckel-study-of-shaders', 'seed-book-of-shaders-noise', 1, 'visit', now),
    edge('seed-three-tsl-nodes', 'seed-webglfund-image-processing', 1, 'visit', now),
    // Studios & Projects — active Figma work + studio research
    edge('seed-figma-ds-v3', 'seed-figma-radix-kit', 1, 'visit', now),
    edge('seed-pentagram-editorial', 'seed-behance-dumbar-motion', 1, 'visit', now),
    edge('seed-behance-dumbar-motion', 'seed-koto-rebrand-cases', 1, 'visit', now),
    edge('seed-klim-soehne', 'seed-adobe-fonts-via-auth', 1, 'visit', now),
    // Cross-island paths — type channel → specimen; glass cards → MDN doc
    edge(activeUuid, 'seed-gfonts-instrument-sans', 1, 'visit', now),
    edge('seed-dribbble-editorial-cards', 'seed-mdn-backdrop-filter', 1, 'visit', now),
    // Ghost tethers (§4.3, §6)
    edge(activeUuid, 'seed-ghost-swiss-archive', 0, 'ghost', now),
    edge(activeUuid, 'seed-ghost-typewolf-sotm', 0, 'ghost', now),
  ]

  // Notes attach to url_hash (§7.6) — the Klim pair note shows on BOTH duplicates.
  const dupHash = urlHashOf('https://klim.co.nz/retail-fonts/soehne')
  const notes: StickyNote[] = [
    note('seed-note-1', dupHash, 'Söhne is the voice of the whole canvas chrome — track weights 400/500 only; license already covers web + app.', 4, now),
    note('seed-note-2', urlHashOf('https://www.are.na/studio-notebook/type-rhythm'), 'Refresh this channel before Thursday\'s moodboard review — pull the two kinetic type entries.', 1, now),
    note('seed-note-3', urlHashOf('https://pangrampangram.com/products/pp-neue-montreal'), 'PP Neue Montreal for marketing pages; Söhne stays product. Check the trial-license expiry.', 3, now),
    note('seed-note-4', urlHashOf('https://www.shadertoy.com/view/XtBGD3'), 'Audio-reactive ink shader — steal the fbm domain-warp for the canvas background study.', 2, now),
    note('seed-note-5', urlHashOf('https://www.figma.com/design/qR8xK2mV3p/design-system-v3'), 'v3 foundations: token names match index.css (border-subtle/hover/active). Filmstrip trail shows the page order.', 2, now),
    note('seed-note-6', urlHashOf('https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter'), 'Glass pills: backdrop-blur + saturate(1.4) reads best over moving content.', 5, now),
  ]

  return { regions, nodes, edges, notes, memos: [], activeNodeUuid: activeUuid }
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
