/**
 * app/src/components/viewport/MockWebReader.tsx — Mode A: the full-bleed
 * simulated webpage viewport (SPEC §3) and the §5.1 live link-spawning
 * testbed. Everything on the page is mocked but functional:
 *
 *   • deterministic article/hero generation per node (url-hash driven), with
 *     curated pages for the seeded vocabulary (React Flow performance docs,
 *     WebGPU Fluid Shaders, Rust Servo Architecture, F1 Telemetry API, …)
 *   • outbound links (§5.1): normal click → `onNavigate` (navigate the active
 *     node in place), Cmd/Ctrl+Click or the visible "Branch Node" button →
 *     `onBranch` (spawn child satellite + directional spawn edge), and every
 *     link is draggable with `SPATIAL_DRAG_MIME` + a JSON `SpatialDragPayload`
 *     for the pill drop zone (§6 drag-to-anchor)
 *   • google.com hub nodes render as a search-hub SERP (§7.1) whose results
 *     carry the `searchQuery` tag; oauth/payment nodes show a "via auth" chip
 *     (§7.2); `noCapture` nodes render a blur-glass private page (§7.4);
 *     dead links surface the cached Readability excerpt (§7.5)
 *   • SPA-style pages (§7.3) render an "on this page" section nav that fires
 *     `onSubNavigate` (the mock did-navigate-in-page path — App wires it to
 *     `pushSubPage`) and shows the recorded pushState trail as chips
 *   • SoundCloud-style media bar (§5.3): play/pause toggles the store's
 *     `isAudible` immunity flag; audible tabs are never auto-hibernated
 *   • sticky rail (§7.6): quick capture affordance for Alt+N (the keyboard
 *     shortcut itself is wired globally in App), inline editing, and notes
 *     attached to the node's `url_hash`
 *
 * Design language: SPEC §2 dark tactical glass, framer-motion springs
 * (stiffness 380 / damping 30), lucide-react icons, clsx + tailwind-merge.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, MouseEvent, ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowUpRight,
  AudioLines,
  Clock,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Ghost,
  GripVertical,
  History,
  LoaderCircle,
  Lock,
  Pause,
  Play,
  Plus,
  Search,
  StickyNote,
  X,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { clsx } from 'clsx'
import type { ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { fnv1a32 } from '../../lib/embed'
import { SPATIAL_DRAG_MIME, domainOf, formatDurationMs, urlHashOf } from '../../lib/types'
import type {
  MockLinkTarget,
  MockWebReaderProps,
  SpatialDragPayload,
  SpatialTabNodeRecord,
  StickyNote as StickyNoteRecord,
  SubPageRef,
} from '../../lib/types'
import { selectNotesForNode, useGraphStore } from '../../store/useGraphStore'

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** SPEC §2 motion language — spring physics everywhere, no linear easing. */
const SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

