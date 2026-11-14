# Technical Briefing & Architecture: Spatial Reference Browser

> **For Gemini Web Context:** This document provides a complete technical and conceptual overview of the **Spatial Reference Browser**, including its core thesis, architectural mechanisms, anti-slop visual design system, mathematical formulas, and real source code excerpts.

---

## 1. Executive Summary & The Problem

### The User Persona
A visual designer / creative director who keeps **600–700 open visual-reference tabs** across Are.na, Cosmos, Siteinspire, Dribbble, Figma, YouTube, and GitHub.

### Why Standard Browsers Fail Them
1. **The Tab Strip Collapse:** In Chrome, Arc, or Safari, once you exceed 50–100 tabs, favicons shrink to illegible 2px slivers. The spatial memory of *where* you saw something is wiped out.
2. **The RAM Cliff:** 700 live Chromium renderer processes consume 20–40 GB of RAM. Existing "tab discarders" unload tabs arbitrarily, destroying scroll state, form inputs, and canvas position.
3. **The Organization Paradox:** Manual bookmarking and hierarchical folders fail. Curation takes too much friction; the user wants to research in a flow state without acting as a file librarian.

### The Thesis: "The System Pays, the User Confirms"
- Open tabs, hibernated links, and projects exist as **nodes with directed edges on an infinite 2D canvas**.
- **0 MB Hibernation:** Inactive tabs automatically sleep to 0 MB of RAM while maintaining their coordinates, edges, notes, and rendered thumbnails.
- **Auto-Branching:** Clicking links (`Cmd/Ctrl + Click`) branches directed child nodes outward rather than replacing the current view.
- **Suggest-Only Semantic Clustering:** Local embeddings recommend groupings and tether "ghost echoes" based on context, but **never auto-move pinned nodes**.

---

## 2. Core Architecture: The Two-Mode Warm Pool

A common failure of canvas browsers is trying to place dozens of live webviews directly onto a zoomable canvas (which tanks GPU compositing to 5 fps). 

Our design uses a **Two-Mode Warm-Pool Architecture**:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        SPATIAL REFERENCE BROWSER                       │
├───────────────────────────────────┬────────────────────────────────────┤
│   MODE A: READING VIEW            │   MODE B: SPATIAL CANVAS           │
│   (Focused browsing)              │   (Macro sensemaking & navigation) │
├───────────────────────────────────┼────────────────────────────────────┤
│ • ≤ 6 Live WebContentsViews       │ • Pure DOM / React Flow canvas     │
│ • Managed by LRU pool             │ • Crisp 640×400 WebP thumbnails    │
│ • Audio / recording / pin immune  │ • 120 fps sustained panning/zoom   │
│ • Oldest view auto-hibernates     │ • Zero live renderers on canvas    │
│   (reclaims ~148 MB/tab)          │ • 3-Tier Semantic LOD              │
└───────────────────────────────────┴────────────────────────────────────┘
```

### Engine Decision: Electron 45 + Chromium 156 (Forking Blanc)
Rather than maintaining a custom 150 GB C++ Chromium build, we fork **Blanc** (an MIT Electron browser):
- **Free Hibernation Subsystem:** Inherits battle-tested `quietTab`/`wakeTab` IPC primitives.
- **Rendering Parity:** 100% Chrome compatibility with Figma, WebGL/WebGPU, OAuth, and passkeys.
- **Dual Adblock:** Bundled uBlock Origin and Ghostery engine built-in.
- **Extension Layer:** Built via `electron-chrome-extensions` for Chrome Web Store extensions.

---

## 3. The Mathematics & Intelligence Layer

### 1. Ghost Echo Recommendation Formula
When reading a node, the browser calculates semantic affinity against hibernated nodes and tethers up to 3 translucent "ghost echoes" nearby.

$$\text{Relevance} = 0.55 \cdot \text{CosineSimilarity} + 0.30 \cdot \text{CoVisitation} + 0.15 \cdot \text{RecencyDecay}$$

- **Threshold:** $\ge 0.78$ triggers a ghost tether.
- **Co-visitation Window:** Navigating directly from Node A to Node B within 10,000 ms increments their edge weight.
- **Embeddings:** Local quantized `all-MiniLM-L6-v2` ONNX models running in a background worker thread.

### 2. Three-Tier Semantic Level of Detail (LOD)
The canvas scales rendering complexity dynamically based on zoom factor:
* **Macro Tier (Zoom < 0.35):** Renders minimal colored beacons and region cluster titles. No card DOM overhead.
* **Compact Tier (0.35 ≤ Zoom < 0.65):** Condensed horizontal pills displaying title, favicon, and hairline connections.
* **Rich Tier (Zoom ≥ 0.65):** Full visual reference cards with 640×400 preview art, source domain badges, sticky notes, sub-page dropdowns, and micro-actions.

### 3. Moodboard Tidy Solver (`moodboard.ts`)
Users can hit `Tidy Grid` to instantly snap an organic, scattered cluster into a clean editorial contact sheet:
- Preserves all directed relationship edges.
- Pinned anchors stay locked in space.
- Unpinned nodes snap into a golden-ratio aspect grid ordered by recency and domain similarity.

---

## 4. Anti-Slop Visual Design System

The UI rejects typical AI and modern software design tropes (no purple gradients, no glowing neon borders, no uppercase debug chips).

- **Matte Graphite Canvas:** `#0B0B0D` canvas background, `#121215` chrome surfaces, `#18181C` cards.
- **Warm Paper Theme:** A dedicated warm cream/ink light theme (`#F4F1EA`) for high-contrast reading.
- **Silent State Grammar:**
  - Active live tabs: subtle 5px teal live dot.
  - Hibernated tabs: 0.58 opacity decay with full thumbnail preservation.
  - Ghost echoes: 0.55 frosted glass with dashed hairline tether.
  - Edge illumination: Obsidian-style 1-hop hover illumination (hovering a node highlights only its direct neighbours; no marching ants).

