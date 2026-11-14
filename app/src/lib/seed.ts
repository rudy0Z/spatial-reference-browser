/**
 * app/src/lib/seed.ts — first-run 28-tab seed (SPEC §9) + 600-node stress
 * seed (SPEC §4.4 / §5.4). Deterministic given `now`.
 *
 * First-run composition (exactly 28 nodes, 4 spatial islands):
 *   3 live · 22 hibernated (7 older than 14 days for visible decay) ·
 *   1 ephemeral google.com hub · 2 Ghost Echoes
 * and every §7 edge case present at least once:
 *   §7.1 hub + query-tagged children · §7.2 via-auth collapse example ·
 *   §7.3 SPA filmstrip node with subPages[] · §7.4 noCapture private node ·
 *   §7.5 dead-link cached excerpts · §7.6 duplicate-url_hash pair sharing
 *   notes · §5.3/§7.7 one audible live tab + pinned anchors.
 */
import { tokenize } from './embed'
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
  RamState,
  Region,
  RegionId,
  SpatialTabNodeRecord,
  StickyNote,
  SubPageRef,
  VoiceMemo,
} from './types'

export const FIRST_RUN_SEED_VERSION = 1
export const STRESS_SEED_VERSION = 2
export const FIRST_RUN_TAB_COUNT = 28
export const STRESS_NODE_COUNT = 600
export const STRESS_REGION_COUNT = 6

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
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/* ------------------------------------------------------------------ */
/* §9 — First run: 28 curated tabs across 4 spatial islands            */
/* ------------------------------------------------------------------ */

