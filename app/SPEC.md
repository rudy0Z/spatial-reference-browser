# SPEC.md — Phase 1: Spatial Canvas & Floating Island Shell (Interactive MVP)

**Purpose:** a standalone, ultra-fluid Vite + React + TypeScript application with a realistic mock tab/browser simulation, so we can perfect the 120fps spatial UX, hybrid physics, semantic zoom, sticky/voice notes, and pill-to-canvas transitions **before** wiring it onto the Blanc fork's Electron `WebContentsView` pool in Phase 2. Real live websites are NOT part of this phase — everything is mocked but functional. Zero TypeScript errors, zero missing imports, zero `any`, zero TODO/placeholder stubs.

## 1. Tech stack & architecture requirements
- **Framework:** Vite + React 18+ + TypeScript (strict mode)
- **Styling:** Tailwind CSS v4 (via `@tailwindcss/vite`) + `clsx` + `tailwind-merge`
- **Spatial graph engine:** `@xyflow/react` (React Flow v12+)
- **Physics:** `d3-force` (`forceSimulation`, `forceLink`, `forceManyBody`, `forceCollide`, `forceX`, `forceY`) — pinned anchors locked via `fx`/`fy` so they never drift; unpinned satellite children orbit gently via spring forces without scrambling the rest of the map
- **Animations:** `framer-motion` — snappy springs (`stiffness: 380, damping: 30`), zero sluggish linear easing
- **State:** `zustand` with `persist` middleware (localStorage or IndexedDB) for nodes, edges, notes, audio blobs, coordinates, co-visitation weights
- **Icons:** `lucide-react`
- **Audio:** native `MediaRecorder` API — real playable WebM/Opus voice memos on any node, with an animated 12-bar waveform playback
- **Fonts:** Inter (UI, tracking `-0.02em`) + JetBrains Mono (URLs, domains, RAM badges, timestamps, slash commands) — use `@fontsource-variable/inter` and `@fontsource/jetbrains-mono` npm packages
- File structure (small helper modules like `src/lib/types.ts`, `src/lib/seed.ts`, `src/lib/embed.ts` may be added if a cleaner split is justified — record any deviation):
  - `src/store/useGraphStore.ts` — nodes, edges, regions, LRU live pool, sticky/voice notes, Ghost Echo matcher, co-visitation, 600-node stress seeder
  - `src/hooks/useHybridForceLayout.ts` — pinned anchor `fx`/`fy` + satellite d3-force solver
  - `src/hooks/useVoiceRecorder.ts` — MediaRecorder capture + blob-URL playback
  - `src/components/chrome/FloatingIslandPill.tsx`
  - `src/components/chrome/NeighbourhoodGlance.tsx`
  - `src/components/canvas/SpatialCanvas.tsx`
  - `src/components/canvas/nodes/SpatialTabNode.tsx`
  - `src/components/viewport/MockWebReader.tsx`
- Do not add runtime dependencies beyond those listed here without recording the deviation in the report.

## 2. Design direction — dark-first tactical glass ("Apple Design Award winner × Linear × Raycast × Blanc"). Zero generic SaaS clutter.
- Canvas void background: `#090A0C` with a subtle radial dot-matrix grid (`#1C1F26`, fading out at low zoom)
- Elevated surface / card base: `#12141A` / `rgba(20, 23, 30, 0.78)` with `backdrop-blur-xl`
- Hairline borders: `1px solid rgba(255, 255, 255, 0.08)`; active glow `rgba(110, 231, 183, 0.45)`
- Primary accent (pine/sage signal): `#34D399` — active indicator, live audio wave, connected pulses
- Ghost Echo accent (spectral): `#A78BFA` with dashed glowing borders
- Sticky note warmth: `#FDE047` / `#FEF08A` on muted dark amber glass (`rgba(250, 204, 21, 0.12)` surface, `#FDE047` accent border/text) — never burns eyes in dark mode
- Typography: Inter for UI labels (tight tracking `-0.02em`), JetBrains Mono for URLs, domains, RAM badges (`0 MB` vs `142 MB`), timestamps, slash commands
- Motion language: spring physics everywhere; no linear easing

## 3. Core view modes & navigation shell

### Mode A — Focused Reading Viewport + "The Blanc Floating Island Pill"
- Full-bleed simulated active webpage viewport (sleek interactive mock reader with clickable outbound links so live child-node spawning is testable)
- **Top-center Floating Island Pill — resting state (`height: 36px`):** active favicon, clean domain, live RAM status badge, **up to 6 neighbor/cluster dots** (see §6 semantics), quick actions: Add Note (`Alt+N`) and Toggle Canvas (`Cmd/Ctrl+Space` with `Alt+Space` fallback, or button click)
- **Expanded Command Palette (`Cmd/Ctrl+L` or clicking pill center):** pill smoothly morphs (framer-motion) into a Raycast-style command & search bar over a subtle scrim. Fuzzy search across open tabs, hibernated nodes, sticky note text, and voice-note titles. Slash commands: `/canvas`, `/hibernate-all`, `/new`, `/note`, `/cluster`, `/seed-600`
- **Local Neighbourhood Glance (`Cmd/Ctrl+Shift+G`):** crisp 300px glass panel sliding in beside the webpage, showing ONLY the 1-hop and 2-hop connected nodes plus any active Ghost Echo suggestions (small live force-graph, click a node to focus it on the canvas)