/** Tiny deterministic PRNG (mulberry32) — same shape as the seed builder. */
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
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/'
  } catch {
    return url.replace(/^[a-z]+:\/\//i, '')
  }
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const STAMP_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function formatDate(ms: number): string {
  try {
    return DATE_FORMAT.format(new Date(ms))
  } catch {
    return '—'
  }
}

function formatStamp(ms: number): string {
  try {
    return STAMP_FORMAT.format(new Date(ms))
  } catch {
    return '—'
  }
}

/* ------------------------------------------------------------------ */
/* §5.1 — outbound link catalog                                        */
/* ------------------------------------------------------------------ */

/** The named §5.1 testbed targets plus the rest of the seeded vocabulary. */
const L = {
  webgpuFluid: { url: 'https://webgpu.dev/fluid-playground', title: 'WebGPU Fluid Shaders' },
  rfPerformance: { url: 'https://reactflow.dev/learn/performance', title: 'React Flow Performance Docs' },
  f1Telemetry: { url: 'https://api.formula1.com/v1/telemetry-docs', title: 'F1 Telemetry API' },
  servoArch: { url: 'https://servo.org/blog/servo-architecture/', title: 'Rust Servo Architecture' },
  wgslRef: { url: 'https://gpuweb.github.io/gpuweb/wgsl/', title: 'WGSL — Language Reference' },
  computeToys: { url: 'https://compute.toys/view/42-water-sim', title: 'Compute.Toys — Water Simulation' },
  f1Trace: { url: 'https://www.shadertoy.com/view/f1-telemetry-trace', title: 'F1 Telemetry — GPU Trace Shaders' },
  webAudio: { url: 'https://webaudio.github.io/web-audio-api/', title: 'Web Audio — Analyser Visualizers' },
  threeTsl: { url: 'https://threejs.org/manual/#en/tsl', title: 'Three.js — TSL Node Materials' },
  chromiumMulti: { url: 'https://www.chromium.org/developers/design-documents/multi-process-architecture', title: 'Chromium — Multi-process Architecture' },
  v8Cost: { url: 'https://v8.dev/blog/cost-of-javascript', title: 'V8 — The Cost of JavaScript & Compilation Pipeline' },
  electronWcv: { url: 'https://www.electronjs.org/docs/latest/api/web-contents-view', title: 'Electron — WebContentsView Pool Management' },
  cloudflareTls: { url: 'https://www.cloudflare.com/learning/ssl/what-happens-in-a-tls-handshake/', title: 'What Happens in a TLS Handshake' },
  observable: { url: 'https://observablehq.com/@d3/telemetry-brushing', title: 'Observable — Telemetry Brushing & D3' },
  sysdesign: { url: 'https://github.com/donnemartin/system-design-primer', title: 'System Design Primer — GitHub' },
  ghRust: { url: 'https://github.com/topics/rust', title: 'GitHub — Rust Topic' },
  radix: { url: 'https://www.radix-ui.com/primitives', title: 'Radix Primitives — Accessible Component APIs' },
  tailwindV4: { url: 'https://tailwindcss.com/blog/tailwindcss-v4', title: 'Tailwind CSS v4 — Engine Internals' },
  motionSprings: { url: 'https://motion.dev/docs/react-springs', title: 'Framer Motion — Spring Physics Recipes' },
  linearMethod: { url: 'https://linear.app/method', title: 'Linear Method — Building Quality Software' },
  kinopio: { url: 'https://kinopio.club', title: 'Kinopio — Spatial Thinking Notes' },
  readcv: { url: 'https://read.cv/guides/design-engineer-resume', title: 'read.cv — Design Engineer Resume Guide' },
} satisfies Record<string, MockLinkTarget>

/** Generic pool for uncurated domains (the 600-node stress seed). */
const GENERIC_LINK_POOL: readonly MockLinkTarget[] = [
  { url: 'https://web.dev/articles/rendering-performance', title: 'Rendering Performance — web.dev' },
  { url: 'https://developer.mozilla.org/en-US/docs/WebAssembly', title: 'WebAssembly — MDN' },
  { url: 'https://webgpu.github.io/webgpu-samples', title: 'WebGPU Samples' },
  { url: 'https://react.dev/learn', title: 'React Docs — Learn React' },
  { url: 'https://caniuse.com/webgpu', title: 'Can I Use — WebGPU Support' },
  { url: 'https://rauno.me/craft', title: 'Craft — Interaction Design Details' },
  { url: 'https://httparchive.org/reports', title: 'HTTP Archive — Web Almanac' },
  { url: 'https://huggingface.co/docs/transformers.js', title: 'Transformers.js — Browser Embeddings' },
  { url: 'https://openf1.org', title: 'OpenF1 — Live Telemetry Streams' },
  { url: 'https://pudding.cool', title: 'The Pudding — Visual Essays' },
  { url: 'https://www.typescriptlang.org/docs/handbook/intro', title: 'TypeScript Handbook' },
  { url: 'https://html.spec.whatwg.org/multipage/', title: 'HTML Living Standard' },
  { url: 'https://www.w3.org/WAI/ARIA/apg', title: 'ARIA Authoring Practices Guide' },
  { url: 'https://sqlite.org/whentouse.html', title: 'SQLite — When to Use' },
]

/** Curated outbound sets keyed by the display domain (`domainOf` output). */
const PAGE_LINKS: Record<string, readonly MockLinkTarget[]> = {
  'reactflow.dev': [L.webgpuFluid, L.f1Telemetry, L.servoArch, L.wgslRef, L.tailwindV4, L.motionSprings, L.sysdesign],
  'webgpu.dev': [L.wgslRef, L.computeToys, L.f1Trace, L.webAudio, L.threeTsl, L.rfPerformance],
  'gpuweb.github.io': [L.webgpuFluid, L.computeToys, L.threeTsl, L.f1Trace],
  'servo.org': [L.chromiumMulti, L.v8Cost, L.electronWcv, L.ghRust, L.cloudflareTls, L.rfPerformance],
  'api.formula1.com': [L.f1Trace, L.observable, L.cloudflareTls, L.sysdesign],
  'shadertoy.com': [L.webgpuFluid, L.wgslRef, L.threeTsl, L.computeToys],
  'compute.toys': [L.webgpuFluid, L.wgslRef, L.threeTsl, L.webAudio],
  'threejs.org': [L.webgpuFluid, L.wgslRef, L.computeToys, L.webAudio],
  'webaudio.github.io': [L.webgpuFluid, L.computeToys, L.rfPerformance, L.threeTsl],
  'v8.dev': [L.servoArch, L.chromiumMulti, L.cloudflareTls, L.electronWcv],
  'chromium.org': [L.servoArch, L.v8Cost, L.electronWcv, L.cloudflareTls],
  'electronjs.org': [L.chromiumMulti, L.servoArch, L.v8Cost, L.rfPerformance],
  'cloudflare.com': [L.chromiumMulti, L.v8Cost, L.servoArch, L.electronWcv],
  'observablehq.com': [L.f1Telemetry, L.f1Trace, L.sysdesign, L.rfPerformance],
  'github.com': [L.servoArch, L.ghRust, L.sysdesign, L.readcv],
  'radix-ui.com': [L.tailwindV4, L.motionSprings, L.rfPerformance, L.kinopio],
  'tailwindcss.com': [L.radix, L.motionSprings, L.rfPerformance, L.linearMethod],
  'motion.dev': [L.rfPerformance, L.tailwindV4, L.radix, L.kinopio],
  'linear.app': [L.radix, L.motionSprings, L.readcv, L.kinopio],
  'kinopio.club': [L.rfPerformance, L.linearMethod, L.radix, L.motionSprings],
  'read.cv': [L.sysdesign, L.linearMethod, L.ghRust, L.radix],
  'google.com': [L.chromiumMulti, L.servoArch, L.v8Cost, L.electronWcv, L.cloudflareTls, L.rfPerformance],
  'developer.mozilla.org': [L.wgslRef, L.webAudio, L.rfPerformance, L.cloudflareTls],
}

function poolLinksFor(hash: number): MockLinkTarget[] {
  const start = hash % GENERIC_LINK_POOL.length
  const count = 5 + (hash % 2)
  return Array.from({ length: count }, (_, index) => GENERIC_LINK_POOL[(start + index) % GENERIC_LINK_POOL.length])
}

const BLURBS: readonly string[] = [
  'Deep dive with benchmarks and frame traces.',
  'Reference implementation and engineering notes.',
  'Design notes straight from the field.',
  'Spec discussion with the open questions left in.',
  'Playground with live, editable samples.',
  'Long-form teardown with real measurements.',
  'Curated examples and copy-paste recipes.',
  'Docs — quickstart through advanced patterns.',
  'Issue thread with profiling data attached.',
  'Talk transcript and slides.',
]

const blurbFor = (target: MockLinkTarget): string => BLURBS[fnv1a32(target.url) % BLURBS.length]

/* ------------------------------------------------------------------ */
/* Page generation (deterministic per node)                            */
/* ------------------------------------------------------------------ */

type Topic = 'gpu' | 'browser' | 'data' | 'ui' | 'ai' | 'general'

const TOPIC_LABELS: Record<Topic, string> = {
  gpu: 'GPU RENDERING',
  browser: 'BROWSER ENGINEERING',
  data: 'DATA VIZ & TELEMETRY',
  ui: 'INTERFACE ENGINEERING',
  ai: 'LOCAL AI SYSTEMS',
  general: 'FIELD NOTES',
}

function classifyTopic(node: SpatialTabNodeRecord): Topic {
  const text = [node.title, node.domain, ...node.keywords].join(' ').toLowerCase()
  if (/webgpu|wgsl|shader|compute|gpu|glsl|three|render/.test(text)) return 'gpu'
  if (/f1|formula|telemetry|heatmap|tyre|racing|d3|chart/.test(text)) return 'data'
  if (/react|tailwind|css|radix|design|typography|motion|canvas|flow|component|layout|ui\b/.test(text)) return 'ui'
  if (/servo|chromium|electron|v8|javascript|tls|browser|engine|process|network|rust/.test(text)) return 'browser'
  if (/agent|model|embedding|whisper|transformer|llm|mcp|rag|inference|vector/.test(text)) return 'ai'
  return 'general'
}

/**
 * Paragraph segments: plain text, or a numeric index into the page's resolved
 * outbound links (rendered as inline §5.1 links; indexes beyond the list are
 * dropped so every topic's prose works against any link count).
 */
type Seg = string | number
type Para = Seg[]
type Section = { id: string; heading: string; paras: Para[]; list?: string[] }
type TopicProse = {
  deks: string[]
  sections: Section[]
  quote: string
  code: { lang: string; code: string }
}

const PROSE: Record<Topic, TopicProse> = {
  gpu: {
    deks: [
      'A 120fps compute-shader playground, and what the frame graph taught us about bind-group caching.',
      'Packing a fluid solver into two storage textures without ever leaving GPU memory.',
    ],
    sections: [
      {
        id: 'the-compute-pass',
        heading: 'The compute pass',
        paras: [
          [
            'The solver runs as a fixed 16×16 workgroup, ping-ponging two storage textures so the field never leaves GPU memory. On the integrated GPUs we test against, a 512² simulation holds 120fps with headroom to spare for advection. ',
            0,
            ' is the cleanest end-to-end reference we found while wiring this up.',
          ],
          [
            'Bind groups are cached per frame — recreating them mid-playback cost us 2.3ms a frame. ',
            1,
            ' nails the uniform alignment rules: pack particle structs to 16 bytes and the compiler emits vectorized loads instead of four scattered fetches.',
          ],
        ],
        list: ['16×16 workgroups, 2 storage textures, 0 readbacks', 'Timestamp ring flushed once per frame', 'Bind groups cached; layout compiled once', 'Advection unrolled by hand for the hot path'],
      },
      {
        id: 'timings-and-timestamps',
        heading: 'Timings & timestamps',
        paras: [
          [
            'We keep a timestamp-query ring around every pass, so regressions show up as a flamegraph before they show up as jank. ',
            2,
            ' pushed us to store trace channels in a float texture and decode them in the vertex stage — one draw call for the whole overlay.',
          ],
        ],
      },
      {
        id: 'sound-follows-sim',
        heading: 'Sound follows sim',
        paras: [
          [
            'The audio analyser consumes the same pressure field, so the waveform you hear is the simulation you watch. ',
            3,
            ' keeps it honest — analyser nodes are cheap, mixing them mid-graph is not.',
          ],
        ],
      },
    ],
    quote: '“If you have to read back a texture to know it worked, you already missed the frame.”',
    code: {
      lang: 'wgsl',
      code: [
        '@group(0) @binding(0) var fieldA : texture_storage_2d<r32float, write>;',
        '@group(0) @binding(1) var fieldB : texture_storage_2d<r32float, read>;',
        '',
        '@compute @workgroup_size(16, 16)',
        'fn advect(@builtin(global_invocation_id) gid : vec3u) {',
        '  let uv = vec2f(gid.xy) / vec2f(params.dims);',
        '  let vel = sampleVelocity(uv) * params.dt;',
        '  let src = fieldB.load(gid.xy - vec2u(vel * params.dims));',
        '  fieldA.store(gid.xy, src * params.dissolve);',
        '}',
      ].join('\n'),
    },
  },
  browser: {
    deks: [
      'One process per site-isolation group, and why our tab pool thinks like a scheduler.',
      'What a renderer crash looks like from the outside — and why the graph should never feel it.',
    ],
    sections: [
      {
        id: 'process-topology',
        heading: 'Process topology',
        paras: [
          [
            'Each renderer owns its own compositor while the GPU process owns the swapchain. When a tab crashes, the pool swaps the WebContentsView in under 40ms and the spatial graph simply marks the node loading. ',
            0,
            ' remains the canonical walkthrough of the split.',
          ],
          [
            'Site isolation buys crash containment at the cost of memory — every extra process is a flat fee. ',
            1,
            ' breaks down where the bytes actually go: V8 heaps dominate, compositor surfaces are cheap, the rest is bookkeeping.',
          ],
        ],
        list: ['Renderer crash → view swap ≤ 40ms', 'Redirect chains < 3s collapse into one node', 'Audible tabs exempt from eviction sweeps', 'Pinned anchors keep fx/fy across sessions'],
      },
      {
        id: 'handshakes-and-cold-starts',
        heading: 'Handshakes & cold starts',
        paras: [
          [
            'A cold navigation is a TLS handshake, a redirect chain, then first paint — under three seconds it collapses into one node with a via-auth tag. ',
            2,
            ' documents the pool hooks that make the collapse observable.',
          ],
        ],
      },
      {
        id: 'the-engine-room',
        heading: 'The engine room',
        paras: [
          [
            'Rust made the layout engine boring in the best way: the borrow checker turns most renderer races into compile errors. ',
            3,
            ' is worth a slow read if you ship anything multi-process.',
          ],
        ],
      },
    ],
    quote: '“A tab you can’t kill cleanly is a tab that will take the pool down with it.”',
    code: {
      lang: 'rust',
      code: [
        'impl TabPool {',
        '    fn admit(&mut self, view: WebContentsView) -> Option<Uuid> {',
        '        if self.views.len() >= self.limit {',
        '            let lru = self.views.iter().min_by_key(|v| v.last_visited())?;',
        '            if lru.is_audible() || lru.is_pinned() { return None }',
        '            self.hibernate(lru.uuid());',
        '        }',
        '        self.views.push(view).map(|v| v.uuid())',
        '    }',
        '}',
      ].join('\n'),
    },
  },
  data: {
    deks: [
      'Telemetry at 4Hz per channel: decimate the drawing, never the socket.',
      'Sector deltas, rolling best laps, and a heatmap that survives a 300-lap race.',
    ],
    sections: [
      {
        id: 'rate-limits-and-decimation',
        heading: 'Rate limits & decimation',
        paras: [
          [
            'Telemetry arrives at 4Hz per channel — throttle, brake, DRS — so the visualisation layer decimates instead of the socket. ',
            0,
            ' documents the payload shape; everything below the fold is derived.',
          ],
          [
            'Sector deltas are computed against the rolling best lap, then brushed onto the heatmap. ',
            1,
            ' is the notebook we lifted the brushing math from — d3 handles the scale juggling once you feed it the right frame.',
          ],
        ],
        list: ['Throttle/brake traces at 4Hz, GPS at 20Hz', 'Delta-to-best computed per sector gate', 'Heatmap decimated to 60 points per lap', 'Weather radar overlaid last, alpha-blended'],
      },
      {
        id: 'the-tyre-cliff',
        heading: 'The tyre cliff',
        paras: [
          [
            'Degradation curves lie until you normalise for fuel load. The cliff arrives two laps earlier than the stint model predicts, every race — which is why the pit-window optimizer exists at all. ',
            2,
            ' carries the race-strategy writeup.',
          ],
        ],
      },
      {
        id: 'shader-side-viz',
        heading: 'Shader-side viz',
        paras: [
          [
            'When a chart grows past a few thousand points it stops being a chart and becomes a renderer problem. ',
            3,
            ' renders the trace as GPU geometry, and the frame budget stops caring about point counts.',
          ],
        ],
      },
    ],
    quote: '“Every chart is a cache of a computation you didn’t want to repeat on scroll.”',
    code: {
      lang: 'ts',
      code: [
        'const decimate = (points: TelemetrySample[], perLap: number) => {',
        '  const stride = Math.max(1, Math.floor(points.length / perLap))',
        '  return points.filter((p, i) => i % stride === 0 || p.brake > 0.9 || p.drs)',
        '}',
      ].join('\n'),
    },
  },
  ui: {
    deks: [
      'Semantic zoom is a rendering problem before it is an interaction problem.',
      'Six node states, three LODs, one layout engine that never moves a node you placed.',
    ],
    sections: [
      {
        id: 'level-of-detail',
        heading: 'Level of detail',
        paras: [
          [
            'At macro level a node is a 24px beacon; only above 0.65 zoom does the full 260px card mount. ',
            0,
            ' documents the culling flags that keep 600 nodes at 120fps — the win is unmounting, not painting.',
          ],
          [
            'Pinned anchors lock fx/fy so the force layout can never drift them, and satellites spawn on the golden angle before settling once. ',
            1,
            ' explains the spring contract — stiffness 380, damping 30, and nothing linear anywhere.',
          ],
        ],
        list: ['Macro: beacons + region titles', 'Compact: 180×44 pills', 'Rich: 260px cards with hover actions', '600 nodes, one shared layout solver'],
      },
      {
        id: 'state-all-six-of-them',
        heading: 'State — all six of them',
        paras: [
          [
            'The card surface encodes each state without text: an emerald ring for live, frost for hibernated, dashed violet for the predicted tab, amber fold for notes. ',
            2,
            ' is the pattern library we borrowed the discipline from.',
          ],
        ],
      },
      {
        id: 'glass-but-legible',
        heading: 'Glass, but legible',
        paras: [
          [
            'Dark glass fails when contrast is an afterthought: every surface gets a hairline at 8% white and primary text never drops below 92% opacity. ',
            3,
            ' remains the best writeup we know on quality under constraints.',
          ],
        ],
      },
    ],
    quote: '“If a hover state needs a tooltip to explain itself, the state is wrong.”',
    code: {
      lang: 'tsx',
      code: [
        "const lod = zoom < 0.35 ? 'macro' : zoom < 0.65 ? 'compact' : 'rich'",
        '',
        'return lod === "macro"',
        '  ? <Beacon node={node} color={region.color} />',
        '  : <SpatialCard node={node} lod={lod} />',
      ].join('\n'),
    },
  },
  ai: {
    deks: [
      'Ghost echoes come from embeddings you can run in the tab — no server round trip.',
      'A 384-dim bag of words is enough to predict which tab you were about to need.',
    ],
    sections: [
      {
        id: 'embeddings-the-cheap-way',
        heading: 'Embeddings, the cheap way',
        paras: [
          [
            'The embedder hashes tokens into 384 dims — deterministic, synchronous, memoized. Ghost scoring weighs cosine at 0.55, co-visitation at 0.30, recency at 0.15, so a tab you keep returning to haunts you even with zero keyword overlap. ',
            0,
            ' is the swap point for a real MiniLM in the next phase.',
          ],
          ['Suppression matters as much as suggestion: a dismissed echo never returns this session, and ignored ghosts dissolve on the next context switch.'],
        ],
        list: ['Cosine ≥ 0.55 weight → candidate ghosts', 'Co-visitation window: 10 seconds, edge weight +1', 'Max 3 ghost suggestions per active node', 'Threshold 0.78 — below it, silence beats noise'],
      },
      {
        id: 'the-agent-loop',
        heading: 'The agent loop',
        paras: [
          [
            'Structured outputs beat prompt poetry. Keep the loop boring: plan, call, verify, retry once, then surface the failure with the raw payload attached. ',
            1,
            ' covers the function-calling contract end to end.',
          ],
        ],
      },
      {
        id: 'local-first',
        heading: 'Local-first',
        paras: [
          [
            'Everything runs in-tab: the index lives in localStorage, the audio in data URLs, and the model swap sits behind an interface. ',
            2,
            ' keeps the whole pipeline offline-first.',
          ],
        ],
      },
    ],
    quote: '“A prediction you can’t dismiss is just an interruption with better marketing.”',
    code: {
      lang: 'ts',
      code: ['const relevance = 0.55 * cosine + 0.3 * coVisit + 0.15 * recency', 'if (relevance >= 0.78) ghosts.push({ node, relevance })'].join('\n'),
    },
  },
  general: {
    deks: [
      'Field notes from shipping a spatial tool — links, measurements, and the parts that surprised us.',
      'A working writeup with the traces, footnotes, and dead ends left in.',
    ],
    sections: [
      {
        id: 'where-this-fits',
        heading: 'Where this fits',
        paras: [
          [
            'This page sits in a spatial graph next to everything you opened around it. ',
            0,
            ' is where the trail usually continues, and the pill above shows the nearest neighbours as dots.',
          ],
        ],
      },
      {
        id: 'measurements',
        heading: 'Measurements',
        paras: [
          [
            'We keep one rule: a number without a trace is a rumor. Every claim below was reproduced three times on the same hardware before it earned a paragraph. ',
            1,
            ' carries the raw run logs.',
          ],
        ],
        list: ['Frame budget: 8.3ms at 120Hz — measured, not hoped', 'Cold nav collapses under 3s into one node', 'Cache hits served from the text snapshot', 'Nothing moved behind your back — anchors persist'],
      },
      {
        id: 'the-parts-that-surprised-us',
        heading: 'The parts that surprised us',
        paras: [
          [
            'The mundane things aged best: stable sort orders, deterministic ids, and a single source of truth for the active node. ',
            2,
            ' convinced us to keep the data model boring.',
          ],
        ],
      },
    ],
    quote: '“Determinism is a feature you only notice when it’s missing.”',
    code: {
      lang: 'ts',
      code: [
        'const urlHash = `u${fnv1a32(canonicalizeUrl(url)).toString(16).padStart(8, "0")}`',
        '// duplicate URLs collapse onto one identity — notes ride along (§7.6)',
      ].join('\n'),
    },
  },
}

const AUTHORS: readonly string[] = [
  'Ada Quinn',
  'Miles Okafor',
  'Sana Petrov',
  'Theo Marchetti',
  'June Nakamura',
  'Ravi Anand',
  'Lena Fischer',
  'Cato Bergström',
]

const ARTISTS: readonly string[] = ['Nocturne Oscillator', 'Gridline', 'Sub-Proto', 'Aerolithe', 'Cassette Merchants', 'Bitym']

const SPA_DOMAINS: ReadonlySet<string> = new Set(['gpuweb.github.io', 'reactflow.dev', 'web.dev', 'developer.mozilla.org', 'threejs.org'])

const CURATED_SPA_SECTIONS: Record<string, ReadonlyArray<{ slug: string; label: string }>> = {
  'gpuweb.github.io': [
    { slug: 'types', label: 'Types' },
    { slug: 'uniforms', label: 'Uniform & Storage Buffers' },
    { slug: 'execution-modes', label: 'Execution Modes' },
    { slug: 'constants', label: 'Constants & Literals' },
  ],
  'reactflow.dev': [
    { slug: 'theming', label: 'Theming & Styling' },
    { slug: 'layouting', label: 'Layouting' },
    { slug: 'culling', label: 'Viewport Culling' },
  ],
  'developer.mozilla.org': [
    { slug: 'syntax', label: 'Syntax' },
    { slug: 'examples', label: 'Examples' },
    { slug: 'specifications', label: 'Specifications' },
  ],
  'threejs.org': [
    { slug: 'nodes', label: 'Node Materials' },
    { slug: 'layouts', label: 'Uniform Layouts' },
    { slug: 'faq', label: 'FAQ' },
  ],
  'web.dev': [
    { slug: 'rendering', label: 'Rendering' },
    { slug: 'measure', label: 'Measuring' },
    { slug: 'checklist', label: 'Checklist' },
  ],
}

type SpaSection = { slug: string; label: string }

type PageModel = {
  hash: number
  hue: number
  accent: string
  bg: string
  pattern: 'wave' | 'grid' | 'bars'
  heroBars: number[]
  wavePath: string
  topic: Topic
  topicLabel: string
  dek: string
  author: string
  dateLabel: string
  readMinutes: number
  sections: Section[]
  quote: string
  code: { lang: string; code: string }
  links: MockLinkTarget[]
  isSpa: boolean
  isHub: boolean
  hubQuery: string
  spaSections: ReadonlyArray<SpaSection>
  relatedSearches: MockLinkTarget[]
}

/**
 * Builds the whole mock page from the node record — deterministic given the
 * node, so re-renders and remounts never reshuffle content.
 */
function buildPage(node: SpatialTabNodeRecord): PageModel {
  const hash = fnv1a32(node.url)
  const hue = hash % 360
  const rand = mulberry32(hash ^ 0x9e3779b9)
  const topic = classifyTopic(node)
  const prose = PROSE[topic]

  // Outbound links: curated set per domain, hash-picked pool otherwise, with
  // self-links removed so no page links to itself (§7.6 identity).
  const curated = PAGE_LINKS[node.domain]
  const links = (curated ?? poolLinksFor(hash)).filter((target) => urlHashOf(target.url) !== node.urlHash)

  // Hub SERP (§7.1): results carry the searchQuery tag on navigation.
  const isHub = node.nodeType === 'hub' || node.domain === 'google.com'
  const derivedQuery = node.title.replace(/^Google\s*—\s*/i, '').trim() || 'developer search'
  const hubQuery = node.searchQuery ?? derivedQuery
  const hubLinks = isHub ? links.map((target) => ({ ...target, searchQuery: hubQuery })) : links

  // SPA section nav (§7.3): curated per domain, keyword-derived otherwise.
  const isSpa = SPA_DOMAINS.has(node.domain)
  let spaSections: ReadonlyArray<SpaSection> = []
  if (isSpa) {
    const curatedSpa = CURATED_SPA_SECTIONS[node.domain]
    spaSections =
      curatedSpa ??
      node.keywords.slice(0, 3).map((keyword) => ({ slug: slugify(keyword), label: keyword.replace(/^\w/, (c) => c.toUpperCase()) }))
  }

  // §7.3 appendix — real scroll targets for the SPA section nav and the
  // recorded pushState trail chips (`data-sec` = slug, e.g. #types).
  const sections: Section[] =
    isSpa && spaSections.length > 0
      ? [
          ...prose.sections,
          ...spaSections.map((spaSection) => ({
            id: spaSection.slug,
            heading: spaSection.label,
            paras: [
              [
                `${spaSection.label} completes the ${TOPIC_LABELS[topic].toLowerCase()} reference on this page. The in-domain trail records it as #${spaSection.slug}, so the reader, the pushState chips and the node filmstrip all point at the same anchor.`,
              ] as Para,
            ],
          })),
        ]
      : prose.sections

  const heroBars = Array.from({ length: 24 }, () => 0.22 + rand() * 0.78)
  const wavePoints = Array.from({ length: 13 }, (_, index) => {
    const x = (index / 12) * 960
    const y = 60 + Math.sin(index * 1.7 + (hash % 7)) * (24 + rand() * 26)
    return `${index === 0 ? 'M' : 'L'}${Math.round(x)},${Math.round(y)}`
  })

  const relatedStart = (hash + 4) % GENERIC_LINK_POOL.length
  const relatedSearches: MockLinkTarget[] = Array.from({ length: 4 }, (_, index) => {
    const base = GENERIC_LINK_POOL[(relatedStart + index) % GENERIC_LINK_POOL.length]
    return isHub ? { ...base, searchQuery: hubQuery } : { ...base }
  })

  return {
    hash,
    hue,
    accent: `hsl(${hue} 68% 62%)`,
    bg: `radial-gradient(140% 110% at 50% 0%, hsl(${hue} 40% 9%) 0%, #0a0b0e 58%, #090a0c 100%)`,
    pattern: (['wave', 'grid', 'bars'] as const)[hash % 3],
    heroBars,
    wavePath: wavePoints.join(' '),
    topic,
    topicLabel: TOPIC_LABELS[topic],
    dek: prose.deks[hash % prose.deks.length],
    author: AUTHORS[hash % AUTHORS.length],
    dateLabel: formatDate(node.createdAt),
    readMinutes: 4 + (hash % 9),
    sections,
    quote: prose.quote,
    code: prose.code,
    links: hubLinks,
    isSpa,
    isHub,
    hubQuery,
    spaSections,
    relatedSearches,
  }
}

/* ------------------------------------------------------------------ */
/* §6 drag-to-anchor — SPATIAL_DRAG_MIME payload contract              */
/* ------------------------------------------------------------------ */

function writeSpatialDragData(event: DragEvent<HTMLAnchorElement>, target: MockLinkTarget): void {
  const payload: SpatialDragPayload = {
    url: target.url,
    title: target.title,
    ...(target.searchQuery ? { searchQuery: target.searchQuery } : {}),
  }
  event.dataTransfer.setData(SPATIAL_DRAG_MIME, JSON.stringify(payload))
  event.dataTransfer.setData('text/plain', `${target.title} — ${target.url}`)
  event.dataTransfer.effectAllowed = 'copy'
}

/* ------------------------------------------------------------------ */
/* Shared link pieces                                                  */
/* ------------------------------------------------------------------ */

type LinkHandlers = {
  onNavigate: (target: MockLinkTarget) => void
  onBranch: (target: MockLinkTarget) => void
}

function handleLinkActivate(event: MouseEvent<HTMLAnchorElement>, target: MockLinkTarget, handlers: LinkHandlers): void {
  event.preventDefault()
  if (event.metaKey || event.ctrlKey) handlers.onBranch(target)
  else handlers.onNavigate(target)
}

function handleLinkDragStart(event: DragEvent<HTMLAnchorElement>, target: MockLinkTarget): void {
  writeSpatialDragData(event, target)
}

/** Tiny hover-reveal branch affordance shown next to every outbound link. */
function BranchButton({ target, onBranch, className }: { target: MockLinkTarget; onBranch: (target: MockLinkTarget) => void; className?: string }) {
  return (
    <button
      type="button"
      title={`Branch node → ${target.title}`}
      aria-label={`Branch node → ${target.title}`}
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-hairline bg-white/[0.04] text-white/50',
        'transition-colors hover:border-accent/50 hover:text-accent',
        className,
      )}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onBranch(target)
      }}
    >
      <GitBranch className="size-3" strokeWidth={1.75} />
    </button>
  )
}