---

## 5. Key Source Code Excerpts

### A. Graph Store LRU Pool & Ghost Matching (`app/src/store/useGraphStore.ts`)
```typescript
export const LIVE_POOL_LIMIT = 5
export const GHOST_ECHO_THRESHOLD = 0.78
export const GHOST_SCORE_WEIGHTS = { cosine: 0.55, coVisit: 0.30, recency: 0.15 } as const
export const CO_VISITATION_WINDOW_MS = 10_000
export const GHOST_MAX_SUGGESTIONS = 3

// Pool enforcement logic:
enforceLivePool: (activeUuid: NodeUuid) => {
  const { nodes } = get()
  const liveNodes = Object.values(nodes).filter(
    (n) => n.ramState === 'live' && n.uuid !== activeUuid
  )
  
  if (liveNodes.length < LIVE_POOL_LIMIT) return

  // Evict oldest unpinned, non-audible, non-recording tab
  const candidates = liveNodes
    .filter((n) => !n.isPinned && !n.isAudible && !n.isRecording)
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt)

  if (candidates.length > 0) {
    const victim = candidates[0]
    get().hibernateNode(victim.uuid)
  }
}
```

### B. Core Domain Model (`app/src/lib/types.ts`)
```typescript
export type RamState = 'live' | 'hibernated'
export type GraphNodeKind = 'tab' | 'hub' | 'ghost-echo'
export type GraphEdgeKind = 'spawn' | 'visit' | 'ghost'
export type SemanticZoomLevel = 'macro' | 'compact' | 'rich'

export type SpatialTabNodeData = {
  uuid: NodeUuid
  url: string
  title: string
  domain: string
  ramState: RamState
  zoomTier: SemanticZoomLevel
  previewArt: PreviewSpec
  notesCount: number
  hasVoiceMemo: boolean
  isPinned: boolean
  isAudible: boolean
  clusterId?: string
}
```

---

## 6. Project Roadmap

- **Phase 0 (Completed):** Monorepo setup, Blanc reference clone, line-ending protection.
- **Phase 1 & 1.5 (Completed & Audited):** Infinite canvas prototype in React 18 / Tailwind v4, 700-node stress test verified, dark & paper themes, Zen collapsible chrome.
- **Phase 2 (Next):** Rust spatial core (`crates/spatial-core`) for R-tree spatial indexing, hybrid force solver, and <2ms search scoring at 1,000+ nodes.
- **Phase 3:** Blanc Electron integration, mounting the canvas into `blanc-chrome://`, real `WebContentsView` warm pool, 640×400 WebP disk capture.
- **Phase 4:** Chrome extension runtime (`electron-chrome-extensions`).
- **Phase 5:** SQLite WAL persistence vault + local ONNX MiniLM vector search.
- **Phase 6:** Packaged release candidate (`.exe`).

---

## 7. Good Questions to Ask Gemini Web

1. **On Canvas Performance:** *"How does our Two-Mode Warm Pool compare to how Figma or Miro handles thousands of canvas nodes while keeping 60 fps pan/zoom?"*
2. **On Interaction Design:** *"How can we make link-branching on the canvas feel effortless without causing cognitive overload or spatial spaghetti as tab trees grow?"*
3. **On Local AI:** *"What are the trade-offs of running quantized all-MiniLM-L6-v2 in an Electron worker thread vs WebGPU for clustering 700 tabs?"*
