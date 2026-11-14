# Spatial Reference Browser

> A spatial graph desktop browser built for visual designers managing 600–700+ open reference tabs.

Tabs are interactive nodes on an infinite canvas. Sleeping tabs cost 0 MB of RAM while preserving their spatial position, thumbnail, and connection edges. Link clicks spawn connected child nodes, clustering is strictly suggest-only, and reference thumbnails own 100% of the interface color.

---

## Core Architecture & Mechanics

1. **Unified Storage Node & Silent Hibernation**
   - Active tabs hibernate to 0 MB via renderer sleep (`quietTab`/`wakeTab`), freeing ~148 MB per tab while preserving canvas position, thumbnail, and semantic relationships.
   - Reclaiming memory happens automatically; retrieval is search-first or spatial.

2. **Automatic Mind-Mapping (Branching)**
   - Clicking links (`Cmd/Ctrl + Click` or navigation branching) creates directed edges to child nodes on the canvas instead of losing context in a flat tab strip.

3. **Two-Mode Warm-Pool Architecture**
   - **Mode A (Reading View):** Active viewing with ≤6 live `WebContentsView` instances managed via an LRU pool. Oldest non-audible and unpinned views automatically sleep.
   - **Mode B (Canvas View):** High-speed 120 fps DOM canvas. Background views are hidden and represented by crisp `640x400` WebP thumbnails captured on navigation. Never attaches hundreds of live webviews to the zoomable canvas.

4. **Suggest-Only Semantic Clustering**
   - Local embeddings score ghost nodes and suggest groupings based on content similarity, co-visitation, and recency.
   - *Design Law: "The system pays, the user confirms."* The browser never auto-moves or rearranges pinned nodes without user confirmation.

5. **Anti-Slop Visual Design System**
   - Matte-graphite canvas (`#0B0B0D`), subtle dark chrome (`#121215`), and a warm-paper light theme.
   - Hairline borders (`1px rgba(255,255,255,0.07)`), silent 5px live status dots, and Obsidian-style 1-hop edge illumination on hover.
   - Zero glowing neon borders, zero uppercase debug badges, and no noisy animation loops.

---

## Technology Stack

- **Base:** Fork of [Blanc](https://github.com/thewh1teagle/blanc) v1.48.0 (MIT Electron browser, Chromium 156 via Electron 45.2.1 castLabs ECS build).
- **Spatial UI & Prototype:** Vite, React 18, TypeScript (strict), `@xyflow/react`, `d3-force`, Zustand, Framer Motion, Tailwind CSS v4.
- **Engine Core (Phase 2):** Rust (`crates/spatial-core`) for R-tree spatial culling, force-layout physics, and sub-2ms ghost node scoring at 1,000+ nodes.
- **Extension Layer (Phase 4):** `electron-chrome-extensions` + `session.extensions.loadExtension()` for Chrome Web Store extensions alongside Blanc's native Ghostery and uBlock Origin adblockers.
- **Persistence & Local AI (Phase 5):** `better-sqlite3` with Write-Ahead Logging (WAL), disk WebP thumbnail cache, rolling backups, and quantized `all-MiniLM-L6-v2` ONNX embeddings in a worker thread.

---

## Roadmap & Status

| Phase | Milestone | Status | Key Deliverables |
|---|---|---|---|
| **Phase 0** | Repo & Pristine Baseline | ✅ Completed | Monorepo initialized, line-ending protection for adblock rules, upstream Blanc reference preserved (`checkpoint/phase-1-prototype`). |
| **Phase 1** | Spatial Canvas Prototype | ✅ Completed | Functional infinite canvas, mock reader, node branching, notes, and 3-tier semantic LOD. |
| **Phase 1.5** | Anti-Slop Redesign | 🟡 Built & Audited | Zen × Blanc × Obsidian redesign, 700-node stress test verified, dark + paper modes. *(FPS benchmark via CDP pending).* |
| **Phase 2** | Rust Spatial Core | ⬜ Planned | `crates/spatial-core`: R-tree culling, force layout, <2ms search/ghost scorer. |
| **Phase 3** | Desktop Browser Integration | ⬜ Planned | Blanc fork in `browser/`, two-mode warm pool (6 live views), empty first run, real WebP capture. |
| **Phase 4** | Chrome Extensions | ⬜ Planned | MV2/MV3 unpacked and Web Store 1-click extension support. |
| **Phase 5** | 700-Tab Vault & Local AI | ⬜ Planned | SQLite WAL vault, 700-tab importer (born hibernated), local MiniLM embeddings. |
| **Phase 6** | Release Candidate | ⬜ Planned | Packaged standalone desktop app (`.exe`). |

---

## Project Structure

```text
├── HANDOFF.md              # Current execution handoff and session notes
├── ZCODE_MASTER_PROMPT.md  # Binding Master Execution Specification
├── app/                    # Phase 1 / 1.5 React + TypeScript prototype
│   ├── SPEC.md             # Interaction contracts and node specifications
│   ├── src/
│   │   ├── components/     # Canvas, nodes, chrome (ZenRail, BrowserTopBar, Island)
│   │   ├── store/          # useGraphStore (LRU pool, ghost scorer, moodboard)
│   │   └── lib/            # Types, seed data, layout algorithms
├── audits/                 # Live runtime and anti-slop visual audit logs
├── design/                 # Design direction specimens and tokens
└── research/               # Architecture analysis & Blanc v1.48.0 upstream source
```

---

## Running the Prototype

To run the Phase 1.5 prototype locally:

```bash
cd app
npm install
npm run dev
```

The prototype runs at **`http://127.0.0.1:5199/`** (pinned port).

### Key Canvas Controls
- **Canvas ⇄ Reading View:** `Cmd/Ctrl + Space` or `Alt + Space`
- **Command Palette:** `Cmd/Ctrl + L` (try `/seed-700`, `/canvas`, `/hibernate-all`)
- **Toggle Rail:** `Cmd/Ctrl + S`
- **Neighbourhood Glance:** `Shift + G`
- **Help & Shortcuts:** `Cmd/Ctrl + /`