/** Inline prose link: normal click navigates in place, ⌘/Ctrl+Click branches. */
function InlineLink({ target, handlers }: { target: MockLinkTarget; handlers: LinkHandlers }) {
  return (
    <span className="group/inline inline-flex items-baseline gap-1">
      <a
        href={target.url}
        draggable
        onClick={(event) => handleLinkActivate(event, target, handlers)}
        onDragStart={(event) => handleLinkDragStart(event, target)}
        className="cursor-pointer font-medium underline decoration-dotted decoration-from-font underline-offset-2 transition-[text-shadow] hover:[text-shadow:0_0_12px_var(--page-accent)]"
        style={{ color: 'var(--page-accent)' }}
      >
        {target.title}
      </a>
      <BranchButton target={target} onBranch={handlers.onBranch} className="size-4 self-center opacity-0 group-hover/inline:opacity-100" />
    </span>
  )
}

/** "Linked from this page" card: draggable pill-drop seed with branch action. */
function LinkCard({ target, handlers }: { target: MockLinkTarget; handlers: LinkHandlers }) {
  return (
    <div className="group relative flex gap-2 rounded-xl border border-hairline bg-surface-glass p-3 backdrop-blur-md transition-colors hover:border-white/20 hover:bg-white/[0.05]">
      <a
        href={target.url}
        draggable
        onClick={(event) => handleLinkActivate(event, target, handlers)}
        onDragStart={(event) => handleLinkDragStart(event, target)}
        className="flex min-w-0 flex-1 cursor-grab flex-col gap-1 active:cursor-grabbing"
      >
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: `hsl(${fnv1a32(target.url) % 360} 68% 62%)` }} />
          <span className="truncate font-mono text-[10px] tracking-tight text-white/45">{domainOf(target.url)}</span>
          <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-white/35 transition-colors group-hover:text-white/75" strokeWidth={1.75} />
        </span>
        <span className="text-[13px] leading-snug text-white/90">{target.title}</span>
        <span className="truncate text-[11px] text-white/45">{blurbFor(target)}</span>
        {target.searchQuery ? (
          <span className="mt-0.5 w-fit rounded-md bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent">“{target.searchQuery}”</span>
        ) : null}
      </a>
      <span className="flex flex-col items-center gap-1">
        <BranchButton target={target} onBranch={handlers.onBranch} className="opacity-0 group-hover:opacity-100" />
        <GripVertical className="size-3.5 text-white/20 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={1.75} />
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Reader chrome: chips, banners, hero                                 */
/* ------------------------------------------------------------------ */

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded border border-hairline bg-white/[0.05] px-1 font-mono text-[9px] text-white/60">{children}</kbd>
}