### Mode B — The Infinite Spatial Graph Canvas (`Cmd/Ctrl+Space` / `Alt+Space`)
- Instant cross-fade from Reading Mode into the full-screen `@xyflow/react` infinite canvas
- **Floating bottom HUD dock:** zoom indicator (`0.15x`–`2.0x`), semantic-zoom override toggle, physics Freeze/Relax toggle, quick sticky/region creator, and the **Active Workbench Tray** — a magnetic dock holding the 3–5 currently live tabs so you can jump to them from anywhere on the map

## 4. Node card spec — 3 semantic zoom levels × 6 visual states

### Semantic zoom levels (LOD for 600-node performance)
1. **Macro Constellation (`zoom < 0.35`):** unmount heavy DOM internals; render pure fast colored circular/pill beacons (~24px) + large high-contrast Region Cluster titles. 600 nodes pan at locked 120fps.
2. **Compact Pill (`0.35 ≤ zoom < 0.65`):** sleek `180px × 44px` pills: favicon + truncated title + note/audio micro-dot + anchor-pin icon
3. **Rich Spatial Card (`zoom ≥ 0.65`):** full `260px` card with 16:9 thumbnail (`146px` height), metadata bar, interactive hover actions, attached context badges

### The 6 visual & functional node states (at rich-card zoom)
1. **ACTIVE LIVE TAB (`ramState: 'live'`)** — crisp `1px` emerald border glow (`#34D399`), subtle ambient shadow, pulsing `6px` green status dot, mono badge `LIVE · 138 MB`. 16:9 thumbnail header, favicon, 2-line clamped title, clean domain; hover actions: Open Viewport, Hibernate (`0 MB`), Pin Anchor, `+ Note`
2. **HIBERNATED UNIFIED NODE (`ramState: 'hibernated'`)** — replaces bookmarks; `0 MB` RAM. Slightly desaturated (`saturate-75 opacity-90`) thumbnail + frost badge `SLEEP · 0 MB` (mono). **Visual recency decay:** untouched > 14 simulated days dims border contrast (`opacity-65`) into "Cold Archive" chips while staying spatially anchored. Click wakes to LIVE
3. **GHOST ECHO NODE (`nodeType: 'ghost-echo'`)** — predictive resurfacing: semi-transparent violet/cyan dashed-border card (`border-dashed border-violet-400/50 bg-violet-950/20`) tethered near the active node. Badge `GHOST ECHO · 92% MATCH`. Actions: `Wake Here` (links/wakes the tab) or `Dismiss (✕)` — ignoring lets it fade away cleanly on context switch
4. **ANNOTATED NODE** — sticky note: tactile folded warm-amber glass card tucked under the bottom-right edge, max-3-line preview, click to edit inline. Voice memo: sleek pill chip with Play/Pause, duration (`0:12`), 12-bar animated CSS visualizer playing the real recorded MediaRecorder audio on hover/click without leaving the canvas
5. **COLLAPSED MACRO-STACK (`isCollapsedCluster: true`)** — double-clicking a parent with children collapses them into a layered 3-card deck effect beneath the parent with badge `+14 TABS`; double-click again fans them back out with spring physics
6. **PINNED ANCHOR vs ORBITING SATELLITE** — anchor: subtle top-right pin glyph; dragging a node locks its `(fx, fy)` so physics never drifts it. Satellite: newly spawned tabs auto-position radially near their parent with an animated directional bezier/smoothstep edge showing traversal flow

## 5. Smart interaction mechanics & guardrails
1. **Live link spawning testbed:** the mock reader includes clickable outbound links ("WebGPU Fluid Shaders", "React Flow Performance Docs", "F1 Telemetry API", "Rust Servo Architecture", …). **Normal click** navigates the current node in place. **`Cmd/Ctrl+Click`** (or a Branch Node button) spawns a connected child satellite on the graph, pulses a new dot in the pill, draws a directional edge
2. **Strict active pool guardrail (max 5 live tabs):** automatic LRU pool of 5 live tabs. Opening a 6th auto-transitions the oldest unpinned, non-audible live tab to `HIBERNATED (0 MB)` with a smooth toast
3. **Audio/media immunity:** a mock "playing audio" toggle (`isAudible: true`, e.g. a SoundCloud-style tab). Audible tabs show an animated equalizer icon in pill/card and are strictly immune from auto-hibernation (also: never hibernate while a voice note is recording)
4. **600-tab stress test (`/seed-600`):** one palette command generating 600 realistic developer/designer tabs across 6 spatial regions (UI Systems, Browser Architecture, WebGPU & Shaders, AI Agents, F1 Data Viz, Career & Docs) to test viewport culling (`onlyRenderVisibleElements`), semantic-zoom transitions, and pan/zoom frame rates