export function buildFirstRunSeed(now: number): SeedGraph {
  const regions: Region[] = [
    { id: 'region-ui-inspiration', name: 'UI Inspiration', color: '#34D399', center: { x: -40, y: -840 }, radius: 480, createdAt: now },
    { id: 'region-browser-arch', name: 'Browser Architecture', color: '#60A5FA', center: { x: 1140, y: 0 }, radius: 480, createdAt: now },
    { id: 'region-webgpu-shaders', name: 'WebGPU & Shaders', color: '#22D3EE', center: { x: 40, y: 860 }, radius: 480, createdAt: now },
    { id: 'region-career-jobhunt', name: 'Career & Job Hunt', color: '#FDE047', center: { x: -1160, y: 0 }, radius: 480, createdAt: now },
  ]

  const activeUuid: NodeUuid = 'seed-ui-rf-performance'

  const specs: SeedNodeSpec[] = [
    /* --- Region A: UI Inspiration (6 hibernated + 1 live anchor) ------ */
    {
      uuid: 'seed-ui-radix',
      url: 'https://www.radix-ui.com/primitives',
      title: 'Radix Primitives — Accessible Component APIs',
      keywords: ['radix', 'primitives', 'accessibility', 'components', 'react'],
      regionId: 'region-ui-inspiration',
      dx: -260, dy: -150, ageDays: 3, createdDaysAgo: 12,
    },
    {
      uuid: 'seed-ui-linear-method',
      url: 'https://linear.app/method',
      title: 'Linear Method — Building Quality Software',
      keywords: ['linear', 'method', 'product', 'craft', 'workflow'],
      regionId: 'region-ui-inspiration',
      dx: 10, dy: -230, ageDays: 21, createdDaysAgo: 40,
    },
    {
      uuid: 'seed-ui-tailwind-v4',
      url: 'https://tailwindcss.com/blog/tailwindcss-v4',
      title: 'Tailwind CSS v4 — Engine Internals',
      keywords: ['tailwind', 'css', 'engine', 'oxide', 'design-tokens'],
      regionId: 'region-ui-inspiration',
      dx: 250, dy: -150, ageDays: 5, createdDaysAgo: 9,
      parentUuid: activeUuid,
    },
    {
      uuid: 'seed-ui-motion-springs',
      url: 'https://motion.dev/docs/react-springs',
      title: 'Framer Motion — Spring Physics Recipes',
      keywords: ['motion', 'springs', 'animation', 'physics', 'framer'],
      regionId: 'region-ui-inspiration',
      dx: 270, dy: 40, ageDays: 40, createdDaysAgo: 55,
      excerpt:
        '> Cached snapshot — motion.dev/docs/react-springs\n\n' +
        'Springs fire from `stiffness: 380, damping: 30`. Never animate with linear\n' +
        'easing; drive blur/transform only, and let interrupted springs retarget\n' +
        'instead of restarting.\n\n*(Dead link — cached Readability text.)*',
    },
    {
      uuid: 'seed-ui-dribbble-glass',
      url: 'https://dribbble.com/shots/2489-glass-cards',
      title: 'Dribbble — Glass Card Explorations (private shot)',
      keywords: ['dribbble', 'glass', 'cards', 'inspiration', 'private'],
      regionId: 'region-ui-inspiration',
      dx: -250, dy: 70, ageDays: 9, createdDaysAgo: 14,
      noCapture: true,
    },
    {
      uuid: 'seed-ui-kinopio',
      url: 'https://kinopio.club',
      title: 'Kinopio — Spatial Thinking Notes',
      keywords: ['kinopio', 'spatial', 'notes', 'thinking', 'canvas'],
      regionId: 'region-ui-inspiration',
      dx: -10, dy: 100, ageDays: 2, createdDaysAgo: 6,
    },
    {
      uuid: activeUuid,
      url: 'https://reactflow.dev/learn/performance',
      title: 'React Flow — Performance & Large Graphs',
      keywords: ['reactflow', 'performance', 'canvas', 'culling', 'zoom', 'lod'],
      regionId: 'region-ui-inspiration',
      dx: -40, dy: -40, ageDays: 0, createdDaysAgo: 1,
      ramState: 'live', isPinned: true,
    },

    /* --- Region B: Browser Architecture (6 hibernated + hub) --------- */
    {
      uuid: 'seed-browser-servo',
      url: 'https://servo.org/blog/servo-architecture/',
      title: 'Servo — Rust Engine Architecture',
      keywords: ['servo', 'rust', 'engine', 'architecture', 'layout'],
      regionId: 'region-browser-arch',
      dx: -180, dy: -170, ageDays: 12, createdDaysAgo: 20,
    },
    {
      uuid: 'seed-browser-wcv-pool',
      url: 'https://www.electronjs.org/docs/latest/api/web-contents-view',
      title: 'Electron — WebContentsView Pool Management',
      keywords: ['electron', 'webcontentsview', 'pool', 'tabs', 'ipc'],
      regionId: 'region-browser-arch',
      dx: 70, dy: -200, ageDays: 1, createdDaysAgo: 3,
    },
    {
      uuid: 'seed-browser-chromium-www',
      url: 'https://www.chromium.org/developers/design-documents/multi-process-architecture',
      title: 'Chromium — Multi-process Architecture',
      keywords: ['chromium', 'multiprocess', 'sandbox', 'architecture', 'site-isolation'],
      regionId: 'region-browser-arch',
      dx: 260, dy: -120, ageDays: 30, createdDaysAgo: 45,
      excerpt:
        '> Cached snapshot — chromium.org multi-process-architecture\n\n' +
        'Process-per-site-instance isolates renderer crashes and the GPU process\n' +
        'owns all compositing. Threads talk over Mojo IPC channels with a shared\n' +
        'browser-process scheduler.\n\n*(Dead link — cached Readability text.)*',
    },
    {
      // §7.6 duplicate: same canonical URL as the node above (www + utm stripped).
      uuid: 'seed-browser-chromium-mirror',
      url: 'https://chromium.org/developers/design-documents/multi-process-architecture?utm_source=rss',
      title: 'Chromium — Multi-process Architecture (reader mirror)',
      keywords: ['chromium', 'multiprocess', 'mirror', 'reader', 'offline'],
      regionId: 'region-browser-arch',
      dx: 280, dy: 60, ageDays: 3, createdDaysAgo: 5,
    },
    {
      // §7.1 ephemeral google.com search-hub router (pinned anchor of region B).
      uuid: 'seed-hub-google-rendering',
      url: 'https://www.google.com/search?q=web+rendering+architecture',
      title: 'Google — web rendering architecture',
      keywords: ['google', 'search', 'hub', 'router', 'rendering'],
      regionId: 'region-browser-arch',
      dx: 0, dy: 0, ageDays: 6, createdDaysAgo: 8,
      nodeType: 'hub', isPinned: true, ephemeral: true,
    },
    {
      uuid: 'seed-browser-tls-handshake',
      url: 'https://www.cloudflare.com/learning/ssl/what-happens-in-a-tls-handshake/',
      title: 'What Happens in a TLS Handshake',
      keywords: ['tls', 'handshake', 'ssl', 'cloudflare', 'security'],
      regionId: 'region-browser-arch',
      dx: 240, dy: 150, ageDays: 6, createdDaysAgo: 8,
      searchQuery: 'tls handshake diagram',
      parentUuid: 'seed-hub-google-rendering',
    },
    {
      uuid: 'seed-browser-v8-pipeline',
      url: 'https://v8.dev/blog/cost-of-javascript',
      title: 'V8 — The Cost of JavaScript & Compilation Pipeline',
      keywords: ['v8', 'javascript', 'compilation', 'pipeline', 'ignition'],
      regionId: 'region-browser-arch',
      dx: -200, dy: 130, ageDays: 15, createdDaysAgo: 22,
      searchQuery: 'v8 compilation pipeline',
      parentUuid: 'seed-hub-google-rendering',
    },

    /* --- Region C: WebGPU & Shaders (5 hibernated + 1 live audible) -- */
    {
      uuid: 'seed-webgpu-fluid',
      url: 'https://webgpu.dev/fluid-playground',
      title: 'WebGPU Fluid Shader Playground',
      keywords: ['webgpu', 'fluid', 'shaders', 'compute', 'playground'],
      regionId: 'region-webgpu-shaders',
      dx: 0, dy: -20, ageDays: 0, createdDaysAgo: 2,
      ramState: 'live', isAudible: true, isPinned: true,
    },
    {
      uuid: 'seed-webgpu-water',
      url: 'https://compute.toys/view/42-water-sim',
      title: 'Compute.Toys — Water Simulation',
      keywords: ['compute', 'water', 'simulation', 'wgsl', 'particles'],
      regionId: 'region-webgpu-shaders',
      dx: 240, dy: -150, ageDays: 8, createdDaysAgo: 13,
    },
    {
      // §7.3 SPA node — in-domain pushState trail shown as a filmstrip.
      uuid: 'seed-webgpu-wgsl-spa',
      url: 'https://gpuweb.github.io/gpuweb/wgsl/',
      title: 'WGSL — Language Reference (SPA trail)',
      keywords: ['wgsl', 'shader', 'language', 'reference', 'spa'],
      regionId: 'region-webgpu-shaders',
      dx: -220, dy: -110, ageDays: 2, createdDaysAgo: 4,
      parentUuid: 'seed-webgpu-fluid',
      subPages: [
        { title: 'WGSL — Types', url: 'https://gpuweb.github.io/gpuweb/wgsl/#types' },
        { title: 'WGSL — Uniform & Storage Buffers', url: 'https://gpuweb.github.io/gpuweb/wgsl/#uniforms' },
        { title: 'WGSL — Execution Modes', url: 'https://gpuweb.github.io/gpuweb/wgsl/#execution-modes' },
      ],
    },
    {
      uuid: 'seed-webgpu-f1-trace',
      url: 'https://www.shadertoy.com/view/f1-telemetry-trace',
      title: 'F1 Telemetry — GPU Trace Shaders',
      keywords: ['f1', 'telemetry', 'shaders', 'gpu', 'viz'],
      regionId: 'region-webgpu-shaders',
      dx: 210, dy: 130, ageDays: 25, createdDaysAgo: 38,
    },
    {
      uuid: 'seed-webgpu-three-tsl',
      url: 'https://threejs.org/manual/#en/tsl',
      title: 'Three.js — TSL Node Materials',
      keywords: ['threejs', 'tsl', 'nodes', 'materials', 'webgl'],
      regionId: 'region-webgpu-shaders',
      dx: -210, dy: 150, ageDays: 4, createdDaysAgo: 7,
    },
    {
      uuid: 'seed-webgpu-audio-analyser',
      url: 'https://webaudio.github.io/web-audio-api/',
      title: 'Web Audio — Analyser Visualizers',
      keywords: ['webaudio', 'analyser', 'visualizer', 'waveform', 'music'],
      regionId: 'region-webgpu-shaders',
      dx: 20, dy: 190, ageDays: 11, createdDaysAgo: 16,
    },

    /* --- Region D: Career & Job Hunt (5 hibernated + 1 live) --------- */
    {
      uuid: 'seed-career-f1-api',
      url: 'https://api.formula1.com/v1/telemetry-docs',
      title: 'F1 — Official Telemetry API Docs',
      keywords: ['f1', 'telemetry', 'api', 'docs', 'rate-limits'],
      regionId: 'region-career-jobhunt',
      dx: -10, dy: -10, ageDays: 7, createdDaysAgo: 10,
      isPinned: true,
    },
    {
      uuid: 'seed-career-observable-telemetry',
      url: 'https://observablehq.com/@d3/telemetry-brushing',
      title: 'Observable — Telemetry Brushing & D3',
      keywords: ['observable', 'd3', 'brushing', 'telemetry', 'viz'],
      regionId: 'region-career-jobhunt',
      dx: -250, dy: -130, ageDays: 18, createdDaysAgo: 30,
    },
    {
      uuid: 'seed-career-sysdesign',
      url: 'https://github.com/donnemartin/system-design-primer',
      title: 'System Design Primer — GitHub',
      keywords: ['system-design', 'primer', 'github', 'interview', 'scale'],
      regionId: 'region-career-jobhunt',
      dx: 230, dy: -120, ageDays: 3, createdDaysAgo: 6,
    },
    {
      // §7.2 — oauth/job-application redirect chain collapsed into ONE "via auth" node.
      uuid: 'seed-career-linkedin-via-auth',
      url: 'https://www.linkedin.com/jobs/view/4039128822',
      title: 'Senior Spatial UI Engineer — Application (via auth)',
      keywords: ['linkedin', 'job', 'application', 'spatial', 'engineer'],
      regionId: 'region-career-jobhunt',
      dx: 250, dy: 100, ageDays: 1, createdDaysAgo: 2,
      viaAuth: true,
      parentUuid: 'seed-career-sysdesign',
    },
    {
      uuid: 'seed-career-resume-readcv',
      url: 'https://read.cv/guides/design-engineer-resume',
      title: 'read.cv — Design Engineer Resume Guide',
      keywords: ['resume', 'portfolio', 'cv', 'design-engineer', 'career'],
      regionId: 'region-career-jobhunt',
      dx: -230, dy: 130, ageDays: 35, createdDaysAgo: 50,
      excerpt:
        '> Cached snapshot — read.cv design-engineer resume guide\n\n' +
        'Lead with shipped surfaces, not keywords. One screen per project: a 16:9\n' +
        'capture, a one-line problem statement, and the hardest constraint you\n' +
        'held under pressure.\n\n*(Dead link — cached Readability text.)*',
    },
    {
      uuid: 'seed-career-gh-rust',
      url: 'https://github.com/topics/rust',
      title: 'GitHub — Rust Topic',
      keywords: ['github', 'rust', 'topics', 'opensource', 'live'],
      regionId: 'region-career-jobhunt',
      dx: 10, dy: 160, ageDays: 0, createdDaysAgo: 1,
      ramState: 'live',
    },

    /* --- Ghost Echoes tethered beside the active node (§4.3, §6) ----- */
    {
      uuid: 'seed-ghost-xyflow-theming',
      url: 'https://reactflow.dev/learn/theming',
      title: 'React Flow — Theming & Styling',
      keywords: ['reactflow', 'theming', 'styling', 'ghost', 'echo'],
      regionId: 'region-ui-inspiration',
      dx: 150, dy: 105, ageDays: 1, createdDaysAgo: 1,
      nodeType: 'ghost-echo',
      ghostOfUuid: null,
      ghostTetherUuid: activeUuid,
      ghostMatch: 0.92,
    },
    {
      uuid: 'seed-ghost-d3-force',
      url: 'https://d3js.org/d3-force/simulation',
      title: 'd3-force — Simulation Guide',
      keywords: ['d3', 'force', 'simulation', 'physics', 'ghost'],
      regionId: 'region-ui-inspiration',
      dx: 45, dy: 175, ageDays: 2, createdDaysAgo: 2,
      nodeType: 'ghost-echo',
      ghostOfUuid: null,
      ghostTetherUuid: activeUuid,
      ghostMatch: 0.84,
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
    edge(activeUuid, 'seed-ui-radix', 2, 'visit', now),
    edge(activeUuid, 'seed-ui-tailwind-v4', 1, 'spawn', now),
    edge('seed-ui-tailwind-v4', 'seed-ui-motion-springs', 1, 'visit', now),
    edge('seed-ui-motion-springs', 'seed-ui-dribbble-glass', 1, 'visit', now),
    edge('seed-ui-dribbble-glass', 'seed-ui-kinopio', 1, 'visit', now),
    edge('seed-ui-radix', 'seed-ui-linear-method', 1, 'visit', now),
    edge('seed-browser-servo', 'seed-browser-wcv-pool', 2, 'visit', now),
    edge('seed-browser-wcv-pool', 'seed-hub-google-rendering', 3, 'visit', now),
    edge('seed-hub-google-rendering', 'seed-browser-tls-handshake', 1, 'visit', now),
    edge('seed-hub-google-rendering', 'seed-browser-v8-pipeline', 1, 'visit', now),
    edge('seed-browser-chromium-www', 'seed-browser-chromium-mirror', 1, 'visit', now),
    edge('seed-webgpu-fluid', 'seed-webgpu-water', 2, 'visit', now),
    edge('seed-webgpu-water', 'seed-webgpu-wgsl-spa', 1, 'spawn', now),
    edge('seed-webgpu-fluid', 'seed-webgpu-f1-trace', 1, 'visit', now),
    edge('seed-webgpu-fluid', 'seed-webgpu-audio-analyser', 1, 'visit', now),
    edge('seed-webgpu-three-tsl', 'seed-webgpu-fluid', 1, 'visit', now),
    edge('seed-webgpu-f1-trace', 'seed-career-f1-api', 1, 'visit', now),
    edge('seed-career-f1-api', 'seed-career-observable-telemetry', 2, 'visit', now),
    edge('seed-career-f1-api', 'seed-career-gh-rust', 1, 'visit', now),
    edge('seed-career-observable-telemetry', 'seed-career-gh-rust', 1, 'visit', now),
    edge('seed-career-sysdesign', 'seed-career-linkedin-via-auth', 1, 'visit', now),
    edge('seed-career-resume-readcv', 'seed-career-sysdesign', 1, 'visit', now),
    edge(activeUuid, 'seed-ghost-xyflow-theming', 0, 'ghost', now),
    edge(activeUuid, 'seed-ghost-d3-force', 0, 'ghost', now),
  ]

  // Notes attach to url_hash (§7.6) — the pair note shows on BOTH duplicates.
  const dupHash = urlHashOf('https://www.chromium.org/developers/design-documents/multi-process-architecture')
  const notes: StickyNote[] = [
    note('seed-note-1', dupHash, 'Chromium: one process per site-isolation group — mirror this split in our Electron WebContentsView pool design.', 4, now),
    note('seed-note-2', urlHashOf('https://reactflow.dev/learn/performance'), 'Start here: profile with onlyRenderVisibleElements before the /seed-600 stress run.', 1, now),
    note('seed-note-3', urlHashOf('https://www.radix-ui.com/primitives'), 'Radix primitives — pill menu + palette popover candidates.', 3, now),
    note('seed-note-4', urlHashOf('https://gpuweb.github.io/gpuweb/wgsl/'), 'WGSL trail — filmstrip shows the SPA pushState path in the reader.', 2, now),
    note('seed-note-5', urlHashOf('https://api.formula1.com/v1/telemetry-docs'), 'Telemetry API rate limit — poll at 4Hz max, cache sector deltas.', 5, now),
  ]

  return { regions, nodes, edges, notes, memos: [], activeNodeUuid: activeUuid }
}

/* ------------------------------------------------------------------ */
/* §5.4 — /seed-600 stress seed: 600 nodes across 6 regions            */
/* ------------------------------------------------------------------ */

const STRESS_REGIONS: ReadonlyArray<{
  id: RegionId
  name: string
  color: string
  center: { x: number; y: number }
  topic: string
  titles: string[]
  domains: string[]
}> = [
  {
    id: 'stress-ui-systems',
    name: 'UI Systems',
    color: '#34D399',
    center: { x: -1600, y: -1600 },
    topic: 'ui systems engineering',
    titles: [
      'Design Tokens at Scale', 'Radix Primitives Deep Dive', 'Tailwind v4 Engine Internals',
      'Spring Motion Recipes', 'React Flow Performance Docs', 'Bento Grid Layout Systems',
      'Glassmorphism in Production', 'Design System Governance', 'Typography Scale Engineering',
      'Dark Mode Contrast Audits', 'Motion Design Principles', 'Accessible Component APIs',
    ],
    domains: ['rauno.me', 'emilkowal.ski', 'linear.app', 'vercel.com', 'tailwindcss.com', 'motion.dev', 'reactflow.dev', 'radix-ui.com'],
  },
  {
    id: 'stress-browser-arch',
    name: 'Browser Architecture',
    color: '#60A5FA',
    center: { x: 1600, y: -1600 },
    topic: 'browser architecture internals',
    titles: [
      'WebContentsView Pool Management', 'Chromium Multi-process Architecture', 'Servo Rust Architecture',
      'V8 Compilation Pipeline', 'TLS Handshake Diagrams', 'Electron IPC Bottlenecks',
      'Site Isolation Explained', 'Chrome OOPIF Deep Dive', 'Back/Forward Cache Internals',
      'Network Stack Throttling', 'GPU Process Sandbox', 'Navigation Throttle Chains',
    ],
    domains: ['electronjs.org', 'chromium.org', 'servo.org', 'v8.dev', 'web.dev', 'developer.mozilla.org', 'blog.chromium.org', 'cloudflare.com'],
  },
  {
    id: 'stress-webgpu-shaders',
    name: 'WebGPU & Shaders',
    color: '#22D3EE',
    center: { x: 1600, y: 1600 },
    topic: 'webgpu and shaders',
    titles: [
      'WebGPU Fluid Shaders', 'Compute Water Simulation', 'WGSL Uniform Layouts',
      'SPIR-V Cross Compilation', 'F1 Telemetry GPU Shaders', 'Particle Systems in Compute',
      'Ray Marching Primer', 'Buffer Management Patterns', 'Timestamp Query Debugging',
      'Bind Group Caching', 'Three.js TSL Nodes', 'Canvas Rendering Pipeline',
    ],
    domains: ['webgpu.dev', 'toji.dev', 'threejs.org', 'compute.toys', 'webgpureport.org', 'shadertoy.com', 'developer.mozilla.org', 'webkit.org'],
  },
  {
    id: 'stress-ai-agents',
    name: 'AI Agents',
    color: '#A78BFA',
    center: { x: -1600, y: 1600 },
    topic: 'ai agent systems',
    titles: [
      'Tool Use Patterns', 'Local Whisper Transcription', 'Embedding Models in Browser',
      'Transformers.js Caching', 'Agent Loop Architectures', 'Structured Output Schemas',
      'Vector Search at Edge', 'Prompt Chaining Playbook', 'RAG Chunking Strategies',
      'Function Calling Specs', 'MCP Server Design', 'Small Model Distillation',
    ],
    domains: ['huggingface.co', 'openai.com', 'anthropic.com', 'xenova.github.io', 'ollama.com', 'langchain.dev', 'mcp.dev', 'js.transformers.ai'],
  },
  {
    id: 'stress-f1-dataviz',
    name: 'F1 Data Viz',
    color: '#FB7185',
    center: { x: 0, y: -2900 },
    topic: 'f1 data visualisation',
    titles: [
      'F1 Telemetry API', 'Throttle Trace Brushing', 'Tyre Degradation Curves',
      'Sector Delta Heatmaps', 'Race Strategy Simulations', 'Driver Comparison Radars',
      'Live Position Streams', 'Pit Window Optimizer', 'Gap Delta Charts',
      'Weather Radar Overlays', 'Championship Permutations', 'Circuit Elevation Maps',
    ],
    domains: ['formula1.com', 'observablehq.com', 'd3js.org', 'ergast.com', 'openf1.org', 'pudding.cool', 'flowingdata.com', 'plotly.com'],
  },
  {
    id: 'stress-career-docs',
    name: 'Career & Docs',
    color: '#FDE047',
    center: { x: 0, y: 2900 },
    topic: 'career and documentation',
    titles: [
      'Spatial UI Engineer Roles', 'System Design Primer', 'Design Engineer Resumes',
      'Portfolio Teardowns', 'Interview Loop Mapping', 'Relocation Negotiation',
      'Open Source Contribution Guide', 'TypeScript Handbook Advanced', 'CSSWG Drafts Digest',
      'Remote Team Rituals', 'Compensation Benchmarks', 'Side Project Monetization',
    ],
    domains: ['linkedin.com', 'github.com', 'news.ycombinator.com', 'developer.mozilla.org', 'web.dev', 'read.cv', 'levels.fyi', 'rust-lang.org'],
  },
]

export function buildStressSeed600(now: number): SeedGraph {
  const rand = mulberry32(0x00600600)
  const regions: Region[] = STRESS_REGIONS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    color: spec.color,
    center: spec.center,
    radius: 720,
    createdAt: now,
  }))

  const nodes: SpatialTabNodeRecord[] = []
  const edges: GraphEdgeRecord[] = []

  const liveSet = new Set<NodeUuid>([
    'stress-0-2', 'stress-0-3', 'stress-0-4', 'stress-1-2', 'stress-3-2',
  ])
  const audibleUuid: NodeUuid = 'stress-0-4'

  for (let r = 0; r < STRESS_REGIONS.length; r++) {
    const spec = STRESS_REGIONS[r]
    const hubUuid = `stress-${r}-0`

    for (let i = 0; i < 100; i++) {
      const uuid = `stress-${r}-${i}`
      const isHub = i === 0
      const isAnchor = i === 1
      const isLive = liveSet.has(uuid)
      const ageDays = (i * 37 + r * 11) % 46
      const url = isHub
        ? `https://www.google.com/search?q=${encodeURIComponent(spec.topic)}`
        : `https://${spec.domains[i % spec.domains.length]}/${slugify(spec.titles[i % spec.titles.length])}${i >= 12 ? `-${i}` : ''}`
      const title = isHub
        ? `Google — ${spec.topic}`
        : spec.titles[i % spec.titles.length] + (i >= 12 ? ` — Part ${Math.floor(i / 12) + 1}` : '')

      let x: number
      let y: number
      if (isHub) {
        x = spec.center.x
        y = spec.center.y
      } else if (isAnchor) {
        x = spec.center.x
        y = spec.center.y - 170
      } else {
        const angle = rand() * Math.PI * 2
        const distance = 110 + rand() * 430
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
        ? `> Cached snapshot — ${domainOf(url)}\n\nArchived ${ageDays} days ago. Full readability capture ships with the Electron phase.`
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
      }
      nodes.push(node)

      // In-region traversal chain + hub spokes + cross-region bridges.
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

  const activeNodeUuid: NodeUuid = 'stress-0-2'

  return {
    regions,
    nodes,
    edges,
    notes: [],
    memos: [],
    activeNodeUuid,
  }
}