function HeaderChip({ tone, icon, children }: { tone: 'amber' | 'accent' | 'violet'; icon?: ReactNode; children: ReactNode }) {
  const tones = {
    amber: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
    accent: 'border-accent/30 bg-accent/10 text-accent',
    violet: 'border-ghost/40 bg-ghost/10 text-ghost',
  } as const
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] tracking-tight', tones[tone])}>
      {icon}
      {children}
    </span>
  )
}

function StateBanner({ node }: { node: SpatialTabNodeRecord }) {
  if (node.nodeType === 'ghost-echo') {
    return (
      <div className="mb-6 flex items-center gap-3 rounded-xl border border-dashed border-ghost/50 bg-ghost/10 px-4 py-3">
        <Ghost className="size-4 shrink-0 text-ghost" strokeWidth={1.75} />
        <div className="min-w-0">
          <p className="font-mono text-[11px] tracking-tight text-ghost">GHOST ECHO · {Math.round((node.ghostMatch ?? 0.8) * 100)}% MATCH</p>
          <p className="mt-0.5 truncate text-[12px] text-white/60">Predicted resurfacing — wake the node to read it for real.</p>
        </div>
      </div>
    )
  }
  if (node.ramState === 'hibernated') {
    return (
      <div className="mb-6 flex items-center gap-3 rounded-xl border border-hairline bg-white/[0.03] px-4 py-3">
        <Clock className="size-4 shrink-0 text-white/40" strokeWidth={1.75} />
        <p className="font-mono text-[11px] tracking-tight text-white/50">SLEEP · 0 MB — showing the archived snapshot below</p>
      </div>
    )
  }
  return null
}