## 6. Founder addenda (from the founder's UX research — implement these)
- **Neighbor dot semantics (pill):** accent = active, pulsing = loading, hollow = hibernated, violet glow = Ghost Echo. Dots represent connected neighbors (the parent page you came from + siblings spawned from the same link cluster), max 6
- **Drag-to-anchor:** dragging a link/image/text from the reader upward onto the floating pill drops a node onto the canvas adjacent to the current page's node, preserving the source URL (Kinopio-style). If native HTML5 drag is awkward across boundaries, a visible drop-zone affordance on the pill is acceptable — but the drag gesture itself must work
- **Regions replace workspaces:** named spatial islands ("UI Inspiration" in the north, "Job Hunt" in the east) — large region titles at macro zoom. Panning across gives bird's-eye recall. Macro-node collapse per state 5 replaces tab stacks
- **Visual decay per state 2** — the browser never forces "bookmark or close"; old nodes gently dim instead
- **Active Workbench gravity well:** tabs you're switching between get pulled into the HUD tray with faint tether lines back to their home regions
- **Ghost Echo score:** `relevance = 0.55·cosineSimilarity + 0.30·normalizedCoVisitation + 0.15·recencyDecay`; above **0.78** spawns a ghost suggestion beside the active cluster + a violet pill dot. Co-visitation: switching directly from tab A to tab B within ~10s increments their edge weight (even across zero keyword overlap)
- **Never auto-move existing nodes.** Physics may place NEW satellites near their parent; pinned anchors never drift; the physics Freeze toggle stops all motion

## 7. Edge cases (data-model level in this phase; UI surfaces what is listed)
1. **Hub super-nodes:** seed data includes google.com search-hub nodes marked as ephemeral utility routers — they render as small neutral router chips; destination nodes carry a subtle search-query pill tag
2. **Redirect/OAuth collapse:** model-level — navigation chains under 3s or matching oauth/payment domains collapse into ONE node with a small "via auth" tag; the seeder includes one example
3. **SPA sub-navigation:** nodes may carry `subPages[]` (in-domain pushState trail, mocked via `did-navigate-in-page` in the reader); rich cards show an expandable filmstrip stack underneath the parent card
4. **Blank/sensitive thumbnails:** nodes marked `noCapture` (private) render as blur-glass placeholder cards — never a real thumbnail
5. **Dead links:** seeded nodes may carry a short markdown excerpt (Readability-style snapshot); hibernated card shows a "cached text" chip; opening shows the excerpt in a modal
6. **Duplicate URLs:** `node_uuid` (unique) vs `url_hash` (canonical). Two nodes may share a `url_hash`; sticky notes attach to `url_hash` so they appear on both instances automatically
7. **Media & pin immunity:** never auto-hibernate audible tabs, recording-in-progress, or pinned anchors

## 8. Substitutions agreed for Phase 1 (honest scope)
- **Embeddings:** deterministic toy hash embedder (`src/lib/embed.ts`, 384-dim bag-of-words hashing, same interface the real model will have) — real `all-MiniLM-L6-v2` via transformers.js ships in Phase 2/3
- **Voice-note search:** searchable by title/duration in this phase; local Whisper speech-to-text ships later
- **Persistence:** zustand persist → localStorage/IndexedDB; SQLite arrives with the Electron phase
- **RAM badges:** mock numbers (stable per tab; hibernated always `0 MB`)

## 9. First-run experience
Pre-seed on first launch: **28 curated, realistic tabs across 4 spatial islands** — 3 live, 22 hibernated (a few >14 days old for visible decay), 2 Ghost Echoes, pre-attached sample sticky notes, and at least: one audible tab, one `noCapture` private node, one SPA filmstrip node with `subPages[]`, one google.com hub + query-tagged children, one duplicate-`url_hash` pair sharing notes. The app must look alive and functional on first `npm run dev`.

## 10. Keyboard shortcuts (with host-collision guards)
| Shortcut | Action | Guard |
|---|---|---|
| `Cmd/Ctrl+Space` **and** `Alt+Space` | Toggle Canvas ⇄ Reading | `preventDefault`; Alt+Space exists because the browser test rig may swallow Cmd/Ctrl+Space |
| `Cmd/Ctrl+L` | Command palette | preventDefault (browser address bar) |
| `Alt+N` | Quick sticky note on active node | preventDefault |
| `Cmd/Ctrl+Shift+G` | Neighbourhood Glance | preventDefault |
| `Esc` | Close palette / dismiss ghost / back to reading | layered dismissal |

On-screen shortcut hint chips must be visible so nothing conflicts silently with the host OS.