function HeroBand({ node, page }: { node: SpatialTabNodeRecord; page: PageModel }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.985 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={SPRING}
      className="relative mt-6 h-44 overflow-hidden rounded-2xl border border-hairline"
      style={{ background: `linear-gradient(135deg, hsl(${page.hue} 45% 12%) 0%, hsl(${(page.hue + 40) % 360} 40% 8%) 100%)` }}
    >
      {page.pattern === 'wave' ? (
        <svg viewBox="0 0 960 120" preserveAspectRatio="none" className="absolute inset-0 h-full w-full opacity-70">
          <path d={page.wavePath} fill="none" stroke={page.accent} strokeWidth="1.5" opacity="0.55" />
          <path d={page.wavePath} fill="none" stroke="#ffffff" strokeWidth="0.75" opacity="0.18" transform="translate(0 26)" />
        </svg>
      ) : null}
      {page.pattern === 'grid' ? (
        <div
          className="absolute inset-0 opacity-60"
          style={{ backgroundImage: `radial-gradient(hsl(${page.hue} 68% 62% / 0.35) 1px, transparent 1px)`, backgroundSize: '18px 18px' }}
        />
      ) : null}
      {page.pattern === 'bars' ? (
        <div className="absolute inset-x-6 bottom-0 flex h-full items-end gap-1 opacity-70">
          {page.heroBars.map((height, index) => (
            <span
              key={index}
              className="flex-1 rounded-t-sm"
              style={{ height: `${Math.round(height * 62)}%`, background: `hsl(${page.hue} 68% 62% / ${0.16 + height * 0.3})` }}
            />
          ))}
        </div>
      ) : null}
      <div className="absolute left-4 top-4 flex items-center gap-2">
        <span className="rounded-md border border-hairline bg-black/40 px-2 py-1 font-mono text-[10px] tracking-tight text-white/70 backdrop-blur-md">
          {page.topicLabel}
        </span>
        <span className="rounded-md border border-hairline bg-black/40 px-2 py-1 font-mono text-[10px] tracking-tight text-white/50 backdrop-blur-md">
          § {page.readMinutes} MIN READ
        </span>
      </div>
      <div className="absolute bottom-4 right-4 rounded-md border border-hairline bg-black/40 px-2 py-1 font-mono text-[10px] tracking-tight text-white/50 backdrop-blur-md">
        § {node.visitCount} VISITS
      </div>
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* Article body                                                        */
/* ------------------------------------------------------------------ */

function SpaSectionNav({
  page,
  onSectionClick,
}: {
  page: PageModel
  onSectionClick: (section: SpaSection) => void
}) {
  return (
    <div className="mt-6 rounded-xl border border-hairline bg-surface-glass p-3 backdrop-blur-md">
      <div className="flex items-center gap-1.5">
        <GitCommitHorizontal className="size-3.5 text-white/50" strokeWidth={1.75} />
        <span className="font-mono text-[10px] tracking-tight text-white/50">ON THIS PAGE · IN-DOMAIN PUSHSTATE</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {page.spaSections.map((section) => (
          <button
            key={section.slug}
            type="button"
            onClick={() => onSectionClick(section)}
            className="rounded-md border border-hairline bg-white/[0.03] px-2 py-1 text-[11px] text-white/70 transition-colors hover:border-accent/40 hover:text-accent"
          >
            {section.label}
            <span className="ml-1 font-mono text-[9px] text-white/35">#{section.slug}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function OutboundSection({ page, handlers }: { page: PageModel; handlers: LinkHandlers }) {
  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold tracking-tight text-white/95">Linked from this page</h2>
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-white/40">
          <Kbd>⌘/Ctrl</Kbd> click to branch · drag a link onto the pill
        </span>
      </div>
      <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
        {page.links.map((target) => (
          <LinkCard key={target.url} target={target} handlers={handlers} />
        ))}
      </div>
    </section>
  )
}

function ArticleBody({
  node,
  page,
  handlers,
  onSectionClick,
}: {
  node: SpatialTabNodeRecord
  page: PageModel
  handlers: LinkHandlers
  onSectionClick: (section: SpaSection) => void
}) {
  return (
    <>
      <header>
        <p className="font-mono text-[11px] tracking-tight" style={{ color: page.accent }}>
          {page.topicLabel} · {domainOf(node.url)}
        </p>
        <h1 className="mt-2 text-3xl font-semibold leading-tight tracking-tight text-white">{node.title}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-white/65">{page.dek}</p>
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-white/45">
          <span className="text-white/70">{page.author}</span>
          <span>·</span>
          <span>{page.dateLabel}</span>
          <span>·</span>
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" strokeWidth={1.75} />
            {page.readMinutes} min read
          </span>
          <span>·</span>
          <span>{node.visitCount} visits</span>
        </div>
      </header>

      <HeroBand node={node} page={page} />

      {page.isSpa && page.spaSections.length > 0 ? <SpaSectionNav page={page} onSectionClick={onSectionClick} /> : null}

      <div className="mt-8 space-y-8">
        {page.sections.map((section) => (
          <section key={section.id}>
            <div data-sec={section.id} className="scroll-mt-6">
              <div className="flex items-center gap-2.5">
                <span className="h-4 w-0.5 rounded-full" style={{ background: page.accent }} />
                <h2 className="text-[15px] font-semibold tracking-tight text-white/95">{section.heading}</h2>
              </div>
              <div className="mt-3 space-y-3">
                {section.paras.map((para, index) => (
                  <p key={index} className="text-[14.5px] leading-[1.75] text-white/75">
                    {para.map((seg, segIndex) => {
                      if (typeof seg === 'string') return <span key={segIndex}>{seg}</span>
                      const target = page.links[seg]
                      return target ? <InlineLink key={segIndex} target={target} handlers={handlers} /> : null
                    })}
                  </p>
                ))}
              </div>
            </div>
            {section.list ? (
              <ul className="mt-3 space-y-1.5">
                {section.list.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-[13px] leading-relaxed text-white/65">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full" style={{ background: page.accent }} />
                    {item}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}

        <figure className="rounded-xl border border-hairline bg-surface-glass p-4 backdrop-blur-md">
          <blockquote className="text-[14px] leading-relaxed text-white/80">{page.quote}</blockquote>
        </figure>

        <div className="overflow-hidden rounded-xl border border-hairline bg-black/50">
          <div className="flex items-center justify-between border-b border-hairline px-3 py-1.5">
            <span className="font-mono text-[10px] tracking-tight text-white/45">{page.code.lang}</span>
            <span className="font-mono text-[10px] tracking-tight text-white/30">mock · read-only</span>
          </div>
          <pre className="overflow-x-auto p-4 font-mono text-[11.5px] leading-relaxed text-white/80">
            <code>{page.code.code}</code>
          </pre>
        </div>

        {node.excerpt ? (
          <div className="rounded-xl border border-sticky/30 bg-sticky-glass p-4">
            <div className="flex items-center gap-2">
              <FileText className="size-3.5 text-sticky" strokeWidth={1.75} />
              <span className="font-mono text-[10px] tracking-tight text-sticky">CACHED TEXT · READABILITY SNAPSHOT</span>
            </div>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-white/70">{node.excerpt}</pre>
          </div>
        ) : null}
      </div>

      <OutboundSection page={page} handlers={handlers} />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* §7.1 hub SERP body                                                  */
/* ------------------------------------------------------------------ */

function SerpBody({ node, page, handlers }: { node: SpatialTabNodeRecord; page: PageModel; handlers: LinkHandlers }) {
  return (
    <>
      <header>
        <p className="font-mono text-[11px] tracking-tight text-white/45">SEARCH HUB · EPHEMERAL ROUTER</p>
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-hairline bg-surface-glass px-3 py-2.5 backdrop-blur-md">
          <Search className="size-4 shrink-0 text-white/40" strokeWidth={1.75} />
          <span className="truncate text-[14px] text-white/85">{page.hubQuery}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-white/30">{page.links.length} results · mock</span>
        </div>
        <div className="mt-2 flex items-center gap-3 font-mono text-[10px] text-white/40">
          <span className="text-accent">All</span>
          <span>Forums</span>
          <span>News</span>
          <span>Videos</span>
          {node.searchQuery ? <span className="ml-auto text-accent">query tag: “{node.searchQuery}”</span> : null}
        </div>
      </header>

      <div className="mt-6 space-y-5">
        <div className="rounded-xl border border-accent/20 bg-accent/[0.06] p-4">
          <p className="font-mono text-[10px] tracking-tight text-accent">AI OVERVIEW · MOCK</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-white/70">
            Results for “{page.hubQuery}” cluster around {page.topicLabel.toLowerCase()}. The destination tabs below carry the query tag
            into the graph, so spawned children stay tagged when they orbit the hub.
          </p>
        </div>

        {page.links.map((target) => (
          <div key={target.url} className="group relative flex gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-white/50">
                <span className="size-2 rounded-full" style={{ background: `hsl(${fnv1a32(target.url) % 360} 68% 62%)` }} />
                {domainOf(target.url)}
              </span>
              <a
                href={target.url}
                draggable
                onClick={(event) => handleLinkActivate(event, target, handlers)}
                onDragStart={(event) => handleLinkDragStart(event, target)}
                className="w-fit cursor-pointer text-[16px] font-medium leading-snug text-white/90 underline decoration-transparent underline-offset-4 transition-colors hover:text-white hover:decoration-white/40"
              >
                {target.title}
              </a>
              <span className="text-[12.5px] leading-relaxed text-white/55">{blurbFor(target)}</span>
              {target.searchQuery ? (
                <span className="w-fit rounded-md bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent">“{target.searchQuery}”</span>
              ) : null}
            </div>
            <BranchButton target={target} onBranch={handlers.onBranch} className="opacity-0 group-hover:opacity-100" />
          </div>
        ))}
      </div>

      <section className="mt-10">
        <h2 className="text-[13px] font-semibold tracking-tight text-white/80">Related searches</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {page.relatedSearches.map((target) => (
            <a
              key={target.url}
              href={target.url}
              draggable
              onClick={(event) => handleLinkActivate(event, target, handlers)}
              onDragStart={(event) => handleLinkDragStart(event, target)}
              className="inline-flex cursor-grab items-center gap-1.5 rounded-full border border-hairline bg-white/[0.04] px-3 py-1.5 text-[12px] text-white/70 transition-colors hover:border-accent/40 hover:text-accent active:cursor-grabbing"
            >
              <Search className="size-3 text-white/35" strokeWidth={1.75} />
              {target.title}
            </a>
          ))}
        </div>
      </section>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* §7.4 private page body                                              */
/* ------------------------------------------------------------------ */

function PrivateBody() {
  return (
    <header>
      <div className="flex items-center gap-2">
        <HeaderChip tone="violet" icon={<Lock className="size-3" strokeWidth={1.75} />}>
          NO CAPTURE
        </HeaderChip>
        <span className="font-mono text-[11px] text-white/45">private page · blur-glass placeholder</span>
      </div>
      <div className="mt-8 space-y-4" aria-hidden>
        <div className="h-9 w-2/3 rounded-lg bg-white/[0.06] blur-md" />
        <div className="h-3 w-full rounded bg-white/[0.05] blur-md" />
        <div className="h-3 w-11/12 rounded bg-white/[0.05] blur-md" />
        <div className="h-3 w-4/5 rounded bg-white/[0.05] blur-md" />
        <div className="h-32 w-full rounded-xl bg-white/[0.04] blur-lg" />
        <div className="h-3 w-3/4 rounded bg-white/[0.05] blur-md" />
      </div>
      <p className="mt-6 max-w-md text-[13px] leading-relaxed text-white/55">
        This page is marked <span className="font-mono text-[11px] text-ghost">noCapture</span> — thumbnails and text extraction are
        disabled by design, so the reader renders a blur-glass placeholder instead of real content (§7.4).
      </p>
    </header>
  )
}

/* ------------------------------------------------------------------ */
/* Reader header strip                                                 */
/* ------------------------------------------------------------------ */

function ReaderHeader({
  node,
  page,
  onBranch,
  onQuickNote,
  trailOnSelect,
}: {
  node: SpatialTabNodeRecord
  page: PageModel
  onBranch: (target: MockLinkTarget) => void
  onQuickNote: () => void
  trailOnSelect: (sub: SubPageRef) => void
}) {
  const featured = page.links[0]
  return (
    <header className="z-30 shrink-0 border-b border-hairline bg-surface-glass backdrop-blur-xl">
      <div className="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
        <span className="flex items-center gap-2">
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: page.accent, boxShadow: `0 0 8px ${page.accent}` }} />
          <span className="font-mono text-[12px] tracking-tight text-white/85">{node.domain}</span>
          <span className="hidden truncate font-mono text-[11px] text-white/40 sm:inline">{pathOf(node.url)}</span>
        </span>

        <span className="flex flex-wrap items-center gap-1.5">
          {node.isAudible ? (
            <span className="flex items-end gap-0.5" aria-hidden>
              {[0, 1, 2].map((bar) => (
                <span key={bar} className="w-0.5 animate-pulse rounded-full bg-accent" style={{ height: 4 + bar * 4, animationDelay: `${bar * 140}ms` }} />
              ))}
            </span>
          ) : null}
          {node.viaAuth ? <HeaderChip tone="amber">VIA AUTH</HeaderChip> : null}
          {node.noCapture ? (
            <HeaderChip tone="violet" icon={<Lock className="size-3" strokeWidth={1.75} />}>
              NO CAPTURE
            </HeaderChip>
          ) : null}
          {node.searchQuery ? <HeaderChip tone="accent">“{node.searchQuery}”</HeaderChip> : null}
          {node.nodeType === 'hub' ? <HeaderChip tone="accent">HUB</HeaderChip> : null}
          {node.excerpt ? (
            <HeaderChip tone="amber" icon={<FileText className="size-3" strokeWidth={1.75} />}>
              CACHED
            </HeaderChip>
          ) : null}
          {node.isLoading ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent">
              <LoaderCircle className="size-3 animate-spin" strokeWidth={1.75} />
              LOADING
            </span>
          ) : null}
        </span>

        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onQuickNote}
            title="Quick sticky note on this page (Alt+N)"
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-white/75 transition-colors hover:border-sticky/50 hover:text-sticky"
          >
            <StickyNote className="size-3.5" strokeWidth={1.75} />
            Note
            <Kbd>Alt+N</Kbd>
          </button>
          <button
            type="button"
            onClick={() => onBranch(featured ?? { url: node.url, title: node.title })}
            title={featured ? `Branch node → ${featured.title}` : 'Branch node from this page'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent/20"
          >
            <GitBranch className="size-3.5" strokeWidth={1.75} />
            Branch Node
            <Kbd>⌘</Kbd>
          </button>
        </span>
      </div>

      {node.subPages.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-hairline px-4 py-1.5">
          <History className="size-3 text-white/40" strokeWidth={1.75} />
          <span className="font-mono text-[10px] tracking-tight text-white/40">PUSHSTATE TRAIL · {node.subPages.length}</span>
          {node.subPages.map((sub) => (
            <button
              key={sub.url}
              type="button"
              onClick={() => trailOnSelect(sub)}
              className="max-w-56 truncate rounded-md border border-hairline bg-white/[0.03] px-2 py-0.5 font-mono text-[10px] text-white/60 transition-colors hover:border-accent/40 hover:text-accent"
            >
              {sub.title}
            </button>
          ))}
        </div>
      ) : null}
    </header>
  )
}

/* ------------------------------------------------------------------ */
/* §5.3 SoundCloud-style media bar                                     */
/* ------------------------------------------------------------------ */

function MediaBar({
  node,
  elapsedMs,
  totalMs,
  bars,
  onToggle,
  onSeek,
}: {
  node: SpatialTabNodeRecord
  elapsedMs: number
  totalMs: number
  bars: number[]
  onToggle: () => void
  onSeek: (fraction: number) => void
}) {
  const progress = totalMs > 0 ? Math.min(1, elapsedMs / totalMs) : 0
  const activeBars = Math.round(progress * bars.length)
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className="absolute bottom-3 left-1/2 z-30 w-[min(660px,calc(100%-24px))] -translate-x-1/2 rounded-2xl border border-hairline bg-surface-glass p-3 backdrop-blur-xl"
      style={{ boxShadow: '0 8px 32px rgba(0, 0, 0, 0.45)' }}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          aria-label={node.isAudible ? 'Pause mock audio (audio-immunity toggle)' : 'Play mock audio (audio-immunity toggle)'}
          className="flex size-9 shrink-0 items-center justify-center rounded-full border border-accent/50 bg-accent/15 text-accent transition-colors hover:bg-accent/30"
        >
          {node.isAudible ? <Pause className="size-4" strokeWidth={1.75} /> : <Play className="ml-0.5 size-4" strokeWidth={1.75} />}
        </button>
        <motion.span
          animate={node.isAudible ? { scale: [1, 1.18, 1] } : { scale: 1 }}
          transition={{ repeat: node.isAudible ? Infinity : 0, duration: 0.9, ease: 'easeInOut' }}
          className={cn('shrink-0', node.isAudible ? 'text-accent' : 'text-white/35')}
        >
          <AudioLines className="size-4" strokeWidth={1.75} />
        </motion.span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-white/85">{node.title}</span>
          <span className="block truncate font-mono text-[10px] text-white/40">
            {ARTISTS[fnv1a32(node.uuid) % ARTISTS.length]} · mock stream · {node.isAudible ? 'IMMUNE — pool skips audible tabs' : 'paused'}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[10px] text-white/50">
          {formatDurationMs(elapsedMs)} / {formatDurationMs(totalMs)}
        </span>
      </div>
      <div
        className="mt-2.5 flex h-8 cursor-pointer items-end gap-[2px]"
        role="slider"
        tabIndex={0}
        aria-label="Mock audio seek"
        aria-valuemin={0}
        aria-valuemax={totalMs}
        aria-valuenow={elapsedMs}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          onSeek(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)))
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            onSeek(Math.min(1, (elapsedMs + 5000) / totalMs))
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            onSeek(Math.max(0, (elapsedMs - 5000) / totalMs))
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onToggle()
          }
        }}
      >
        {bars.map((height, index) => (
          <span
            key={index}
            className={cn('flex-1 rounded-full transition-colors', index < activeBars ? 'bg-accent' : 'bg-white/15')}
            style={{ height: `${Math.round(height * 100)}%` }}
          />
        ))}
      </div>
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* §7.6 sticky rail                                                    */
/* ------------------------------------------------------------------ */

function StickyRail({
  notes,
  drafts,
  onDraftChange,
  onCommit,
  onDelete,
  onAdd,
}: {
  notes: StickyNoteRecord[]
  drafts: Record<string, string>
  onDraftChange: (noteId: string, text: string) => void
  onCommit: (note: StickyNoteRecord) => void
  onDelete: (noteId: string) => void
  onAdd: () => void
}) {
  return (
    <aside
      className="absolute right-3 top-[56px] z-20 hidden w-60 flex-col rounded-2xl border border-hairline bg-surface-glass backdrop-blur-xl lg:flex"
      style={{ maxHeight: 'calc(100% - 140px)' }}
    >
      <div className="flex items-center gap-1.5 border-b border-hairline px-3 py-2">
        <StickyNote className="size-3.5 text-sticky" strokeWidth={1.75} />
        <span className="font-mono text-[10px] tracking-tight text-sticky">STICKIES · {notes.length}</span>
        <button
          type="button"
          onClick={onAdd}
          title="Quick sticky note (Alt+N)"
          aria-label="Quick sticky note (Alt+N)"
          className="ml-auto flex size-5 items-center justify-center rounded-md border border-hairline bg-white/[0.05] text-white/70 transition-colors hover:border-sticky/50 hover:text-sticky"
        >
          <Plus className="size-3" strokeWidth={1.75} />
        </button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {notes.length === 0 ? (
          <p className="px-1 py-2 text-[11.5px] leading-relaxed text-white/45">
            No stickies on this page yet. Press <Kbd>Alt+N</Kbd> or hit the + to attach one to this URL.
          </p>
        ) : (
          notes.map((note) => (
            <div key={note.id} className="rounded-xl border border-sticky/30 bg-sticky-glass p-2">
              <textarea
                value={drafts[note.id] ?? note.text}
                placeholder="Type a note…"
                rows={3}
                onChange={(event) => onDraftChange(note.id, event.target.value)}
                onBlur={() => onCommit(note)}
                className="w-full resize-none bg-transparent text-[12px] leading-relaxed text-white/85 placeholder:text-white/30 focus:outline-none"
              />
              <div className="mt-1 flex items-center justify-between">
                <span className="font-mono text-[9px] text-white/35">{formatStamp(note.updatedAt)}</span>
                <button
                  type="button"
                  onClick={() => onDelete(note.id)}
                  aria-label="Delete sticky note"
                  className="flex size-4 items-center justify-center rounded text-white/40 transition-colors hover:text-rose-300"
                >
                  <X className="size-3" strokeWidth={1.75} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/* Root component                                                      */
/* ------------------------------------------------------------------ */

export function MockWebReader({ node, onNavigate, onBranch, onSubNavigate, className }: MockWebReaderProps) {
  const page = useMemo(() => buildPage(node), [node])
  const pageKey = `${node.uuid}:${node.urlHash}`
  const scrollRef = useRef<HTMLDivElement | null>(null)

  /* --- store: audible immunity toggle + url_hash stickies (§5.3, §7.6) --- */
  const toggleAudible = useGraphStore((state) => state.toggleAudible)
  const quickNoteOnActive = useGraphStore((state) => state.quickNoteOnActive)
  const updateStickyNote = useGraphStore((state) => state.updateStickyNote)
  const deleteStickyNote = useGraphStore((state) => state.deleteStickyNote)
  const notes = useGraphStore(useShallow((state) => selectNotesForNode(state, node.uuid)))

  /* --- local ui state --- */
  const [toast, setToast] = useState<{ label: string; at: number } | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  /* --- reset transient state during render when the page changes
         (React's "adjust state when a prop changes" pattern) --- */
  const [lastPageKey, setLastPageKey] = useState(pageKey)
  if (lastPageKey !== pageKey) {
    setLastPageKey(pageKey)
    setToast(null)
    setElapsedMs(0)
  }

  const totalMs = useMemo(() => (150 + (page.hash % 240)) * 1000, [page.hash])
  const waveBars = useMemo(() => {
    const rand = mulberry32(page.hash ^ 0x51ed270b)
    return Array.from({ length: 48 }, () => 0.2 + rand() * 0.8)
  }, [page.hash])

  /* --- page transition: reset scroll (transient state resets above) --- */
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [pageKey])

  /* --- mock playback clock (paused ⇒ no interval; loops at track end) --- */
  useEffect(() => {
    if (!node.isAudible) return
    const timer = window.setInterval(() => {
      setElapsedMs((ms) => (ms + 250 >= totalMs ? 0 : ms + 250))
    }, 250)
    return () => window.clearInterval(timer)
  }, [node.isAudible, totalMs])

  /* --- did-navigate-in-page toast auto-dismiss --- */
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 1800)
    return () => window.clearTimeout(timer)
  }, [toast])

  /* --- stable handlers ------------------------------------------------ */
  const handlers = useMemo<LinkHandlers>(() => ({ onNavigate, onBranch }), [onNavigate, onBranch])

  const goToSection = useCallback(
    (slug: string | null, label: string, subUrl?: string, alreadyRecorded?: boolean) => {
      if (slug) {
        const target = scrollRef.current?.querySelector<HTMLElement>(`[data-sec="${slug}"]`)
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } else {
        scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      }
      setToast({ label, at: Date.now() })
      if (subUrl && !alreadyRecorded) onSubNavigate?.({ title: label, url: subUrl })
    },
    [onSubNavigate],
  )

  /** SPA section click → mock did-navigate-in-page (App wires it to pushSubPage). */
  const onSpaSectionClick = useCallback(
    (section: SpaSection) => {
      const baseUrl = node.url.split('#')[0]
      const subUrl = `${baseUrl}#${section.slug}`
      const recorded = node.subPages.some((sub) => sub.url === subUrl)
      goToSection(section.slug, section.label, subUrl, recorded)
    },
    [node.url, node.subPages, goToSection],
  )

  const onTrailSelect = useCallback(
    (sub: SubPageRef) => {
      const slug = sub.url.split('#')[1] ?? null
      goToSection(slug, sub.title)
    },
    [goToSection],
  )

  const onQuickNote = useCallback(() => {
    quickNoteOnActive()
    setToast({ label: 'sticky note attached to this URL', at: Date.now() })
  }, [quickNoteOnActive])

  const rootStyle = {
    '--page-accent': page.accent,
    background: page.bg,
  } as CSSProperties

  return (
    <div className={cn('relative flex h-full w-full flex-col overflow-hidden', className)} style={rootStyle}>
      {/* §5.1 simulated navigation pulse */}
      <AnimatePresence>
        {node.isLoading ? (
          <motion.div
            key="loading-bar"
            className="absolute left-0 top-0 z-40 h-[2px] w-full overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="h-full w-1/3"
              style={{ background: 'linear-gradient(90deg, transparent, #34D399, transparent)' }}
              initial={{ x: '-100%' }}
              animate={{ x: '320%' }}
              transition={{ repeat: Infinity, duration: 0.9, ease: 'easeInOut' }}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* did-navigate-in-page toast (§7.3) */}
      <AnimatePresence>
        {toast ? (
          <motion.div
            key={toast.at}
            className="absolute left-1/2 top-[56px] z-40 -translate-x-1/2 rounded-lg border border-hairline bg-surface-glass px-3 py-1.5 font-mono text-[11px] text-white/75 backdrop-blur-xl"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={SPRING}
          >
            did-navigate-in-page → {toast.label}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <ReaderHeader node={node} page={page} onBranch={onBranch} onQuickNote={onQuickNote} trailOnSelect={onTrailSelect} />

      <div ref={scrollRef} className="relative flex-1 overflow-y-auto overflow-x-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.article
            key={pageKey}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={SPRING}
            className={cn(
              'mx-auto w-full max-w-[46rem] px-5 pb-44 pt-7 sm:px-6',
              node.ramState === 'hibernated' || node.nodeType === 'ghost-echo' ? 'opacity-70 saturate-75' : '',
            )}
          >
            <StateBanner node={node} />
            {node.noCapture ? (
              <PrivateBody />
            ) : page.isHub ? (
              <SerpBody node={node} page={page} handlers={handlers} />
            ) : (
              <ArticleBody node={node} page={page} handlers={handlers} onSectionClick={onSpaSectionClick} />
            )}
            <footer className="mt-10 border-t border-hairline pb-2 pt-3">
              <p className="font-mono text-[10px] text-white/30">
                {domainOf(node.url)} · mock page · {node.urlHash}
              </p>
            </footer>
          </motion.article>
        </AnimatePresence>
      </div>

      <StickyRail
        notes={notes}
        drafts={drafts}
        onDraftChange={(noteId, text) => setDrafts((current) => ({ ...current, [noteId]: text }))}
        onCommit={(note) => {
          const draft = drafts[note.id]
          if (draft !== undefined && draft !== note.text) updateStickyNote(note.id, draft)
        }}
        onDelete={deleteStickyNote}
        onAdd={onQuickNote}
      />

      <MediaBar
        node={node}
        elapsedMs={elapsedMs}
        totalMs={totalMs}
        bars={waveBars}
        onToggle={() => toggleAudible(node.uuid)}
        onSeek={(fraction) => setElapsedMs(fraction * totalMs)}
      />
    </div>
  )
}

export default MockWebReader
